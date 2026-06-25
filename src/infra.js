// ═══════════════════════════════════════════════════════════════════
// [인프라 모듈 v4] — 구조화 로깅 / 메트릭 / 레이트리밋 / 재시도 / 동시성
// CNAME_KV 분리 반영: 레이트리밋/메트릭은 CNAME_KV 사용
// ═══════════════════════════════════════════════════════════════════

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function structuredLog(level, event, fields) {
  try {
    const entry = { ts: new Date().toISOString(), level, event, ...fields };
    const line = JSON.stringify(entry);
    (LOG_LEVELS[level] >= LOG_LEVELS.warn ? console.error : console.log)(line);
  } catch (_) {}
}

// ─── 메트릭 ────────────────────────────────────────────────────────
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function bucketIndex(ms) {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (ms <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length;
}

function minuteWindow(ts) { return Math.floor(ts / 60000) * 60000; }

export class Metrics {
  constructor(env, ctx, host) {
    this.env = env; this.ctx = ctx; this.host = host;
    this.events = []; this.timings = {}; this.t0 = Date.now();
  }
  recordLatency(name, ms) {
    if (!this.timings[name]) this.timings[name] = [];
    this.timings[name].push(ms);
  }
  logEvent(event, fields) {
    this.events.push({ event, fields, ts: Date.now() });
    structuredLog('info', event, { host: this.host, ...fields });
  }
  logError(event, fields) { structuredLog('error', event, { host: this.host, ...fields }); }

  async flush(status, totalMs) {
    // CNAME_KV를 메트릭 저장소로 사용 (SLUG_KV 오염 방지)
    const kv = this.env.CNAME_KV;
    if (!kv) return;
    try {
      const win = minuteWindow(this.t0);
      const key = `metrics:${win}`;
      const bIdx = bucketIndex(totalMs);
      const raw = await kv.get(key).catch(() => null);
      const agg = raw
        ? JSON.parse(raw)
        : { count: 0, errors: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), statusCounts: {} };
      agg.count += 1;
      if (status >= 500) agg.errors += 1;
      agg.buckets[bIdx] = (agg.buckets[bIdx] || 0) + 1;
      agg.statusCounts[status] = (agg.statusCounts[status] || 0) + 1;
      await kv.put(key, JSON.stringify(agg), { expirationTtl: 86400 });
    } catch (_) {}
  }
}

export async function readRecentMetrics(env, minutes) {
  const kv = env.CNAME_KV;
  if (!kv) return { bound: false };
  const now = Date.now();
  const summary = {
    count: 0, errors: 0,
    buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
    statusCounts: {}, windowMinutes: minutes,
  };
  for (let i = 0; i < minutes; i++) {
    const win = minuteWindow(now - i * 60000);
    try {
      const raw = await kv.get(`metrics:${win}`).catch(() => null);
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

// ─── 레이트 리미터 (CNAME_KV) ─────────────────────────────────────
export async function checkRateLimit(env, key, limitPerWindow, windowSeconds) {
  const kv = env.CNAME_KV;
  if (!kv) return { allowed: true, skipped: true };
  try {
    const kvKey = `rl:${key}`;
    const raw = await kv.get(kvKey).catch(() => null);
    const now = Date.now();
    let bucket = raw ? JSON.parse(raw) : { count: 0, windowStart: now };
    if (now - bucket.windowStart > windowSeconds * 1000) bucket = { count: 0, windowStart: now };
    bucket.count += 1;
    const allowed = bucket.count <= limitPerWindow;
    await kv.put(kvKey, JSON.stringify(bucket), { expirationTtl: windowSeconds * 2 }).catch(() => {});
    return { allowed, count: bucket.count, limit: limitPerWindow };
  } catch (_) {
    return { allowed: true, skipped: true };
  }
}

// ─── 재시도 + 지수 백오프 + 지터 ─────────────────────────────────
export async function fetchWithRetry(fetchFn, options) {
  const maxRetries = (options && options.maxRetries) != null ? options.maxRetries : 2;
  const baseDelayMs = (options && options.baseDelayMs) != null ? options.baseDelayMs : 60;
  const retryableStatuses = (options && options.retryableStatuses) || [502, 503, 504];
  const onRetry = options && options.onRetry;

  let lastErr = null, lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchFn();
      if (resp && !retryableStatuses.includes(resp.status)) return resp;
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

// ─── 동시성 게이트 (세마포어) ─────────────────────────────────────
export class LocalSemaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

const _globalSemaphore = new LocalSemaphore(48);

export async function withConcurrencyGate(fn) {
  await _globalSemaphore.acquire();
  try { return await fn(); } finally { _globalSemaphore.release(); }
}

// ─── 커넥션 최적화 ─────────────────────────────────────────────────
export function connectionOptimizedCf(baseCf) {
  return { ...baseCf, http3: true };
}

// ─── LB 기록 (CNAME_KV) ─────────────────────────────────────────
const LB_RTT_DECAY = 0.25;
const LB_RTT_TTL   = 60;

export async function lbRecordRtt(host, rttMs, env) {
  const kv = env.CNAME_KV;
  if (!kv) return;
  try {
    const prev = await kv.get(`lb:rtt:${host}`, { type: 'json' }).catch(() => null);
    const ewma = prev && typeof prev.rtt === 'number'
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await kv.put(`lb:rtt:${host}`, JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

export async function lbRecordBandwidth(host, bytes, env) {
  const kv = env.CNAME_KV;
  if (!kv) return;
  try {
    const raw = await kv.get(`lb:bw:${host}`).catch(() => null);
    const prev = parseInt(raw || '0', 10) || 0;
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await kv.put(`lb:bw:${host}`, String(next), { expirationTtl: 86400 });
  } catch (_) {}
}
