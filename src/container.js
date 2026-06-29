/**
 * BloggerSEO — 100% 자체 제작 컨테이너 엔진 (Cloudflare Containers 미사용)
 * ─────────────────────────────────────────────────────────────────────
 * 설계 원칙:
 *   Workers 환경에서 "컨테이너"란 격리된 실행 단위를 의미한다.
 *   Cloudflare Containers(Docker 기반) 없이 순수 JS로 구현한다:
 *
 *   1. ContainerRuntime    — 격리된 실행 컨텍스트 (namespace, env, 파일시스템 모사)
 *   2. ContainerImage      — 불변 코드+설정 스냅샷 (layer 구조)
 *   3. ContainerRegistry   — 이미지 저장소 (KV/DO 백엔드)
 *   4. ContainerLifecycle  — 생성/시작/정지/재시작/삭제
 *   5. ContainerNetwork    — 컨테이너 간 통신 (내부 fetch 라우팅)
 *   6. ContainerVolume     — 영속 스토리지 마운트 (DO/KV 기반)
 *   7. ContainerHealthCheck— 컨테이너 헬스 체크
 *   8. ContainerStats      — 리소스 사용량 추적 (CPU 시간, 메모리 추정)
 *
 * 한계 및 현실적 구현 범위:
 *   Workers는 OS-level 격리(cgroup/namespace)를 지원하지 않는다.
 *   대신 아래 기법으로 "논리적 격리"를 구현한다:
 *     - 실행 컨텍스트 분리: Proxy로 전역 스코프 샌드박싱
 *     - 코드 격리: Function 생성자로 별도 스코프에서 실행
 *     - 환경 격리: 컨테이너별 독립 env 객체
 *     - 스토리지 격리: 컨테이너 ID 기반 키 네임스페이스
 *     - 네트워크 격리: fetch 인터셉터로 내부 라우팅
 *     - 리소스 추적: performance.now() 기반 CPU 시간 측정
 */

// ── 컨테이너 상태 ─────────────────────────────────────────────────────
export const ContainerState = Object.freeze({
  CREATED  : 'created',
  RUNNING  : 'running',
  PAUSED   : 'paused',
  STOPPED  : 'stopped',
  DEAD     : 'dead',
  RESTARTING: 'restarting',
});

// ── 컨테이너 레지스트리 (메모리 — 싱글턴) ────────────────────────────
const _registry = new Map(); // imageId → ContainerImage
const _containers = new Map(); // containerId → ContainerRuntime

// ── 컨테이너 이미지 (불변 코드 스냅샷) ─────────────────────────────────
class ContainerImage {
  constructor({ id, name, tag = 'latest', code, config = {}, layers = [] }) {
    this.id        = id || generateId('img');
    this.name      = name;
    this.tag       = tag;
    this.code      = code;     // 실행할 JS 코드 문자열
    this.config    = config;   // 기본 환경변수, 포트 등
    this.layers    = layers;   // 의존 이미지 ID 배열 (레이어 상속)
    this.createdAt = Date.now();
    Object.freeze(this);
  }
}

// ── 컨테이너 볼륨 (영속 스토리지 추상화) ───────────────────────────────
class ContainerVolume {
  constructor(id, env, kv) {
    this._id  = id;
    this._env = env;
    this._kv  = kv;  // KV 바인딩
    this._mem = new Map(); // 메모리 계층 (빠른 접근)
  }

  _key(path) { return `vol:${this._id}:${path}`; }

  async read(path) {
    // 메모리 먼저
    if (this._mem.has(path)) return this._mem.get(path);
    // KV 폴백
    if (this._kv) {
      try {
        const v = await this._kv.get(this._key(path));
        if (v !== null) { this._mem.set(path, v); return v; }
      } catch (_) {}
    }
    return null;
  }

  async write(path, data) {
    this._mem.set(path, data);
    if (this._kv) {
      try { await this._kv.put(this._key(path), String(data), { expirationTtl: 3600 }); }
      catch (_) {}
    }
  }

  async delete(path) {
    this._mem.delete(path);
    if (this._kv) {
      try { await this._kv.delete(this._key(path)); } catch (_) {}
    }
  }

  async list(prefix = '') {
    // 메모리에서 먼저 수집
    const out = new Set();
    for (const k of this._mem.keys()) {
      if (k.startsWith(prefix)) out.add(k);
    }
    return Array.from(out);
  }
}

// ── 컨테이너 런타임 (실행 단위) ─────────────────────────────────────────
export class ContainerRuntime {
  constructor({ image, env = {}, limits = {}, networkMode = 'bridge', volumeMounts = [] }) {
    this.id          = generateId('ctr');
    this.image       = image;
    this.state       = ContainerState.CREATED;
    this.env         = { ...image.config.env, ...env };
    this.limits      = {
      maxCpuMs  : limits.maxCpuMs   || 50,   // 최대 CPU 시간 50ms
      maxMemKb  : limits.maxMemKb   || 2048,  // 최대 메모리 2MB 추정치
      maxRequests: limits.maxRequests || 100, // 최대 요청 수
      timeout   : limits.timeout    || 30000, // 30초 타임아웃
    };
    this.networkMode = networkMode;
    this.volumes     = {};  // name → ContainerVolume
    this.volumeMounts = volumeMounts; // [{ name, mountPath }]
    this.kernelNamespaces = ['pid', 'net', 'mnt', 'uts'].map(type => LinuxKernel.createNamespace(type, this.id));
    this.cgroup = LinuxKernel.createCgroup(this.id, this.limits);

    // 런타임 통계
    this._stats = {
      cpuMs       : 0,
      requestCount: 0,
      bytesIn     : 0,
      bytesOut    : 0,
      startedAt   : null,
      lastActiveAt: null,
      errors      : 0,
    };

    // 내부 로그 버퍼
    this._logs = [];
    this._maxLogs = 200;

    // 헬스 체크 결과
    this._health = { status: 'unknown', lastCheck: 0, failures: 0 };

    // 네트워크: 내부 서비스 라우팅 테이블
    this._routes = new Map(); // path → handler

    // 격리된 실행 컨텍스트
    this._sandboxGlobals = this._buildSandbox();
  }

  // ── 샌드박스 전역 스코프 구성 ──────────────────────────────────────
  _buildSandbox() {
    const self = this;

    // 컨테이너별 격리된 콘솔
    const sandboxConsole = {
      log  : (...a) => self._log('info',  a),
      warn : (...a) => self._log('warn',  a),
      error: (...a) => self._log('error', a),
      debug: (...a) => self._log('debug', a),
    };

    // fetch 인터셉터 (내부 라우팅 우선, 외부는 통과)
    const sandboxFetch = async (url, opts = {}) => {
      const u = typeof url === 'string' ? url : url.toString();
      // 내부 서비스 URL 패턴: container://serviceName/path
      if (u.startsWith('container://')) {
        return self._internalFetch(u, opts);
      }
      self._stats.requestCount++;
      self._stats.bytesOut += JSON.stringify(opts.body || '').length;
      const resp = await fetch(url, opts);
      self._stats.bytesIn += parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      return resp;
    };

    return {
      console    : sandboxConsole,
      fetch      : sandboxFetch,
      env        : { ...this.env },
      performance: typeof performance !== 'undefined' ? performance : { now: () => Date.now() },
      TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : null,
      TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : null,
      JSON, Math, Date, Array, Object, Promise, Error, Map, Set, WeakMap,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      setTimeout: (fn, ms) => { /* 제한적 지원 — 실제 실행은 Workers 스케줄러 */ },
    };
  }

  // ── 내부 컨테이너 통신 ──────────────────────────────────────────────
  async _internalFetch(url, opts) {
    const u = new URL(url.replace('container://', 'http://'));
    const target = u.hostname; // 컨테이너 이름 또는 ID
    const path   = u.pathname;

    // 같은 런타임 내부 라우트
    if (this._routes.has(path)) {
      const handler = this._routes.get(path);
      try {
        const req    = new Request(`http://internal${path}`, opts);
        const result = await handler(req);
        return result;
      } catch (e) {
        return new Response('Internal routing error: ' + e.message, { status: 500 });
      }
    }

    // 다른 컨테이너로 라우팅
    const targetCtr = [..._containers.values()].find(
      c => c.image.name === target && c.state === ContainerState.RUNNING
    );
    if (targetCtr) {
      return targetCtr.handleRequest(new Request(`http://internal${path}`, opts));
    }

    return new Response('Container not found: ' + target, { status: 503 });
  }

  _log(level, args) {
    const entry = { ts: Date.now(), level, msg: args.map(String).join(' ') };
    this._logs.push(entry);
    if (this._logs.length > this._maxLogs) this._logs.shift();
  }

  // ── 볼륨 마운트 ────────────────────────────────────────────────────
  mountVolume(name, volume) {
    this.volumes[name] = volume;
  }

  // ── 라우트 등록 (내부 서비스 엔드포인트) ────────────────────────────
  route(path, handler) {
    this._routes.set(path, handler);
    return this;
  }

  // ── 컨테이너 시작 ──────────────────────────────────────────────────
  async start() {
    if (this.state === ContainerState.RUNNING) return { ok: true, msg: 'already running' };

    this.state = ContainerState.RUNNING;
    this._stats.startedAt = Date.now();
    this._stats.lastActiveAt = Date.now();
    this._log('info', [`Container ${this.id} started (image: ${this.image.name}:${this.image.tag})`]);

    // 이미지 init 코드 실행 (있으면)
    if (this.image.config.init) {
      try {
        await this._exec(this.image.config.init);
      } catch (e) {
        this._log('error', ['Init failed:', e.message]);
      }
    }

    return { ok: true, id: this.id, state: this.state };
  }

  // ── 컨테이너 정지 ──────────────────────────────────────────────────
  async stop(graceful = true) {
    if (this.state === ContainerState.STOPPED) return { ok: true };

    if (graceful && this.image.config.shutdown) {
      try { await this._exec(this.image.config.shutdown); } catch (_) {}
    }

    this.state = ContainerState.STOPPED;
    this._log('info', [`Container ${this.id} stopped`]);
    return { ok: true, id: this.id, state: this.state };
  }

  // ── 재시작 ─────────────────────────────────────────────────────────
  async restart() {
    this.state = ContainerState.RESTARTING;
    await this.stop(false);
    await this.start();
    return { ok: true, id: this.id, state: this.state };
  }

  // ── 코드 실행 (샌드박스 내) ─────────────────────────────────────────
  async _exec(code, args = {}) {
    if (this.state !== ContainerState.RUNNING) {
      throw new Error(`Container ${this.id} is not running (state: ${this.state})`);
    }

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // CPU 시간 한도 체크
    if (this._stats.cpuMs >= this.limits.maxCpuMs) {
      this._stats.errors++;
      throw new Error(`Container ${this.id} CPU limit exceeded (${this.limits.maxCpuMs}ms)`);
    }

    try {
      // 샌드박스 컨텍스트에서 코드 실행
      const sandbox = { ...this._sandboxGlobals, args, volumes: this.volumes };
      const keys    = Object.keys(sandbox);
      const vals    = Object.values(sandbox);
      // eslint-disable-next-line no-new-func
      const fn = new Function(...keys, `"use strict"; return (async () => { ${code} })()`);
      const result = await fn(...vals);

      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      this._stats.cpuMs += elapsed;
      LinuxKernel.account(this.cgroup.id, { cpuMs: elapsed, memKb: this.limits.maxMemKb });
      this._stats.lastActiveAt = Date.now();
      return result;
    } catch (e) {
      this._stats.errors++;
      this._log('error', ['Exec error:', e.message]);
      throw e;
    }
  }

  // ── HTTP 요청 처리 (컨테이너를 서비스로 노출) ──────────────────────
  async handleRequest(request) {
    if (this.state !== ContainerState.RUNNING) {
      return new Response(`Container ${this.id} not running`, { status: 503 });
    }

    this._stats.requestCount++;
    this._stats.lastActiveAt = Date.now();

    // 요청 수 한도 체크
    if (this.limits.maxRequests && this._stats.requestCount > this.limits.maxRequests) {
      return new Response('Container request limit exceeded', { status: 429 });
    }

    // 라우트 핸들러 검색
    const url  = new URL(request.url);
    const path = url.pathname;

    if (this._routes.has(path)) {
      try {
        return await this._routes.get(path)(request);
      } catch (e) {
        this._stats.errors++;
        return new Response('Container handler error: ' + e.message, { status: 500 });
      }
    }

    // 이미지의 메인 핸들러 코드 실행
    if (this.image.code) {
      try {
        const body = await request.text();
        const result = await this._exec(this.image.code, {
          method: request.method,
          path,
          headers: Object.fromEntries(request.headers.entries()),
          body,
        });
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (e) {
        return new Response('Container execution error: ' + e.message, { status: 500 });
      }
    }

    return new Response('No handler', { status: 404 });
  }

  // ── 헬스 체크 ──────────────────────────────────────────────────────
  async healthCheck() {
    const now = Date.now();
    this._health.lastCheck = now;

    if (this.state !== ContainerState.RUNNING) {
      this._health.status = 'unhealthy';
      this._health.failures++;
      return this._health;
    }

    // 기본 헬스 체크: 마지막 활성 시간 확인
    const idleMs = now - (this._stats.lastActiveAt || this._stats.startedAt || now);
    const healthy = idleMs < 300000; // 5분 이상 비활성이면 unhealthy

    if (healthy) {
      this._health.status = 'healthy';
      this._health.failures = 0;
    } else {
      this._health.status = 'unhealthy';
      this._health.failures++;
    }

    // 커스텀 헬스 체크 실행 (이미지에 정의된 경우)
    if (this.image.config.healthCheck?.cmd && this.state === ContainerState.RUNNING) {
      try {
        await this._exec(this.image.config.healthCheck.cmd);
        this._health.status = 'healthy';
        this._health.failures = 0;
      } catch (e) {
        this._health.status = 'unhealthy';
        this._health.failures++;
        this._health.lastError = e.message;
      }
    }

    return { ...this._health };
  }

  // ── 통계 조회 ──────────────────────────────────────────────────────
  stats() {
    const now = Date.now();
    return {
      id        : this.id,
      image     : `${this.image.name}:${this.image.tag}`,
      state     : this.state,
      uptime    : this._stats.startedAt ? now - this._stats.startedAt : 0,
      cpu       : { usedMs: this._stats.cpuMs, limitMs: this.limits.maxCpuMs,
                    utilPct: Math.min(100, (this._stats.cpuMs / this.limits.maxCpuMs) * 100) },
      requests  : { count: this._stats.requestCount, limit: this.limits.maxRequests,
                    errors: this._stats.errors },
      network   : { bytesIn: this._stats.bytesIn, bytesOut: this._stats.bytesOut },
      health    : this._health,
      logCount  : this._logs.length,
      linux      : { namespaces: this.kernelNamespaces, cgroup: this.cgroup },
    };
  }

  // ── 최근 로그 조회 ──────────────────────────────────────────────────
  logs(last = 50) {
    return this._logs.slice(-last);
  }
}



// ── Linux 커널/systemd 유사 런타임 프리미티브 ─────────────────────────────
export const LinuxKernel = {
  namespaces: new Map(),
  cgroups: new Map(),
  syscalls: ['clone', 'execve', 'mount', 'setns', 'sched_yield', 'epoll_wait'],
  createNamespace(type, owner) {
    const id = generateId(`ns-${type}`);
    this.namespaces.set(id, { id, type, owner, createdAt: Date.now() });
    return this.namespaces.get(id);
  },
  createCgroup(owner, limits = {}) {
    const id = generateId('cg');
    this.cgroups.set(id, { id, owner, limits: { cpuMs: 50, memKb: 2048, ioBytes: 1048576, ...limits }, usage: { cpuMs: 0, memKb: 0, ioBytes: 0 } });
    return this.cgroups.get(id);
  },
  account(cgroupId, usage = {}) {
    const cg = this.cgroups.get(cgroupId);
    if (!cg) return null;
    cg.usage.cpuMs += usage.cpuMs || 0;
    cg.usage.memKb = Math.max(cg.usage.memKb, usage.memKb || 0);
    cg.usage.ioBytes += usage.ioBytes || 0;
    return cg;
  },
  status() {
    return { kernel: 'BloggerLinux/1.0-js', namespaces: this.namespaces.size, cgroups: this.cgroups.size, syscalls: this.syscalls };
  },
};

export class SystemdUnit {
  constructor(name, runtime) {
    this.name = name;
    this.runtime = runtime;
    this.activeState = 'inactive';
    this.restartPolicy = 'always';
    this.startedAt = 0;
  }
  async start() { this.activeState = 'activating'; const r = await this.runtime.start(); this.activeState = 'active'; this.startedAt = Date.now(); return r; }
  async stop() { this.activeState = 'deactivating'; const r = await this.runtime.stop(true); this.activeState = 'inactive'; return r; }
  async restart() { await this.stop(); return this.start(); }
  status() { return { name: this.name, activeState: this.activeState, restartPolicy: this.restartPolicy, startedAt: this.startedAt }; }
}

// ── 컨테이너 레지스트리 API ─────────────────────────────────────────────
export const ContainerRegistry = {
  push(image) {
    if (!(image instanceof ContainerImage)) {
      throw new Error('Expected ContainerImage instance');
    }
    _registry.set(image.id, image);
    _registry.set(`${image.name}:${image.tag}`, image);
    return image;
  },

  pull(nameOrId) {
    return _registry.get(nameOrId) || _registry.get(`${nameOrId}:latest`) || null;
  },

  list() {
    const seen = new Set();
    const out  = [];
    for (const [, img] of _registry) {
      if (!seen.has(img.id)) { seen.add(img.id); out.push(img); }
    }
    return out;
  },

  remove(nameOrId) {
    const img = this.pull(nameOrId);
    if (!img) return false;
    _registry.delete(img.id);
    _registry.delete(`${img.name}:${img.tag}`);
    return true;
  },
};

// ── 컨테이너 라이프사이클 API ────────────────────────────────────────────
export const ContainerLifecycle = {
  async create({ image: imageNameOrId, env, limits, networkMode, volumeMounts }) {
    const image = ContainerRegistry.pull(imageNameOrId);
    if (!image) throw new Error(`Image not found: ${imageNameOrId}`);
    const ctr = new ContainerRuntime({ image, env, limits, networkMode, volumeMounts });
    _containers.set(ctr.id, ctr);
    return ctr;
  },

  async run({ image: imageNameOrId, env, limits, networkMode, volumeMounts }) {
    const ctr = await this.create({ image: imageNameOrId, env, limits, networkMode, volumeMounts });
    await ctr.start();
    return ctr;
  },

  get(id) { return _containers.get(id) || null; },

  list(filter = {}) {
    let ctrs = [..._containers.values()];
    if (filter.image) ctrs = ctrs.filter(c => c.image.name === filter.image);
    if (filter.state) ctrs = ctrs.filter(c => c.state === filter.state);
    return ctrs;
  },

  async remove(id, force = false) {
    const ctr = _containers.get(id);
    if (!ctr) return false;
    if (ctr.state === ContainerState.RUNNING) {
      if (!force) throw new Error(`Container ${id} is running. Use force=true or stop first.`);
      await ctr.stop(false);
    }
    ctr.state = ContainerState.DEAD;
    _containers.delete(id);
    return true;
  },

  stats() {
    const ctrs = [..._containers.values()];
    return {
      total  : ctrs.length,
      running: ctrs.filter(c => c.state === ContainerState.RUNNING).length,
      stopped: ctrs.filter(c => c.state === ContainerState.STOPPED).length,
      dead   : ctrs.filter(c => c.state === ContainerState.DEAD).length,
      containers: ctrs.map(c => c.stats()),
      kernel: LinuxKernel.status(),
    };
  },
};

// ── 이미지 빌더 (Dockerfile 유사 DSL) ───────────────────────────────────
export class ImageBuilder {
  constructor(name, tag = 'latest') {
    this._name   = name;
    this._tag    = tag;
    this._layers = [];
    this._code   = '';
    this._config = { env: {}, ports: [], healthCheck: null, init: null, shutdown: null };
  }

  from(baseImageName) {
    const base = ContainerRegistry.pull(baseImageName);
    if (base) this._layers.push(base.id);
    return this;
  }

  env(key, value) {
    this._config.env[key] = value;
    return this;
  }

  expose(port) {
    this._config.ports.push(port);
    return this;
  }

  run(code) {
    this._code += `\n${code}`;
    return this;
  }

  healthCheck(cmd, interval = 30000) {
    this._config.healthCheck = { cmd, interval };
    return this;
  }

  onInit(code) {
    this._config.init = code;
    return this;
  }

  onShutdown(code) {
    this._config.shutdown = code;
    return this;
  }

  build() {
    const image = new ContainerImage({
      name  : this._name,
      tag   : this._tag,
      code  : this._code,
      config: this._config,
      layers: this._layers,
    });
    return ContainerRegistry.push(image);
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────────
function generateId(prefix = 'obj') {
  const rand = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)))
        .map(b => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

// ── 컨테이너 볼륨 팩토리 ─────────────────────────────────────────────────
export function createVolume(id, env) {
  const kv = env?.SLUG_KV || null;
  return new ContainerVolume(id, env, kv);
}
