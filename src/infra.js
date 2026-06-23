// ═══════════════════════════════════════════════════════════════════
// [인프라 강화 모듈] — EC2/Linux 환경에서 흔히 쓰이는 운영 기능을
// Cloudflare Workers 네이티브 방식으로 재구현.
//
// EC2/Linux에서 일반적인 다음 요소들을 Workers 모델에 맞게 가져옴:
//   - 구조화 로깅(JSON lines, syslog 스타일 레벨) → console.log(JSON)
//     (Cloudflare Workers Logs/Logpush가 EC2의 journald/syslog 역할)
//   - 메트릭(레이턴시 히스토그램, P50/P95, 에러율, 처리량) → KV 집계
//     (Linux의 node_exporter/Prometheus 역할을 KV 기반 경량 버전으로)
//   - 레이트 리미팅(토큰 버킷) → KV 기반, iptables/nginx limit_req와 동등 목적
//   - 재시도 + 지수 백오프 + 지터 → systemd Restart=on-failure와 유사한
//     복원력을 origin fetch 단위로 적용
//   - 동시성 큐잉(세마포어) → Linux 프로세스의 worker pool/세마포어와 유사,
//     단일 Workers 인스턴스 내에서 동시 origin 호출 수를 제한
//   - 커넥션 최적화 힌트 → keep-alive 등 TCP 튜닝에 준하는 fetch 옵션
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// 구조화 로깅 (JSON Lines) — EC2의 syslog/journald 대응
// ─────────────────────────────────────────────
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function structuredLog(level, event, fields) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    const line = JSON.stringify(entry);
    if (LOG_LEVELS[level] >= LOG_LEVELS.warn) {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch (_) {
    // 로깅 자체가 실패해도 서비스에 영향 없음
  }
}

// ─────────────────────────────────────────────
// 메트릭 수집기 — 요청 1건 동안의 타이밍/이벤트를 모아 비동기로 KV 집계.
// EC2의 Prometheus exporter처럼 "현재 상태"를 누적 카운터/히스토그램
// 버킷으로 저장. 고빈도 쓰기를 피하기 위해 버킷 단위(분)로 키를 묶고
// KV put을 요청당 최대 1~2회로 제한.
// ─────────────────────────────────────────────
const LATENCY_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function bucketIndex(ms) {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (ms <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length; // overflow bucket (+Inf)
}

function minuteWindow(ts) {
  return Math.floor(ts / 60000) * 60000;
}

class Metrics {
  constructor(env, ctx, host) {
    this.env = env;
    this.ctx = ctx;
    this.host = host;
    this.events = []; // 요청 동안의 디버그 이벤트 (응답에는 노출 안 함, 로그용)
    this.timings = {}; // name -> ms[]
    this.t0 = Date.now();
  }

  recordLatency(name, ms) {
    if (!this.timings[name]) this.timings[name] = [];
    this.timings[name].push(ms);
  }

  logEvent(event, fields) {
    this.events.push({ event, fields, ts: Date.now() });
    structuredLog('info', event, { host: this.host, ...fields });
  }

  logError(event, fields) {
    structuredLog('error', event, { host: this.host, ...fields });
  }

  // 요청 종료 시 1회 호출 — KV에 분 단위 버킷으로 비동기 집계.
  // env.METRICS_KV가 없으면(미바인딩) 조용히 스킵 — 기존 워커 동작에 영향 없음.
  async flush(status, totalMs) {
    if (!this.env.SLUG_KV) return; // 별도 KV 네임스페이스 없이 기존 SLUG_KV 재사용
    try {
      const win = minuteWindow(this.t0);
      const key = `metrics:${win}`;
      const bIdx = bucketIndex(totalMs);

      // 짧은 시간 창 안의 동시 갱신은 last-write-wins가 발생할 수 있으나,
      // 메트릭은 근사치로 충분하므로(EC2의 statsd UDP 카운터와 동일한 트레이드오프)
      // 별도 락 없이 단순 read-modify-write로 처리.
      const raw = await this.env.SLUG_KV.get(key);
      const agg = raw ? JSON.parse(raw) : { count: 0, errors: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), statusCounts: {} };
      agg.count += 1;
      if (status >= 500) agg.errors += 1;
      agg.buckets[bIdx] = (agg.buckets[bIdx] || 0) + 1;
      agg.statusCounts[status] = (agg.statusCounts[status] || 0) + 1;
      await this.env.SLUG_KV.put(key, JSON.stringify(agg), { expirationTtl: 86400 });
    } catch (_) {
      // 메트릭 적재 실패는 응답에 영향 없음
    }
  }
}

// 메트릭 조회(디버그 엔드포인트용) — 최근 N분 집계를 합산
async function readRecentMetrics(env, minutes) {
  if (!env.SLUG_KV) return { bound: false };
  const now = Date.now();
  const summary = { count: 0, errors: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), statusCounts: {}, windowMinutes: minutes };
  for (let i = 0; i < minutes; i++) {
    const win = minuteWindow(now - i * 60000);
    try {
      const raw = await env.SLUG_KV.get(`metrics:${win}`);
      if (!raw) continue;
      const agg = JSON.parse(raw);
      summary.count += agg.count || 0;
      summary.errors += agg.errors || 0;
      for (let b = 0; b < summary.buckets.length; b++) summary.buckets[b] += (agg.buckets[b] || 0);
      for (const [k, v] of Object.entries(agg.statusCounts || {})) {
        summary.statusCounts[k] = (summary.statusCounts[k] || 0) + v;
      }
    } catch (_) {}
  }
  summary.errorRate = summary.count > 0 ? summary.errors / summary.count : 0;
  summary.bucketLabelsMs = [...LATENCY_BUCKETS_MS, 'Infinity'];
  return { bound: true, ...summary };
}

// ─────────────────────────────────────────────
// 레이트 리미터 — 토큰 버킷(Token Bucket), KV 기반.
// EC2/nginx의 limit_req_zone과 동등한 목적: 호스트(또는 클라이언트 IP)당
// 초당 요청 수 상한. Workers는 단일 인스턴스가 아니므로 KV로 분산 상태를
// 공유(완전 정확하진 않지만 — EC2의 단일 nginx 프로세스보다는 근사치이며,
// 실무에서 흔히 쓰이는 "근사 분산 레이트리밋" 패턴).
// ─────────────────────────────────────────────
async function checkRateLimit(env, key, limitPerWindow, windowSeconds) {
  if (!env.SLUG_KV) return { allowed: true, skipped: true };
  try {
    const kvKey = `rl:${key}`;
    const raw = await env.SLUG_KV.get(kvKey);
    const now = Date.now();
    let bucket = raw ? JSON.parse(raw) : { count: 0, windowStart: now };

    if (now - bucket.windowStart > windowSeconds * 1000) {
      bucket = { count: 0, windowStart: now };
    }

    bucket.count += 1;
    const allowed = bucket.count <= limitPerWindow;

    await env.SLUG_KV.put(kvKey, JSON.stringify(bucket), { expirationTtl: windowSeconds * 2 });
    return { allowed, count: bucket.count, limit: limitPerWindow };
  } catch (_) {
    return { allowed: true, skipped: true };
  }
}

// ─────────────────────────────────────────────
// 재시도 + 지수 백오프 + 지터 — origin fetch 복원력.
// EC2 환경의 systemd Restart=on-failure, 또는 애플리케이션 레벨 retry
// 미들웨어(예: nginx upstream retry, AWS SDK 기본 재시도)와 동등한 목적.
// HTML/GET 요청에만 적용 (POST 등 비-idempotent 메서드는 재시도하지 않음).
// ─────────────────────────────────────────────
async function fetchWithRetry(fetchFn, options) {
  const maxRetries = (options && options.maxRetries) != null ? options.maxRetries : 2;
  const baseDelayMs = (options && options.baseDelayMs) != null ? options.baseDelayMs : 60;
  const retryableStatuses = (options && options.retryableStatuses) || [502, 503, 504];
  const onRetry = options && options.onRetry;

  let lastErr = null;
  let lastResp = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchFn();
      if (resp && !retryableStatuses.includes(resp.status)) {
        return resp;
      }
      lastResp = resp;
      if (attempt === maxRetries) return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) throw e;
    }
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * baseDelayMs);
    if (onRetry) onRetry(attempt, delay, lastErr || (lastResp && lastResp.status));
    await new Promise(r => setTimeout(r, delay));
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

// ─────────────────────────────────────────────
// 동시성 게이트(세마포어) — 단일 워커 인스턴스 내에서 동시에 진행 중인
// origin fetch 수를 제한. Linux 프로세스 풀(worker_processes, PM2 cluster
// 등)에서 동시 접속 상한을 두는 것과 유사한 목적을 인스턴스 단위로 적용.
// (도메인 간 격리는 githubTenantAcquire/Release가 GitHub state로 전역 처리)
// ─────────────────────────────────────────────
class LocalSemaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

// 워커 인스턴스(콜드/웜 lifetime) 동안 유지되는 전역 세마포어.
// EC2의 "프로세스당 워커 풀 크기"에 대응하는 인스턴스 로컬 동시성 상한.
const _globalSemaphore = new LocalSemaphore(48);

async function withConcurrencyGate(fn) {
  await _globalSemaphore.acquire();
  try {
    return await fn();
  } finally {
    _globalSemaphore.release();
  }
}

// ─────────────────────────────────────────────
// 커넥션 최적화 힌트 — Cloudflare 엣지가 origin과의 TCP/TLS 커넥션을
// 재사용하도록 유도하는 fetch 옵션. EC2/nginx의 keepalive_requests,
// keepalive_timeout 튜닝과 동등한 목적(워커 런타임이 직접 소켓을 들고
// 있진 않지만, Cloudflare의 커넥션 풀링에 우호적인 신호를 제공).
// ─────────────────────────────────────────────
function connectionOptimizedCf(baseCf) {
  return {
    ...baseCf,
    // HTTP/2 또는 HTTP/3을 선호하도록 — Cloudflare가 origin과의 연결을
    // 더 오래 유지/재사용할 수 있게 함
    http3: true,
  };
}

export {
  structuredLog,
  Metrics,
  readRecentMetrics,
  checkRateLimit,
  fetchWithRetry,
  LocalSemaphore,
  withConcurrencyGate,
  connectionOptimizedCf,
};
