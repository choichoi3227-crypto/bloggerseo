/**
 * BloggerSEO v6 — 자체 서버리스 NoSQL KV 스토리지 엔진
 * ─────────────────────────────────────────────────────────────────────
 * 특징:
 *   - Cloudflare KV / D1 완전 미사용
 *   - Workers 인-메모리 방식 금지 (영속 보장)
 *   - Upstash Redis REST API 기반 (초고속, 글로벌 엣지)
 *   - 용도: Cache Reserve, 스키마 마크업 저장, 상태 엔진, IP 블록, 지역 캐시 메타
 *   - 키 스킴:
 *       slug:origin:{path}      → JSON (슬러그 원본 경로)
 *       slug:alias:{path}       → string (슬러그 별칭)
 *       cache:{hash}            → JSON (Cache Reserve 항목)
 *       schema:{hash}           → JSON (스키마 마크업 캐시)
 *       state:block:{ip}        → 1 (차단 IP)
 *       state:region:{region}   → JSON (지역별 캐시 통계)
 *       state:worker:{id}       → JSON (워커 인스턴스 상태)
 *       sitemap:index           → XML
 *       rss:feed                → XML
 */

// ── 인스턴스 레벨 L1 메모리 캐시 (Workers 수명 동안 유효, TTL=30초) ──
const _l1 = new Map();
const L1_TTL_MS = 30_000;

function l1get(key) {
  const e = _l1.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { _l1.delete(key); return undefined; }
  return e.val;
}
function l1set(key, val, ttlMs = L1_TTL_MS) {
  _l1.set(key, { val, exp: Date.now() + ttlMs });
}

// ── Upstash Redis REST API 래퍼 ──────────────────────────────────────
async function redisCmd(env, ...args) {
  const url   = env.UPSTASH_REDIS_URL;
  const token = env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) return null;

  try {
    const resp = await fetch(`${url}`, {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type' : 'application/json',
      },
      body   : JSON.stringify(args),
      cf     : { cacheTtl: 0, cacheEverything: false },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.result ?? null;
  } catch (_) { return null; }
}

// ── 기본 KV 연산 ─────────────────────────────────────────────────────
export async function kvGet(env, key) {
  const cached = l1get(key);
  if (cached !== undefined) return cached;

  const val = await redisCmd(env, 'GET', key);
  l1set(key, val);
  return val;
}

export async function kvSet(env, key, value, ttlSec = 0) {
  l1set(key, value, Math.min((ttlSec || 3600) * 1000, L1_TTL_MS));
  if (ttlSec > 0) {
    return redisCmd(env, 'SET', key, value, 'EX', ttlSec);
  }
  return redisCmd(env, 'SET', key, value);
}

export async function kvDel(env, key) {
  _l1.delete(key);
  return redisCmd(env, 'DEL', key);
}

export async function kvGetJson(env, key) {
  const raw = await kvGet(env, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

export async function kvSetJson(env, key, obj, ttlSec = 0) {
  return kvSet(env, key, JSON.stringify(obj), ttlSec);
}

export async function kvScan(env, pattern, count = 100) {
  const keys = await redisCmd(env, 'SCAN', '0', 'MATCH', pattern, 'COUNT', count);
  if (!keys || !Array.isArray(keys)) return [];
  return keys[1] || [];
}

// ── CNAME 캐시 (메모리 전용 — 24h TTL) ──────────────────────────────
const _cnameCache = new Map();
const CNAME_MEM_TTL = 24 * 3600 * 1000;

export function cnameGet(host) {
  const e = _cnameCache.get(host);
  if (!e) return null;
  if (Date.now() - e.ts > CNAME_MEM_TTL) { _cnameCache.delete(host); return null; }
  return e.ok;
}
export function cnameSet(host, ok) {
  _cnameCache.set(host, { ok, ts: Date.now() });
}

// ── 레이트 리밋 (메모리, 1분 윈도우) ────────────────────────────────
const _rateLimit   = new Map();
const RL_WINDOW_MS = 60_000;

export function checkRateLimit(host, limitPerMin = 600) {
  const now = Date.now();
  let b = _rateLimit.get(host);
  if (!b || now - b.windowStart > RL_WINDOW_MS) b = { count: 0, windowStart: now };
  b.count++;
  _rateLimit.set(host, b);
  return { allowed: b.count <= limitPerMin, count: b.count, limit: limitPerMin };
}

// ── 메트릭 (메모리 — 재시작시 리셋 허용) ────────────────────────────
const _metrics = { count: 0, errors: 0, statusCounts: {}, latencySum: 0 };

export function recordMetric(status, latencyMs) {
  _metrics.count++;
  _metrics.latencySum += latencyMs || 0;
  if (status >= 500) _metrics.errors++;
  _metrics.statusCounts[status] = (_metrics.statusCounts[status] || 0) + 1;
}
export function getMetrics() {
  return {
    ..._metrics,
    avgLatencyMs : _metrics.count > 0 ? Math.round(_metrics.latencySum / _metrics.count) : 0,
    errorRate    : _metrics.count > 0 ? (_metrics.errors / _metrics.count).toFixed(4) : 0,
    note         : 'in-memory (resets on worker restart); use /panel for persistent analytics',
  };
}

// ── 슬러그 영속 스토리지 ─────────────────────────────────────────────
export async function slugOriginGet(env, originPath) {
  return kvGetJson(env, 'slug:origin:' + originPath);
}
export async function slugAliasGet(env, titlePath) {
  return kvGet(env, 'slug:alias:' + titlePath);
}
export async function slugOriginPut(env, originPath, data) {
  return kvSetJson(env, 'slug:origin:' + originPath, data);
}
export async function slugAliasPut(env, titlePath, originPath) {
  return kvSet(env, 'slug:alias:' + titlePath, originPath);
}
export async function slugAliasDelete(env, titlePath) {
  return kvDel(env, 'slug:alias:' + titlePath);
}

export async function upsertSlug(env, originPath, title, titleSlug) {
  if (!title || !titleSlug) return;
  const titlePath = '/' + titleSlug;
  const existing  = await slugOriginGet(env, originPath);
  const now       = Date.now();

  if (!existing) {
    await slugOriginPut(env, originPath, { title, titleSlug, titlePath, createdAt: now, checkedAt: now });
    await slugAliasPut(env, titlePath, originPath);
  } else if (existing.titlePath !== titlePath) {
    await slugAliasDelete(env, existing.titlePath);
    await slugAliasPut(env, titlePath, originPath);
    await slugOriginPut(env, originPath, { ...existing, title, titleSlug, titlePath, checkedAt: now });
  }
}

export async function purgeAllSlugs(env) {
  const keys = await kvScan(env, 'slug:*', 500);
  let deleted = 0;
  for (const k of keys) { await kvDel(env, k); deleted++; }
  return { deleted };
}

// ── 차단 IP 관리 ─────────────────────────────────────────────────────
export async function blockIp(env, ip, ttlSec = 86400) {
  return kvSet(env, 'state:block:' + ip, '1', ttlSec);
}
export async function isIpBlocked(env, ip) {
  const v = await kvGet(env, 'state:block:' + ip);
  return v === '1';
}
export async function unblockIp(env, ip) {
  return kvDel(env, 'state:block:' + ip);
}
export async function listBlockedIps(env) {
  return kvScan(env, 'state:block:*', 200);
}

// ── 지역별 캐시 상태 ─────────────────────────────────────────────────
export async function regionCacheSet(env, region, data) {
  return kvSetJson(env, 'state:region:' + region, { ...data, updatedAt: Date.now() });
}
export async function regionCacheGet(env, region) {
  return kvGetJson(env, 'state:region:' + region);
}

// ── 워커 인스턴스 상태 등록 ──────────────────────────────────────────
export async function workerHeartbeat(env, workerId, state) {
  return kvSetJson(env, 'state:worker:' + workerId, {
    ...state, workerId, ts: Date.now(),
  }, 120); // 2분 TTL (죽은 인스턴스 자동 제거)
}
export async function listActiveWorkers(env) {
  const keys = await kvScan(env, 'state:worker:*', 100);
  const results = [];
  for (const k of keys) {
    const d = await kvGetJson(env, k);
    if (d) results.push(d);
  }
  return results;
}

// ── 사이트맵 / RSS 저장 ──────────────────────────────────────────────
export async function saveSitemap(env, xml) {
  return kvSet(env, 'sitemap:index', xml, 7200); // 2시간 TTL
}
export async function getSitemap(env) {
  return kvGet(env, 'sitemap:index');
}
export async function saveRss(env, xml) {
  return kvSet(env, 'rss:feed', xml, 3600); // 1시간 TTL
}
export async function getRss(env) {
  return kvGet(env, 'rss:feed');
}

// ── 스키마 마크업 캐시 ───────────────────────────────────────────────
export async function schemaGet(env, hash) {
  return kvGetJson(env, 'schema:' + hash);
}
export async function schemaPut(env, hash, schema, ttlSec = 14400) {
  return kvSetJson(env, 'schema:' + hash, schema, ttlSec);
}

// ── 분석 이벤트 기록 ─────────────────────────────────────────────────
export async function recordAnalytics(env, event) {
  // Redis LPUSH로 분석 큐에 추가 (최대 10000개 유지)
  const key = 'analytics:events';
  await redisCmd(env, 'LPUSH', key, JSON.stringify({ ...event, ts: Date.now() }));
  await redisCmd(env, 'LTRIM', key, 0, 9999);
}
export async function getAnalytics(env, count = 100) {
  const items = await redisCmd(env, 'LRANGE', 'analytics:events', 0, count - 1);
  if (!Array.isArray(items)) return [];
  return items.map(i => { try { return JSON.parse(i); } catch (_) { return null; } }).filter(Boolean);
}
