/**
 * BloggerSEO — 100% 자체 제작 쿠버네티스 오케스트레이션 엔진
 * ─────────────────────────────────────────────────────────────────────
 * Cloudflare 공식 Kubernetes 서비스 미사용 — 순수 Workers JS로 구현
 *
 * 구현 컴포넌트:
 *   Scheduler       — 컨테이너 스케줄링 (Bin-Packing, Round-Robin, Least-Loaded)
 *   Deployment      — 원하는 상태(desired state) 기반 컨테이너 배포
 *   ReplicaSet      — 레플리카 수 유지 (자동 재시작, 헬스 체크 연동)
 *   Service         — 컨테이너 그룹에 대한 가상 IP/포트 추상화
 *   ConfigMap       — 설정 데이터 저장/주입
 *   HPA             — 수평적 Pod 오토스케일러 (요청 수 기반)
 *   Reconciler      — 현재 상태 → 원하는 상태 조정 루프
 *   EventBus        — 클러스터 이벤트 스트림 (로그/감사)
 *   ResourceQuota   — 네임스페이스별 자원 할당량 관리
 *   RollingUpdate   — 무중단 롤링 업데이트
 */

import {
  ContainerLifecycle, ContainerRegistry, ContainerState, ImageBuilder, createVolume,
} from './container.js';

// ── 클러스터 전역 상태 ─────────────────────────────────────────────────
const _cluster = {
  namespaces : new Map(), // ns → Namespace
  deployments: new Map(), // name → Deployment
  services   : new Map(), // name → Service
  configMaps : new Map(), // name → ConfigMap
  events     : [],        // EventBus 버퍼
  maxEvents  : 500,
};

// ── 이벤트 버스 ─────────────────────────────────────────────────────────
export const EventBus = {
  emit(type, payload = {}) {
    const ev = { ts: Date.now(), type, ...payload };
    _cluster.events.push(ev);
    if (_cluster.events.length > _cluster.maxEvents) _cluster.events.shift();
    return ev;
  },
  recent(n = 50, filter = null) {
    let evs = _cluster.events.slice(-n);
    if (filter) evs = evs.filter(e => e.type === filter || e.namespace === filter);
    return evs;
  },
};

// ── 네임스페이스 ─────────────────────────────────────────────────────────
export class Namespace {
  constructor(name, quota = {}) {
    this.name  = name;
    this.quota = {
      maxContainers: quota.maxContainers || 10,
      maxCpuMs     : quota.maxCpuMs     || 5000,
      maxMemKb     : quota.maxMemKb     || 20480,
    };
    this._containers = new Set();
    _cluster.namespaces.set(name, this);
  }

  addContainer(id)    { this._containers.add(id); }
  removeContainer(id) { this._containers.delete(id); }

  usage() {
    const ctrs = [...this._containers]
      .map(id => ContainerLifecycle.get(id))
      .filter(Boolean);
    return {
      containers: ctrs.length,
      cpuMs     : ctrs.reduce((s, c) => s + c.stats().cpu.usedMs, 0),
      memKb     : ctrs.length * 256, // 추정 (Workers 실제 메모리 격리 없음)
    };
  }

  withinQuota() {
    const u = this.usage();
    return u.containers < this.quota.maxContainers &&
           u.cpuMs      < this.quota.maxCpuMs &&
           u.memKb      < this.quota.maxMemKb;
  }
}

// ── ConfigMap ────────────────────────────────────────────────────────────
export class ConfigMap {
  constructor(name, namespace = 'default', data = {}) {
    this.name      = name;
    this.namespace = namespace;
    this.data      = { ...data };
    _cluster.configMaps.set(`${namespace}/${name}`, this);
  }

  get(key)         { return this.data[key] || null; }
  set(key, value)  { this.data[key] = value; }
  toEnv()          { return { ...this.data }; } // 컨테이너 env로 주입
}

// ── 스케줄러 (컨테이너 배치 알고리즘) ───────────────────────────────────
export const Scheduler = {
  // Round-Robin 스케줄링
  roundRobin(candidates) {
    if (!candidates.length) return null;
    const idx = (Scheduler._rrIdx++ || 0) % candidates.length;
    Scheduler._rrIdx = idx + 1;
    return candidates[idx];
  },
  _rrIdx: 0,

  // Least-Loaded 스케줄링 (요청 수 기준)
  leastLoaded(candidates) {
    if (!candidates.length) return null;
    return candidates.reduce((best, ctr) => {
      const load = ctr.stats().requests.count;
      return (!best || load < best.stats().requests.count) ? ctr : best;
    }, null);
  },

  // Bin-Packing (CPU 여유 기준 최적 배치)
  binPacking(candidates) {
    if (!candidates.length) return null;
    return candidates.reduce((best, ctr) => {
      const s    = ctr.stats();
      const free = s.cpu.limitMs - s.cpu.usedMs;
      return (!best || free < best._free) ? { ctr, _free: free } : best;
    }, null)?.ctr || candidates[0];
  },

  // 기본: Least-Loaded
  schedule(candidates, strategy = 'least-loaded') {
    const running = candidates.filter(c => c.state === ContainerState.RUNNING);
    if (!running.length) return null;
    if (strategy === 'round-robin')  return this.roundRobin(running);
    if (strategy === 'bin-packing')  return this.binPacking(running);
    return this.leastLoaded(running); // default
  },
};

// ── ReplicaSet ────────────────────────────────────────────────────────────
export class ReplicaSet {
  constructor({ name, namespace = 'default', image, replicas = 1, env = {}, limits = {}, strategy = 'least-loaded' }) {
    this.name      = name;
    this.namespace = namespace;
    this.image     = image;
    this.replicas  = replicas;
    this.env       = env;
    this.limits    = limits;
    this.strategy  = strategy;
    this._pods     = new Set(); // container IDs

    this._ns = _cluster.namespaces.get(namespace) || new Namespace(namespace);
  }

  // 현재 실행 중인 Pod 수
  get runningCount() {
    return [...this._pods]
      .map(id => ContainerLifecycle.get(id))
      .filter(c => c && c.state === ContainerState.RUNNING)
      .length;
  }

  // 전체 Pod 목록
  get pods() {
    return [...this._pods]
      .map(id => ContainerLifecycle.get(id))
      .filter(Boolean);
  }

  // Pod 스케줄링 (요청 라우팅)
  schedule() {
    return Scheduler.schedule(this.pods, this.strategy);
  }

  // Reconcile: 원하는 레플리카 수 유지
  async reconcile() {
    const running = this.runningCount;
    const delta   = this.replicas - running;

    if (delta > 0) {
      // 부족 → 새 Pod 생성
      for (let i = 0; i < delta; i++) {
        if (!this._ns.withinQuota()) {
          EventBus.emit('quota-exceeded', { replicaSet: this.name, namespace: this.namespace });
          break;
        }
        try {
          const ctr = await ContainerLifecycle.run({
            image: this.image, env: this.env, limits: this.limits,
          });
          this._pods.add(ctr.id);
          this._ns.addContainer(ctr.id);
          EventBus.emit('pod-created', { replicaSet: this.name, podId: ctr.id, namespace: this.namespace });
        } catch (e) {
          EventBus.emit('pod-create-failed', { replicaSet: this.name, error: e.message });
        }
      }
    } else if (delta < 0) {
      // 초과 → 오래된 Pod 삭제
      const toRemove = this.pods
        .filter(c => c.state !== ContainerState.RUNNING)
        .slice(0, -delta);
      for (const ctr of toRemove) {
        await ContainerLifecycle.remove(ctr.id, true);
        this._pods.delete(ctr.id);
        this._ns.removeContainer(ctr.id);
        EventBus.emit('pod-deleted', { replicaSet: this.name, podId: ctr.id });
      }
      // 그래도 초과면 강제 종료
      if (this.runningCount > this.replicas) {
        const extras = this.pods.slice(this.replicas);
        for (const ctr of extras) {
          await ctr.stop();
          EventBus.emit('pod-stopped', { replicaSet: this.name, podId: ctr.id });
        }
      }
    }

    // 헬스 체크 후 unhealthy Pod 재시작
    for (const ctr of this.pods) {
      const health = await ctr.healthCheck();
      if (health.status === 'unhealthy' && health.failures >= 3) {
        EventBus.emit('pod-restart', { replicaSet: this.name, podId: ctr.id, reason: 'health-check-failed' });
        await ctr.restart();
      }
    }
  }

  stats() {
    return {
      name     : this.name,
      namespace: this.namespace,
      desired  : this.replicas,
      running  : this.runningCount,
      pods     : this.pods.map(c => c.stats()),
    };
  }
}

// ── Service (가상 서비스 엔드포인트) ─────────────────────────────────────
export class Service {
  constructor({ name, namespace = 'default', selector, port = 80, type = 'ClusterIP' }) {
    this.name      = name;
    this.namespace = namespace;
    this.selector  = selector; // ReplicaSet name
    this.port      = port;
    this.type      = type; // ClusterIP | NodePort | LoadBalancer
    _cluster.services.set(`${namespace}/${name}`, this);
  }

  _getReplicaSet() {
    // Deployment 검색
    for (const [, dep] of _cluster.deployments) {
      if (dep.name === this.selector || dep.replicaSet?.name === this.selector) {
        return dep.replicaSet;
      }
    }
    return null;
  }

  // 요청 라우팅 (로드밸런싱)
  async forward(request) {
    const rs  = this._getReplicaSet();
    if (!rs) return new Response(`Service ${this.name}: no endpoints`, { status: 503 });

    const pod = rs.schedule();
    if (!pod) return new Response(`Service ${this.name}: no running pods`, { status: 503 });

    EventBus.emit('service-request', { service: this.name, pod: pod.id });
    return pod.handleRequest(request);
  }

  info() {
    const rs = this._getReplicaSet();
    return {
      name      : this.name,
      namespace : this.namespace,
      type      : this.type,
      port      : this.port,
      endpoints : rs ? rs.runningCount : 0,
      selector  : this.selector,
    };
  }
}

// ── HPA (Horizontal Pod Autoscaler) ─────────────────────────────────────
export class HPA {
  constructor({ name, target, minReplicas = 1, maxReplicas = 5, targetRequestsPerPod = 50 }) {
    this.name                 = name;
    this.target               = target; // ReplicaSet 참조
    this.minReplicas          = minReplicas;
    this.maxReplicas          = maxReplicas;
    this.targetRequestsPerPod = targetRequestsPerPod;
    this._lastScale           = 0;
    this._cooldownMs          = 60000; // 1분 쿨다운
  }

  async evaluate() {
    const rs      = this.target;
    const now     = Date.now();
    if (now - this._lastScale < this._cooldownMs) return; // 쿨다운 중

    const pods    = rs.pods;
    if (!pods.length) return;

    const totalReqs = pods.reduce((s, p) => s + p.stats().requests.count, 0);
    const avgReqs   = totalReqs / pods.length;

    let desired = Math.ceil(totalReqs / this.targetRequestsPerPod);
    desired = Math.max(this.minReplicas, Math.min(this.maxReplicas, desired));

    if (desired !== rs.replicas) {
      const dir = desired > rs.replicas ? 'scale-up' : 'scale-down';
      EventBus.emit('hpa-scale', { hpa: this.name, from: rs.replicas, to: desired, avgReqs, dir });
      rs.replicas = desired;
      this._lastScale = now;
      await rs.reconcile();
    }
  }
}

// ── Deployment (선언적 배포) ─────────────────────────────────────────────
export class Deployment {
  constructor({ name, namespace = 'default', image, replicas = 1,
                env = {}, limits = {}, strategy = 'RollingUpdate',
                schedulerStrategy = 'least-loaded' }) {
    this.name      = name;
    this.namespace = namespace;
    this.image     = image;
    this.replicas  = replicas;
    this.env       = env;
    this.limits    = limits;
    this.strategy  = strategy; // RollingUpdate | Recreate

    this.replicaSet = new ReplicaSet({
      name: `${name}-rs`, namespace, image, replicas, env, limits,
      strategy: schedulerStrategy,
    });

    this._revision = 1;
    this._paused   = false;
    this._hpa      = null;

    _cluster.deployments.set(`${namespace}/${name}`, this);
    EventBus.emit('deployment-created', { deployment: name, namespace, replicas });
  }

  // 스케일 (레플리카 수 조정)
  async scale(n) {
    const old = this.replicaSet.replicas;
    this.replicaSet.replicas = Math.max(0, n);
    EventBus.emit('deployment-scaled', { deployment: this.name, from: old, to: n });
    await this.reconcile();
  }

  // 롤링 업데이트 (무중단)
  async rollout(newImage, maxSurge = 1, maxUnavailable = 0) {
    if (this._paused) throw new Error(`Deployment ${this.name} is paused`);

    EventBus.emit('rollout-started', { deployment: this.name, image: newImage });
    const oldPods = [...this.replicaSet.pods];
    this._revision++;

    if (this.strategy === 'Recreate') {
      // 전체 중단 후 재시작
      for (const pod of oldPods) await pod.stop();
      this.replicaSet.image = newImage;
      await this.reconcile();
    } else {
      // RollingUpdate: 새 Pod 하나 추가 → 이전 Pod 하나 제거 반복
      this.replicaSet.image = newImage;
      const target = this.replicaSet.replicas;

      for (let i = 0; i < target; i++) {
        // surge: 임시로 하나 더
        this.replicaSet.replicas = target + maxSurge;
        await this.reconcile();

        // 이전 버전 Pod 하나 제거
        const oldPod = oldPods[i];
        if (oldPod) {
          await ContainerLifecycle.remove(oldPod.id, true);
          this.replicaSet._pods.delete(oldPod.id);
        }

        // 원래 수로 복귀
        this.replicaSet.replicas = target;
        await this.reconcile();

        EventBus.emit('rollout-progress', {
          deployment: this.name, step: i + 1, total: target, revision: this._revision,
        });
      }
    }

    EventBus.emit('rollout-complete', { deployment: this.name, revision: this._revision });
  }

  // 일시 정지 / 재개
  pause()  { this._paused = true;  EventBus.emit('deployment-paused',  { deployment: this.name }); }
  resume() { this._paused = false; EventBus.emit('deployment-resumed', { deployment: this.name }); }

  // HPA 연결
  attachHpa(config) {
    this._hpa = new HPA({ ...config, target: this.replicaSet });
    return this._hpa;
  }

  // Reconcile 루프 실행
  async reconcile() {
    if (this._paused) return;
    await this.replicaSet.reconcile();
    if (this._hpa) await this._hpa.evaluate();
  }

  status() {
    const rs = this.replicaSet;
    return {
      name       : this.name,
      namespace  : this.namespace,
      revision   : this._revision,
      paused     : this._paused,
      desired    : rs.replicas,
      ready      : rs.runningCount,
      available  : rs.pods.filter(p => p._health?.status !== 'unhealthy').length,
      strategy   : this.strategy,
      image      : this.image,
    };
  }
}

// ── 클러스터 컨트롤 플레인 (kubectl 유사 API) ────────────────────────────
export const Cluster = {
  // 클러스터 전체 상태
  status() {
    const deployments = [..._cluster.deployments.values()].map(d => d.status());
    const services    = [..._cluster.services.values()].map(s => s.info());
    const ns          = [..._cluster.namespaces.values()].map(n => ({ name: n.name, usage: n.usage(), quota: n.quota }));
    const containers  = ContainerLifecycle.stats();

    return {
      version    : 'BloggerSEO-K8s/v1',
      timestamp  : new Date().toISOString(),
      namespaces : ns,
      deployments,
      services,
      containers,
      events     : EventBus.recent(20),
    };
  },

  // 네임스페이스 생성
  createNamespace(name, quota = {}) {
    return new Namespace(name, quota);
  },

  // Deployment 생성
  createDeployment(spec) {
    return new Deployment(spec);
  },

  // Service 생성
  createService(spec) {
    return new Service(spec);
  },

  // ConfigMap 생성
  createConfigMap(name, namespace, data) {
    return new ConfigMap(name, namespace, data);
  },

  // 전체 Reconcile (컨트롤 루프 1회)
  async reconcileAll() {
    const results = [];
    for (const [, dep] of _cluster.deployments) {
      try {
        await dep.reconcile();
        results.push({ deployment: dep.name, ok: true });
      } catch (e) {
        results.push({ deployment: dep.name, ok: false, error: e.message });
        EventBus.emit('reconcile-error', { deployment: dep.name, error: e.message });
      }
    }
    return results;
  },

  // Kubectl-like apply (선언적 설정 적용)
  async apply(manifest) {
    const { kind, metadata = {}, spec = {} } = manifest;
    const ns   = metadata.namespace || 'default';
    const name = metadata.name;

    if (!name) throw new Error('metadata.name is required');

    switch (kind) {
      case 'Namespace':
        return this.createNamespace(name, spec.quota || {});

      case 'ConfigMap':
        return this.createConfigMap(name, ns, spec.data || {});

      case 'Deployment': {
        const key = `${ns}/${name}`;
        if (_cluster.deployments.has(key)) {
          const dep = _cluster.deployments.get(key);
          if (spec.replicas !== undefined && spec.replicas !== dep.replicas) {
            await dep.scale(spec.replicas);
          }
          if (spec.image && spec.image !== dep.image) {
            await dep.rollout(spec.image);
          }
          return dep;
        }
        return this.createDeployment({ name, namespace: ns, ...spec });
      }

      case 'Service':
        return this.createService({ name, namespace: ns, ...spec });

      default:
        throw new Error(`Unknown resource kind: ${kind}`);
    }
  },

  // 리소스 삭제
  async delete(kind, name, namespace = 'default') {
    const key = `${namespace}/${name}`;
    switch (kind) {
      case 'Deployment': {
        const dep = _cluster.deployments.get(key);
        if (!dep) return false;
        await dep.replicaSet.reconcile(); // 0으로 스케일
        dep.replicaSet.replicas = 0;
        await dep.replicaSet.reconcile();
        _cluster.deployments.delete(key);
        EventBus.emit('deployment-deleted', { name, namespace });
        return true;
      }
      case 'Service':
        return _cluster.services.delete(key);
      case 'ConfigMap':
        return _cluster.configMaps.delete(key);
      case 'Namespace':
        return _cluster.namespaces.delete(name);
      default:
        return false;
    }
  },

  // 이벤트 스트림
  events(n = 50, filter = null) {
    return EventBus.recent(n, filter);
  },
};

// ── 자체 이미지 빌더 export ───────────────────────────────────────────────
export { ImageBuilder, ContainerRegistry, ContainerLifecycle, ContainerState, createVolume };
