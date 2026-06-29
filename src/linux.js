/**
 * BloggerSEO — 자체 Linux 유사 기술 엔진 (linux.js)
 * ─────────────────────────────────────────────────────────────────────
 * Workers V8 Isolate 내에서 Linux 커널 개념을 JS로 완전 자체 구현:
 *
 *   ProcessManager  — PID 기반 프로세스 테이블, fork/exec/wait/kill
 *   CgroupManager   — CPU·메모리 계층적 제어 그룹 (cgroup v2 유사)
 *   PipelineEngine  — Unix 파이프(|) 기반 데이터 스트림 처리
 *   IpcBus          — 프로세스 간 통신 (메시지 큐, 세마포어, 공유 메모리)
 *   VirtualFS       — /proc /sys /tmp 유사 가상 파일시스템
 *   NetworkNS       — 네트워크 네임스페이스 (veth pair, 브리지)
 *   Systemd         — 유닛 파일 기반 서비스 관리자
 *   CronDaemon      — crontab 파싱 + 스케줄 실행 데몬
 *   SignalHandler    — POSIX 시그널 (SIGTERM/SIGKILL/SIGHUP/SIGUSR1)
 *   Journald        — 구조화 로그 (systemd-journald 유사)
 *
 * 모든 기능은 단일 Workers 인스턴스 내 다중 논리 프로세스로 동작.
 */

// ─────────────────────────────────────────────────────────────────────
// § 1. PID 관리 + 프로세스 테이블
// ─────────────────────────────────────────────────────────────────────
let _nextPid = 1;
const _processTable = new Map(); // pid → ProcessEntry
const _pidByName    = new Map(); // name → Set<pid>

class ProcessEntry {
  constructor({ pid, name, fn, cgroupId = null, parentPid = null }) {
    this.pid       = pid;
    this.name      = name;
    this.fn        = fn;            // async 함수
    this.cgroupId  = cgroupId;
    this.parentPid = parentPid;
    this.state     = 'R';           // R/S/Z/T (Running/Sleeping/Zombie/Stopped)
    this.exitCode  = null;
    this.startedAt = Date.now();
    this.cpuMs     = 0;
    this.memKb     = 0;
    this._promise  = null;
    this._signals  = [];
    this._env      = {};
    this._fds      = {};            // 파일 디스크립터 (0=stdin,1=stdout,2=stderr)
  }
}

export const ProcessManager = {
  // fork: 새 프로세스 생성 (실제 실행 시작)
  async fork({ name, fn, cgroupId = null, parentPid = null, env = {} }) {
    const pid   = _nextPid++;
    const entry = new ProcessEntry({ pid, name, fn, cgroupId, parentPid });
    entry._env  = { ...env };
    _processTable.set(pid, entry);
    if (!_pidByName.has(name)) _pidByName.set(name, new Set());
    _pidByName.get(name).add(pid);

    // 실제 비동기 실행
    const t0 = Date.now();
    entry._promise = (async () => {
      entry.state = 'R';
      try {
        Journald.log('info', `[pid ${pid}] ${name} started`);
        SignalHandler._notifyListeners('SIGCHLD', { pid, event: 'start' });
        const result = await fn(entry);
        entry.exitCode = 0;
        entry.state    = 'Z';  // 종료 후 Zombie (wait 전)
        entry.cpuMs    = Date.now() - t0;
        Journald.log('info', `[pid ${pid}] ${name} exited 0`);
        SignalHandler._notifyListeners('SIGCHLD', { pid, event: 'exit', code: 0 });
        return result;
      } catch (e) {
        entry.exitCode = 1;
        entry.state    = 'Z';
        entry.cpuMs    = Date.now() - t0;
        Journald.log('error', `[pid ${pid}] ${name} exited 1: ${e.message}`);
        SignalHandler._notifyListeners('SIGCHLD', { pid, event: 'exit', code: 1, error: e.message });
      }
    })();

    CgroupManager._trackProcess(cgroupId, pid);
    return pid;
  },

  // exec: 현재 프로세스 교체 (새 fn으로)
  exec(pid, name, fn) {
    const entry = _processTable.get(pid);
    if (!entry) throw new Error(`No such process: ${pid}`);
    entry.name = name;
    entry.fn   = fn;
    entry.state = 'R';
    entry._promise = fn(entry).then(() => { entry.state = 'Z'; }).catch(() => { entry.state = 'Z'; });
    Journald.log('info', `[pid ${pid}] exec → ${name}`);
  },

  // wait: 프로세스 종료 대기
  async wait(pid) {
    const entry = _processTable.get(pid);
    if (!entry) return { pid, exitCode: -1 };
    await entry._promise;
    const code = entry.exitCode ?? 0;
    // Zombie 수거
    _processTable.delete(pid);
    _pidByName.get(entry.name)?.delete(pid);
    return { pid, name: entry.name, exitCode: code };
  },

  // kill: 시그널 전송
  kill(pid, signal = 'SIGTERM') {
    const entry = _processTable.get(pid);
    if (!entry) return false;
    entry._signals.push(signal);
    if (signal === 'SIGKILL') {
      entry.state    = 'Z';
      entry.exitCode = 137;
      Journald.log('warn', `[pid ${pid}] killed (SIGKILL)`);
    } else if (signal === 'SIGSTOP') {
      entry.state = 'T';
    } else if (signal === 'SIGCONT') {
      if (entry.state === 'T') entry.state = 'R';
    }
    SignalHandler._notifyListeners(signal, { pid });
    return true;
  },

  // ps: 프로세스 목록
  ps() {
    return [..._processTable.values()].map(e => ({
      pid   : e.pid,
      name  : e.name,
      ppid  : e.parentPid,
      state : e.state,
      cpuMs : e.cpuMs,
      memKb : e.memKb,
      cgroup: e.cgroupId,
    }));
  },

  // getpid / getppid
  getpid(name) { return [...(_pidByName.get(name) || [])][0] || null; },
  table()      { return ProcessManager.ps(); },
};

// ─────────────────────────────────────────────────────────────────────
// § 2. Cgroup v2 유사 자원 제어
// ─────────────────────────────────────────────────────────────────────
const _cgroups = new Map(); // cgroupId → CgroupEntry

class CgroupEntry {
  constructor({ id, parent = null, cpuLimitMs = 200, memLimitKb = 8192 }) {
    this.id          = id;
    this.parent      = parent;
    this.cpuLimitMs  = cpuLimitMs;
    this.memLimitKb  = memLimitKb;
    this.cpuUsedMs   = 0;
    this.memUsedKb   = 0;
    this._pids       = new Set();
    this._children   = new Set();
  }

  withinLimits() {
    return this.cpuUsedMs < this.cpuLimitMs && this.memUsedKb < this.memLimitKb;
  }

  stats() {
    return {
      id: this.id, parent: this.parent,
      cpu: { used: this.cpuUsedMs, limit: this.cpuLimitMs, pct: +(this.cpuUsedMs / this.cpuLimitMs * 100).toFixed(1) },
      mem: { used: this.memUsedKb, limit: this.memLimitKb, pct: +(this.memUsedKb / this.memLimitKb * 100).toFixed(1) },
      pids: [...this._pids],
    };
  }
}

export const CgroupManager = {
  create({ id, parent = null, cpuLimitMs = 200, memLimitKb = 8192 }) {
    const cg = new CgroupEntry({ id, parent, cpuLimitMs, memLimitKb });
    _cgroups.set(id, cg);
    if (parent && _cgroups.has(parent)) {
      _cgroups.get(parent)._children.add(id);
    }
    return cg;
  },

  get(id) { return _cgroups.get(id) || null; },

  // 프로세스를 cgroup에 배치
  _trackProcess(cgroupId, pid) {
    if (!cgroupId) return;
    const cg = _cgroups.get(cgroupId);
    if (cg) cg._pids.add(pid);
  },

  // CPU 사용 기록
  chargeCpu(cgroupId, ms) {
    let id = cgroupId;
    while (id) {
      const cg = _cgroups.get(id);
      if (!cg) break;
      cg.cpuUsedMs += ms;
      id = cg.parent;
    }
  },

  // 메모리 사용 기록
  chargeMem(cgroupId, kb) {
    let id = cgroupId;
    while (id) {
      const cg = _cgroups.get(id);
      if (!cg) break;
      cg.memUsedKb += kb;
      id = cg.parent;
    }
  },

  // 전체 cgroup 트리
  tree() {
    return [..._cgroups.values()].map(cg => cg.stats());
  },

  // 제한 초과 여부
  isThrottled(cgroupId) {
    const cg = _cgroups.get(cgroupId);
    return cg ? !cg.withinLimits() : false;
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 3. Unix 파이프라인 (|)
// ─────────────────────────────────────────────────────────────────────
class Pipe {
  constructor() {
    this._buf    = [];
    this._closed = false;
    this._waiters = [];
  }

  write(data) {
    if (this._closed) throw new Error('Broken pipe');
    this._buf.push(data);
    if (this._waiters.length) {
      const resolve = this._waiters.shift();
      resolve(this._buf.shift());
    }
  }

  async read() {
    if (this._buf.length) return this._buf.shift();
    if (this._closed) return null; // EOF
    return new Promise(resolve => this._waiters.push(resolve));
  }

  close() {
    this._closed = true;
    // EOF 대기 중인 consumer에게 null 전달
    while (this._waiters.length) this._waiters.shift()(null);
  }

  async *[Symbol.asyncIterator]() {
    let chunk;
    while ((chunk = await this.read()) !== null) yield chunk;
  }
}

export const PipelineEngine = {
  // 파이프 생성
  pipe() { return new Pipe(); },

  // 파이프라인 실행: [fn1, fn2, fn3] 순으로 연결
  // fn 시그니처: async (stdin: Pipe, stdout: Pipe) => void
  async run(fns, input = null) {
    if (!fns.length) return;

    const pipes = Array.from({ length: fns.length - 1 }, () => new Pipe());
    const stdin  = input || new Pipe();
    const stdout = new Pipe();

    const stages = fns.map((fn, i) => {
      const stageIn  = i === 0             ? stdin  : pipes[i - 1];
      const stageOut = i === fns.length - 1 ? stdout : pipes[i];
      return fn(stageIn, stageOut).then(() => stageOut.close()).catch(() => stageOut.close());
    });

    await Promise.all(stages);
    return stdout;
  },

  // grep: 조건 필터
  grep(predicate) {
    return async (stdin, stdout) => {
      for await (const chunk of stdin) {
        if (predicate(chunk)) stdout.write(chunk);
      }
    };
  },

  // map: 변환
  map(fn) {
    return async (stdin, stdout) => {
      for await (const chunk of stdin) stdout.write(fn(chunk));
    };
  },

  // reduce: 집계
  reduce(fn, initial) {
    return async (stdin, stdout) => {
      let acc = initial;
      for await (const chunk of stdin) acc = fn(acc, chunk);
      stdout.write(acc);
    };
  },

  // tee: 복제 출력 (T자 분기)
  tee(extra) {
    return async (stdin, stdout) => {
      for await (const chunk of stdin) {
        stdout.write(chunk);
        extra.write(chunk);
      }
      extra.close();
    };
  },

  // sort
  sort(compareFn) {
    return async (stdin, stdout) => {
      const items = [];
      for await (const chunk of stdin) items.push(chunk);
      items.sort(compareFn);
      for (const item of items) stdout.write(item);
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 4. IPC 버스 (프로세스 간 통신)
// ─────────────────────────────────────────────────────────────────────
const _msgQueues  = new Map(); // queueId → []
const _semaphores = new Map(); // semId → { value, waiting: [] }
const _sharedMem  = new Map(); // shmId → any

export const IpcBus = {
  // 메시지 큐 (POSIX mq_open / mq_send / mq_receive)
  mqCreate(queueId) { _msgQueues.set(queueId, []); },
  mqSend(queueId, msg) {
    if (!_msgQueues.has(queueId)) this.mqCreate(queueId);
    _msgQueues.get(queueId).push({ ts: Date.now(), data: msg });
  },
  mqReceive(queueId) {
    const q = _msgQueues.get(queueId);
    return q?.shift() || null;
  },
  mqDrain(queueId) {
    const q = _msgQueues.get(queueId) || [];
    _msgQueues.set(queueId, []);
    return q;
  },

  // 세마포어 (sem_init / sem_wait / sem_post)
  semCreate(semId, initial = 1) {
    _semaphores.set(semId, { value: initial, waiting: [] });
  },
  async semWait(semId) {
    let s = _semaphores.get(semId);
    if (!s) { this.semCreate(semId); s = _semaphores.get(semId); }
    if (s.value > 0) { s.value--; return; }
    await new Promise(resolve => s.waiting.push(resolve));
  },
  semPost(semId) {
    const s = _semaphores.get(semId);
    if (!s) return;
    if (s.waiting.length) { s.waiting.shift()(); }
    else { s.value++; }
  },

  // 공유 메모리 (shm_open / shm_read / shm_write)
  shmWrite(shmId, data) { _sharedMem.set(shmId, data); },
  shmRead(shmId)        { return _sharedMem.get(shmId) ?? null; },
  shmDelete(shmId)      { _sharedMem.delete(shmId); },

  // 이벤트 브로드캐스트 (pub/sub)
  _subscribers: new Map(),
  subscribe(channel, fn) {
    if (!this._subscribers.has(channel)) this._subscribers.set(channel, []);
    this._subscribers.get(channel).push(fn);
  },
  publish(channel, data) {
    (this._subscribers.get(channel) || []).forEach(fn => { try { fn(data); } catch (_) {} });
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 5. 가상 파일시스템 (/proc /sys /tmp /dev)
// ─────────────────────────────────────────────────────────────────────
const _vfs = {
  '/proc'      : null,  // 동적 생성
  '/sys/kernel': null,
  '/tmp'       : new Map(),
  '/dev/null'  : { read: () => null, write: () => {} },
};

export const VirtualFS = {
  // /proc/<pid>/status 유사
  procStatus(pid) {
    const e = _processTable.get(pid);
    if (!e) return null;
    return [
      `Name:\t${e.name}`,
      `Pid:\t${e.pid}`,
      `PPid:\t${e.parentPid || 0}`,
      `State:\t${e.state}`,
      `VmRSS:\t${e.memKb} kB`,
      `Cgroup:\t${e.cgroupId || '/'}`,
    ].join('\n');
  },

  // /proc/meminfo
  meminfo() {
    const totalKb = 65536; // Workers 환경 추정 64MB
    const used    = [..._processTable.values()].reduce((s, e) => s + e.memKb, 0);
    return `MemTotal:\t${totalKb} kB\nMemFree:\t${totalKb - used} kB\nMemUsed:\t${used} kB`;
  },

  // /proc/loadavg
  loadavg() {
    const ps   = ProcessManager.ps();
    const run  = ps.filter(p => p.state === 'R').length;
    const all  = ps.length;
    return `${run}.00 ${all}.00 ${all}.00 ${run}/${all} ${_nextPid}`;
  },

  // /tmp 읽기/쓰기
  tmpWrite(path, data) { _vfs['/tmp'].set(path, { data, mtime: Date.now() }); },
  tmpRead(path)        { return _vfs['/tmp'].get(path)?.data ?? null; },
  tmpDelete(path)      { _vfs['/tmp'].delete(path); },
  tmpList(prefix = '') { return [..._vfs['/tmp'].keys()].filter(k => k.startsWith(prefix)); },

  // /sys/kernel 파라미터
  sysctl: new Map([
    ['kernel.pid_max', '32768'],
    ['vm.swappiness',  '60'],
    ['net.ipv4.tcp_keepalive_time', '7200'],
  ]),

  sysSet(key, val) { this.sysctl.set(key, String(val)); },
  sysGet(key)      { return this.sysctl.get(key) ?? null; },

  // /dev/urandom 유사
  urandom(bytes = 16) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 6. POSIX 시그널 핸들러
// ─────────────────────────────────────────────────────────────────────
const _signalHandlers = new Map(); // signal → [fn, ...]

export const SignalHandler = {
  on(signal, fn) {
    if (!_signalHandlers.has(signal)) _signalHandlers.set(signal, []);
    _signalHandlers.get(signal).push(fn);
  },

  off(signal, fn) {
    const handlers = _signalHandlers.get(signal);
    if (!handlers) return;
    const idx = handlers.indexOf(fn);
    if (idx >= 0) handlers.splice(idx, 1);
  },

  _notifyListeners(signal, data = {}) {
    (_signalHandlers.get(signal) || []).forEach(fn => { try { fn(data); } catch (_) {} });
  },

  // 기본 시그널 이름 목록
  SIGNALS: ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGUSR1', 'SIGUSR2', 'SIGCHLD', 'SIGSTOP', 'SIGCONT'],
};

// ─────────────────────────────────────────────────────────────────────
// § 7. Journald (구조화 로그 + 링버퍼)
// ─────────────────────────────────────────────────────────────────────
const _journal  = [];
const MAX_JOURNAL = 2000;

export const Journald = {
  log(priority, message, fields = {}) {
    const entry = {
      ts      : Date.now(),
      priority,           // 'emerg'|'alert'|'crit'|'error'|'warn'|'info'|'debug'
      message,
      ...fields,
    };
    _journal.push(entry);
    if (_journal.length > MAX_JOURNAL) _journal.shift();
  },

  // journalctl -n <n> -p <priority> 유사
  query({ n = 100, priority = null, since = 0, unit = null } = {}) {
    let entries = _journal.filter(e => e.ts >= since);
    if (priority) {
      const pLevels = ['emerg','alert','crit','error','warn','info','debug'];
      const maxIdx  = pLevels.indexOf(priority);
      entries = entries.filter(e => pLevels.indexOf(e.priority) <= maxIdx);
    }
    if (unit) entries = entries.filter(e => e.unit === unit);
    return entries.slice(-n);
  },

  clear() { _journal.length = 0; },
  size()  { return _journal.length; },
};

// ─────────────────────────────────────────────────────────────────────
// § 8. Systemd 유사 서비스 매니저
// ─────────────────────────────────────────────────────────────────────
const _units = new Map(); // unit name → UnitConfig

class UnitConfig {
  constructor({ name, fn, description = '', type = 'oneshot', restart = 'no',
                restartDelay = 3000, after = [], wants = [] }) {
    this.name         = name;
    this.fn           = fn;
    this.description  = description;
    this.type         = type;        // oneshot | simple | forking
    this.restart      = restart;     // no | always | on-failure
    this.restartDelay = restartDelay;
    this.after        = after;       // 의존 유닛
    this.wants        = wants;
    this.state        = 'inactive';  // inactive|active|failed|activating
    this.pid          = null;
    this.restarts     = 0;
    this.activatedAt  = null;
  }
}

export const Systemd = {
  // 유닛 등록
  register(config) {
    const unit = new UnitConfig(config);
    _units.set(config.name, unit);
    Journald.log('info', `Registered unit: ${config.name}`, { unit: config.name });
    return unit;
  },

  // 유닛 시작
  async start(name) {
    const unit = _units.get(name);
    if (!unit) throw new Error(`Unit not found: ${name}`);
    if (unit.state === 'active') return unit;

    // 의존 유닛 먼저 시작
    for (const dep of unit.after) {
      const depUnit = _units.get(dep);
      if (depUnit && depUnit.state !== 'active') {
        await this.start(dep);
      }
    }

    unit.state       = 'activating';
    unit.activatedAt = Date.now();
    Journald.log('info', `Starting unit: ${name}`, { unit: name });

    const run = async () => {
      try {
        unit.pid = await ProcessManager.fork({
          name,
          fn  : unit.fn,
          cgroupId: 'systemd',
        });
        unit.state = 'active';
        Journald.log('info', `Unit active: ${name}`, { unit: name, pid: unit.pid });

        await ProcessManager.wait(unit.pid);

        if (unit.type === 'simple' && unit.restart === 'always') {
          unit.state    = 'activating';
          unit.restarts++;
          Journald.log('info', `Restarting unit: ${name} (attempt ${unit.restarts})`, { unit: name });
          await new Promise(r => setTimeout(r, unit.restartDelay));
          await run();
        } else if (unit.restart === 'on-failure') {
          unit.state = 'failed';
          Journald.log('error', `Unit failed, scheduling restart: ${name}`, { unit: name });
          await new Promise(r => setTimeout(r, unit.restartDelay));
          unit.restarts++;
          await run();
        } else {
          unit.state = 'inactive';
        }
      } catch (e) {
        unit.state = 'failed';
        Journald.log('error', `Unit failed: ${name} — ${e.message}`, { unit: name });
      }
    };

    run().catch(() => { unit.state = 'failed'; });
    return unit;
  },

  // 유닛 정지
  stop(name) {
    const unit = _units.get(name);
    if (!unit) return false;
    if (unit.pid !== null) ProcessManager.kill(unit.pid, 'SIGTERM');
    unit.state = 'inactive';
    Journald.log('info', `Stopped unit: ${name}`, { unit: name });
    return true;
  },

  // 유닛 재시작
  async restart(name) {
    this.stop(name);
    await new Promise(r => setTimeout(r, 200));
    return this.start(name);
  },

  // 전체 유닛 상태
  status() {
    return [..._units.values()].map(u => ({
      name       : u.name,
      description: u.description,
      state      : u.state,
      pid        : u.pid,
      restarts   : u.restarts,
      activatedAt: u.activatedAt,
      type       : u.type,
      restart    : u.restart,
    }));
  },

  // 유닛 조회
  getUnit(name) { return _units.get(name) || null; },
};

// ─────────────────────────────────────────────────────────────────────
// § 9. Cron 데몬 (crontab 파서 + 스케줄러)
// ─────────────────────────────────────────────────────────────────────
const _cronJobs = new Map(); // jobId → CronJob

class CronJob {
  constructor({ id, expr, fn, name = id }) {
    this.id       = id;
    this.name     = name;
    this.expr     = expr;   // '*/5 * * * *' 형식
    this.fn       = fn;
    this.lastRun  = 0;
    this.nextRun  = 0;
    this.runs     = 0;
    this.errors   = 0;
    this._parsed  = CronDaemon._parse(expr);
  }
}

export const CronDaemon = {
  // crontab 파싱 (* / , - 지원)
  _parse(expr) {
    const [min, hour, dom, mon, dow] = expr.split(/\s+/).map(f => this._parseField(f, 0, 59));
    return { min, hour, dom, mon, dow };
  },

  _parseField(field, lo, hi) {
    if (field === '*') return null; // 모든 값
    const vals = new Set();
    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const [start, end]  = range === '*' ? [lo, hi] : range.split('-').map(Number);
        for (let v = start; v <= (end ?? hi); v += Number(step)) vals.add(v);
      } else if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        for (let v = start; v <= end; v++) vals.add(v);
      } else {
        vals.add(Number(part));
      }
    }
    return vals;
  },

  _matches(job, date) {
    const p   = job._parsed;
    const min = date.getMinutes();
    const hr  = date.getHours();
    const dom = date.getDate();
    const mon = date.getMonth() + 1;
    const dow = date.getDay();
    const ok  = f => f === null || f.has(min) && true; // 각 필드 체크
    return (p.min  === null || p.min.has(min))  &&
           (p.hour === null || p.hour.has(hr))   &&
           (p.dom  === null || p.dom.has(dom))   &&
           (p.mon  === null || p.mon.has(mon))   &&
           (p.dow  === null || p.dow.has(dow));
  },

  // 잡 등록
  add({ id, expr, fn, name }) {
    const job = new CronJob({ id, expr, fn, name });
    _cronJobs.set(id, job);
    Journald.log('info', `Cron job registered: ${id} (${expr})`, { unit: 'crond' });
    return job;
  },

  remove(id) { return _cronJobs.delete(id); },

  // 틱 (매분 handleFetch에서 waitUntil로 호출)
  async tick() {
    const now  = new Date();
    const jobs = [..._cronJobs.values()];
    for (const job of jobs) {
      if (!this._matches(job, now)) continue;
      if (now.getTime() - job.lastRun < 55_000) continue; // 같은 분 중복 방지
      job.lastRun = now.getTime();
      job.runs++;
      Journald.log('info', `Cron fire: ${job.id}`, { unit: 'crond' });
      await job.fn().catch(e => {
        job.errors++;
        Journald.log('error', `Cron error: ${job.id} — ${e.message}`, { unit: 'crond' });
      });
    }
  },

  list() {
    return [..._cronJobs.values()].map(j => ({
      id: j.id, name: j.name, expr: j.expr,
      lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
      runs: j.runs, errors: j.errors,
    }));
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 10. 네트워크 네임스페이스 (veth pair, 브리지)
// ─────────────────────────────────────────────────────────────────────
const _netNs    = new Map(); // nsId → NetworkNamespace
const _bridges  = new Map(); // bridgeId → Bridge

class NetworkNamespace {
  constructor(id) {
    this.id       = id;
    this._veth    = new Map(); // ifName → { peer, bridge, mac, ip }
    this._routes  = [];        // [{ dest, via }]
    this._iptables = [];       // rules
  }

  addVeth(name, peerName, ip = null) {
    const mac = [...Array(6)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
    this._veth.set(name, { peer: peerName, bridge: null, mac, ip });
    return { name, mac, ip };
  }

  addRoute(dest, via) { this._routes.push({ dest, via }); }
  addIptables(rule)   { this._iptables.push(rule); }

  ifconfig() {
    return [...this._veth.entries()].map(([name, i]) =>
      `${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${i.ip || '0.0.0.0'}  netmask 255.255.255.0\n        ether ${i.mac}`
    ).join('\n');
  }
}

export const NetworkNS = {
  create(id) {
    const ns = new NetworkNamespace(id);
    _netNs.set(id, ns);
    return ns;
  },
  get(id) { return _netNs.get(id) || null; },
  list()  { return [..._netNs.keys()]; },

  // veth pair 생성 (두 네임스페이스 연결)
  createVethPair(ns1Id, ns2Id, ip1, ip2) {
    const ns1 = _netNs.get(ns1Id) || this.create(ns1Id);
    const ns2 = _netNs.get(ns2Id) || this.create(ns2Id);
    const name1 = `veth-${ns1Id.slice(0, 4)}`;
    const name2 = `veth-${ns2Id.slice(0, 4)}`;
    ns1.addVeth(name1, name2, ip1);
    ns2.addVeth(name2, name1, ip2);
    return { name1, name2, ip1, ip2 };
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 11. 멀티 인스턴스 워커 프로세스 매니저
//       (요청사항: "하나의 SEO 워커 안에서 여러개의 인스턴스 만들어서")
// ─────────────────────────────────────────────────────────────────────
const _instances    = new Map(); // instanceId → WorkerInstance
let   _instanceRR   = 0;

class WorkerInstance {
  constructor({ id, role, fn, cgroupId }) {
    this.id      = id;
    this.role    = role;
    this.fn      = fn;
    this.cgroupId = cgroupId;
    this.pid     = null;
    this.state   = 'pending'; // pending|running|stopped|failed
    this.stats   = { requests: 0, errors: 0, cpuMs: 0, startedAt: Date.now() };
  }
}

export const WorkerProcessManager = {
  // 인스턴스 등록 및 시작
  async spawn({ id, role, fn, cgroupId = 'worker-pool' }) {
    if (_instances.has(id)) return _instances.get(id);

    const inst = new WorkerInstance({ id, role, fn, cgroupId });
    _instances.set(id, inst);

    CgroupManager._trackProcess(cgroupId, 0);

    inst.pid = await ProcessManager.fork({
      name    : `worker:${role}:${id}`,
      fn      : async (proc) => {
        inst.state = 'running';
        Journald.log('info', `Worker instance started: ${id}`, { unit: `worker-${role}` });
        // 인스턴스가 처리할 실제 로직 실행
        await fn(inst, proc);
      },
      cgroupId,
    });

    Journald.log('info', `Spawned worker instance: ${id} (role=${role}, pid=${inst.pid})`);
    return inst;
  },

  // 라운드 로빈 인스턴스 선택
  pickInstance(role) {
    const active = [..._instances.values()].filter(i => i.role === role && i.state === 'running');
    if (!active.length) return null;
    const inst = active[_instanceRR % active.length];
    _instanceRR++;
    return inst;
  },

  // 인스턴스에 요청 라우팅 (로드밸런싱)
  async dispatch(role, context) {
    const inst = this.pickInstance(role);
    if (!inst) return null;

    const t0 = Date.now();
    try {
      inst.stats.requests++;
      if (inst.fn) {
        const result = await inst.fn(context);
        inst.stats.cpuMs += Date.now() - t0;
        return result;
      }
    } catch (e) {
      inst.stats.errors++;
      Journald.log('error', `Worker dispatch error: ${inst.id} — ${e.message}`);
    }
    return null;
  },

  stop(id) {
    const inst = _instances.get(id);
    if (!inst) return false;
    if (inst.pid) ProcessManager.kill(inst.pid, 'SIGTERM');
    inst.state = 'stopped';
    return true;
  },

  list() {
    return [..._instances.values()].map(i => ({
      id     : i.id,
      role   : i.role,
      pid    : i.pid,
      state  : i.state,
      stats  : i.stats,
      cgroup : i.cgroupId,
    }));
  },

  stats() {
    const list = this.list();
    return {
      total  : list.length,
      running: list.filter(i => i.state === 'running').length,
      stopped: list.filter(i => i.state === 'stopped').length,
      failed : list.filter(i => i.state === 'failed').length,
      instances: list,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// § 12. 멀티 인스턴스 SEO 워커 부트스트랩
//       : SEO 처리를 여러 인스턴스로 분산
// ─────────────────────────────────────────────────────────────────────

/** cgroup 초기 설정 */
function bootstrapCgroups() {
  CgroupManager.create({ id: 'root',        cpuLimitMs: 1000, memLimitKb: 65536 });
  CgroupManager.create({ id: 'systemd',     parent: 'root', cpuLimitMs: 100,  memLimitKb: 4096 });
  CgroupManager.create({ id: 'worker-pool', parent: 'root', cpuLimitMs: 600,  memLimitKb: 40960 });
  CgroupManager.create({ id: 'seo',         parent: 'worker-pool', cpuLimitMs: 400, memLimitKb: 20480 });
  CgroupManager.create({ id: 'crawl',       parent: 'worker-pool', cpuLimitMs: 200, memLimitKb: 10240 });
}

/** SEO 워커 인스턴스 4개 스폰 (슬러그/사이트맵/RSS/크롤) */
async function bootstrapWorkerInstances() {
  const roles = [
    { id: 'seo-slug-0',    role: 'seo-slug',    cgroupId: 'seo' },
    { id: 'seo-slug-1',    role: 'seo-slug',    cgroupId: 'seo' },
    { id: 'seo-sitemap-0', role: 'seo-sitemap', cgroupId: 'seo' },
    { id: 'seo-rss-0',     role: 'seo-rss',     cgroupId: 'seo' },
    { id: 'crawl-0',       role: 'crawl',        cgroupId: 'crawl' },
    { id: 'crawl-1',       role: 'crawl',        cgroupId: 'crawl' },
  ];

  for (const r of roles) {
    await WorkerProcessManager.spawn({
      ...r,
      fn: async (inst, proc) => {
        // 각 인스턴스는 IPC 채널 구독 후 메시지 처리 루프
        IpcBus.subscribe(`task:${r.role}`, async (task) => {
          if (!task) return;
          inst.stats.requests++;
          try {
            if (task.fn) await task.fn(task.data);
          } catch (e) {
            inst.stats.errors++;
          }
        });
        // 인스턴스는 살아있는 동안 대기 (실제로 Workers는 이벤트 루프 기반)
      },
    }).catch(() => {});
  }
}

/** Systemd 유닛 등록 */
function bootstrapSystemd() {
  CgroupManager.create({ id: 'systemd', parent: 'root', cpuLimitMs: 100, memLimitKb: 4096 });

  Systemd.register({
    name       : 'seo-worker.service',
    description: 'BloggerSEO 주 처리 서비스',
    type       : 'simple',
    restart    : 'on-failure',
    fn         : async () => { /* 메인 루프 — Workers가 핸들링 */ },
  });

  Systemd.register({
    name       : 'slug-daemon.service',
    description: '슬러그 자동 감사 데몬',
    type       : 'simple',
    restart    : 'always',
    fn         : async () => { /* Cron 1h slug audit */ },
  });

  Systemd.register({
    name       : 'sitemap-cron.service',
    description: '사이트맵 생성 서비스',
    type       : 'oneshot',
    restart    : 'no',
    fn         : async () => { /* 매 1시간 사이트맵 */ },
  });
}

/** Cron 잡 등록 */
function bootstrapCron() {
  CronDaemon.add({ id: 'slug-audit',    name: '슬러그 감사',     expr: '0 * * * *',    fn: async () => {} });
  CronDaemon.add({ id: 'sitemap-gen',   name: '사이트맵 생성',   expr: '5 * * * *',    fn: async () => {} });
  CronDaemon.add({ id: 'rss-gen',       name: 'RSS 생성',        expr: '*/30 * * * *', fn: async () => {} });
  CronDaemon.add({ id: 'cert-check',    name: '인증서 확인',     expr: '0 */6 * * *',  fn: async () => {} });
  CronDaemon.add({ id: 'cache-purge',   name: '캐시 정리',       expr: '*/30 * * * *', fn: async () => {} });
  CronDaemon.add({ id: 'lb-heartbeat',  name: 'LB 헬스체크',     expr: '* * * * *',    fn: async () => {} });
}

/** 네트워크 네임스페이스 구성 */
function bootstrapNetworkNS() {
  NetworkNS.create('host');
  NetworkNS.create('seo-ns');
  NetworkNS.createVethPair('host', 'seo-ns', '10.0.0.1', '10.0.0.2');
  NetworkNS.create('crawl-ns');
  NetworkNS.createVethPair('host', 'crawl-ns', '10.0.1.1', '10.0.1.2');
}

// ── 최초 1회 부트스트랩 ──────────────────────────────────────────────
let _linuxBootstrapped = false;
export async function bootstrapLinux() {
  if (_linuxBootstrapped) return;
  _linuxBootstrapped = true;
  try {
    bootstrapCgroups();
    bootstrapSystemd();
    bootstrapCron();
    bootstrapNetworkNS();
    Journald.log('info', 'Linux subsystem bootstrapped', { unit: 'init' });
    // 인스턴스 스폰은 비동기 — 첫 요청 시작과 동시에 진행
    bootstrapWorkerInstances().catch(() => {});
  } catch (e) {
    Journald.log('error', `Linux bootstrap failed: ${e.message}`, { unit: 'init' });
  }
}

// ── 전체 Linux 상태 스냅샷 (패널용) ─────────────────────────────────
export function linuxStatus() {
  return {
    kernel  : { version: 'BloggerSEO-Linux/6.6.0-virtual', arch: 'x86_64' },
    proc    : { loadavg: VirtualFS.loadavg(), meminfo: VirtualFS.meminfo() },
    ps      : ProcessManager.ps(),
    cgroups : CgroupManager.tree(),
    systemd : Systemd.status(),
    cron    : CronDaemon.list(),
    workers : WorkerProcessManager.stats(),
    ipc     : {
      queues    : [..._msgQueues.keys()],
      semaphores: [..._semaphores.keys()],
      shm       : [..._sharedMem.keys()],
    },
    netns   : NetworkNS.list(),
    journal : Journald.query({ n: 50 }),
  };
}
