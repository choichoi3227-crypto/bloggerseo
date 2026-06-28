/**
 * BloggerSEO v7 — 자체 서버리스 NoSQL KV 스토리지 엔진
 * ─────────────────────────────────────────────────────────────────────
 * [v7.0] 5단계 폴백 구조로 재설계 — 100% 자체 제작 Redis(DO 기반)를 1순위로 승격
 *
 *   읽기 (순차 폴백, 먼저 찾은 값을 반환):
 *     1순위: DO Redis   — 자체 제작 서버리스 Redis (Durable Objects, 샤딩 64-way)
 *     2순위: SLUG_KV    — Cloudflare KV 바인딩 (백업, 영속·글로벌)
 *     3순위: Upstash    — 외부 Redis REST API (선택적 백업, 바인딩 있을 때만)
 *     4순위: L1 메모리  — 인스턴스 메모리, TTL 30초 (초고속, 비영속)
 *     5순위: L4 메모리  — 인스턴스 메모리, TTL 없음 (최후 안전망, 비영속)
 *
 *   쓰기 (동시 쓰기, 하나가 실패해도 나머지는 계속 진행):
 *     DO Redis + SLUG_KV + Upstash(있으면) + L1 + L4 모두에 동시 기록.
 *     → 어느 한 계층이 죽어도 나머지로 즉시 폴백되는 다중 이중화 구조.
 *
 *   주의: L1/L4는 100% 자체 구현한 순수 메모리 NoSQL 엔진이며,
 *   Workers 인스턴스가 재시작되면 사라지는 비영속 계층입니다.
 *   진짜 영속성은 DO Redis / SLUG_KV / Upstash 중 살아있는 계층이 보장합니다.
 *
 *   키 스킴:
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

import {
  doRedisAvailable, doRedisGet, doRedisSet, doRedisDel, doRedisScanAll,
  doRedisLPush as doLPush, doRedisLRange as doLRange, doRedisLTrim as doLTrim,
} from './redis-do.js';

// ── 3순위: L1 메모리 캐시 (인스턴스 수명 동안 유효, TTL=30초) ────────
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
function l1del(key) {
  _l1.delete(key);
}
function l1scanPrefix(prefix) {
  const out = [];
  const now = Date.now();
  for (const [k, e] of _l1.entries()) {
    if (now > e.exp) { _l1.delete(k); continue; }
    if (k.startsWith(prefix)) out.push(k);
  }
  return out;
}

// ── 4순위: L4 메모리 (TTL 없음, 인스턴스 생존 기간 내 영속) ──────────
// SLUG_KV와 Redis가 둘 다 실패했을 때의 최후 안전망.
// 100% 자체 구현한 순수 JS 메모리 NoSQL — 외부 의존성 전혀 없음.
// 인스턴스가 재시작/재배포되면 초기화되지만, 같은 인스턴스가 살아있는 동안은
// L1(30초)보다 훨씬 오래 데이터를 보존한다 (자체 만료 타임스탬프로 관리).
const _l4 = new Map();

function l4get(key) {
  const e = _l4.get(key);
  if (!e) return undefined;
  if (e.exp && Date.now() > e.exp) { _l4.delete(key); return undefined; }
  return e.val;
}
function l4set(key, val, ttlSec = 0) {
  _l4.set(key, { val, exp: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
}
function l4del(key) {
  _l4.delete(key);
}
function l4scanPrefix(prefix) {
  const out = [];
  const now = Date.now();
  for (const [k, e] of _l4.entries()) {
    if (e.exp && now > e.exp) { _l4.delete(k); continue; }
    if (k.startsWith(prefix)) out.push(k);
  }
  return out;
}

// ── 1순위: Cloudflare KV (SLUG_KV 바인딩) ────────────────────────────
function hasKv(env) {
  return !!(env && env.SLUG_KV && typeof env.SLUG_KV.get === 'function');
}

async function kvNativeGet(env, key) {
  if (!hasKv(env)) return null;
  try { return await env.SLUG_KV.get(key); } catch (_) { return null; }
}
async function kvNativePut(env, key, value, ttlSec = 0) {
  if (!hasKv(env)) return false;
  try {
    const opts = {};
    // Cloudflare KV: expirationTtl은 60초 이상만 허용
    if (ttlSec >= 60) opts.expirationTtl = ttlSec;
    await env.SLUG_KV.put(key, value, opts);
    return true;
  } catch (_) { return false; }
}
async function kvNativeDelete(env, key) {
  if (!hasKv(env)) return false;
  try { await env.SLUG_KV.delete(key); return true; } catch (_) { return false; }
}
async function kvNativeList(env, prefix, limit = 100) {
  if (!hasKv(env)) return [];
  try {
    const res = await env.SLUG_KV.list({ prefix, limit });
    return (res?.keys || []).map(k => k.name);
  } catch (_) { return []; }
}

// ── 2순위: Upstash Redis REST API 래퍼 ───────────────────────────────
function hasRedis(env) {
  return !!(env && env.UPSTASH_REDIS_URL && env.UPSTASH_REDIS_TOKEN);
}

async function redisCmd(env, ...args) {
  if (!hasRedis(env)) return null;
  const url   = env.UPSTASH_REDIS_URL;
  const token = env.UPSTASH_REDIS_TOKEN;

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

async function redisGet(env, key) {
  return redisCmd(env, 'GET', key);
}
async function redisSet(env, key, value, ttlSec = 0) {
  if (ttlSec > 0) return redisCmd(env, 'SET', key, value, 'EX', ttlSec);
  return redisCmd(env, 'SET', key, value);
}
async function redisDel(env, key) {
  return redisCmd(env, 'DEL', key);
}
async function redisScan(env, pattern, count = 100) {
  const keys = await redisCmd(env, 'SCAN', '0', 'MATCH', pattern, 'COUNT', count);
  if (!keys || !Array.isArray(keys)) return [];
  return keys[1] || [];
}

// ── 통합 KV 연산: 1(DO Redis)→2(KV)→3(Upstash)→4(L1)→5(L4) 순차 읽기 / 전체 동시 쓰기 ──
export async function kvGet(env, key) {
  // 1순위: 자체 제작 DO Redis
  if (doRedisAvailable(env)) {
    const fromDo = await doRedisGet(env, key);
    if (fromDo !== null && fromDo !== undefined) {
      l1set(key, fromDo);
      l4set(key, fromDo);
      return fromDo;
    }
  }

  // 2순위: SLUG_KV
  const fromKv = await kvNativeGet(env, key);
  if (fromKv !== null && fromKv !== undefined) {
    l1set(key, fromKv);
    l4set(key, fromKv);
    return fromKv;
  }

  // 3순위: Upstash Redis (선택적 백업 — 바인딩 없으면 자동 스킵)
  const fromRedis = await redisGet(env, key);
  if (fromRedis !== null && fromRedis !== undefined) {
    l1set(key, fromRedis);
    l4set(key, fromRedis);
    return fromRedis;
  }

  // 4순위: L1 메모리 (초고속, 30초 TTL)
  const fromL1 = l1get(key);
  if (fromL1 !== undefined) return fromL1;

  // 5순위: L4 메모리 (최후 안전망)
  const fromL4 = l4get(key);
  if (fromL4 !== undefined) return fromL4;

  return null;
}

export async function kvSet(env, key, value, ttlSec = 0) {
  // 모든 영속 계층에 동시 쓰기 — 일부 실패해도 나머지는 계속 진행
  const writes = [
    doRedisAvailable(env) ? doRedisSet(env, key, value, ttlSec) : Promise.resolve(false),
    kvNativePut(env, key, value, ttlSec),
    redisSet(env, key, value, ttlSec),
  ];
  const results = await Promise.allSettled(writes);
  l1set(key, value, ttlSec > 0 ? Math.min(ttlSec * 1000, L1_TTL_MS) : L1_TTL_MS);
  l4set(key, value, ttlSec);

  const doOk    = results[0].status === 'fulfilled' && results[0].value === true;
  const kvOk    = results[1].status === 'fulfilled' && results[1].value === true;
  const redisOk = results[2].status === 'fulfilled' && results[2].value !== null && results[2].value !== false;
  return doOk || kvOk || redisOk; // 영속 계층 중 하나라도 성공하면 true
}

export async function kvDel(env, key) {
  l1del(key);
  l4del(key);
  const results = await Promise.allSettled([
    doRedisAvailable(env) ? doRedisDel(env, key) : Promise.resolve(false),
    kvNativeDelete(env, key),
    redisDel(env, key),
  ]);
  return results.some(r => r.status === 'fulfilled' && r.value);
}

export async function kvGetJson(env, key) {
  const raw = await kvGet(env, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

export async function kvSetJson(env, key, obj, ttlSec = 0) {
  return kvSet(env, key, JSON.stringify(obj), ttlSec);
}

// 키 목록 스캔: DO Redis → SLUG_KV → Upstash → L1 → L4 순으로 합쳐서 중복 제거
export async function kvScan(env, pattern, count = 100) {
  // SLUG_KV.list()는 정확 일치 패턴이 아니라 prefix만 지원하므로,
  // 'slug:origin:*' 같은 패턴에서 '*' 앞부분을 prefix로 사용
  const prefix = pattern.replace(/\*+$/, '');

  const [doKeys, kvKeys, redisKeys] = await Promise.all([
    doRedisAvailable(env) ? doRedisScanAll(env, prefix, count) : Promise.resolve([]),
    kvNativeList(env, prefix, count),
    redisScan(env, pattern, count),
  ]);

  const memKeys = [...l1scanPrefix(prefix), ...l4scanPrefix(prefix)];

  const merged = new Set([...doKeys, ...kvKeys, ...redisKeys, ...memKeys]);
  return Array.from(merged).slice(0, count);
}

// ── CNAME 캐시 (메모리 전용 — 24h TTL, 자주 안 바뀌는 값이라 메모리로 충분) ─
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

// ── 레이트 리밋 (메모리, 1분 윈도우) ──────────────────────────────────
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

// ── 메트릭 (메모리 — 재시작시 리셋 허용) ──────────────────────────────
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

// ── 슬러그 영속 스토리지 ───────────────────────────────────────────────
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

// ── 차단 IP 관리 ───────────────────────────────────────────────────────
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

// ── 지역별 캐시 상태 ───────────────────────────────────────────────────
export async function regionCacheSet(env, region, data) {
  return kvSetJson(env, 'state:region:' + region, { ...data, updatedAt: Date.now() });
}
export async function regionCacheGet(env, region) {
  return kvGetJson(env, 'state:region:' + region);
}

// ── 워커 인스턴스 상태 등록 ────────────────────────────────────────────
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

// ── 사이트맵 / RSS 저장 ────────────────────────────────────────────────
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

// ── 스키마 마크업 캐시 ─────────────────────────────────────────────────
export async function schemaGet(env, hash) {
  return kvGetJson(env, 'schema:' + hash);
}
export async function schemaPut(env, hash, schema, ttlSec = 14400) {
  return kvSetJson(env, 'schema:' + hash, schema, ttlSec);
}

// ── 분석 이벤트 기록 ───────────────────────────────────────────────────
// 리스트 연산(LPUSH/LTRIM)은 KV에 대응 개념이 없으므로
// 1순위 DO Redis → 2순위 Upstash → 3순위 L4 메모리 순으로 폴백.
const ANALYTICS_KEY = 'analytics:events';
const ANALYTICS_MAX = 10000;

export async function recordAnalytics(env, event) {
  const entry = JSON.stringify({ ...event, ts: Date.now() });

  if (doRedisAvailable(env)) {
    await doLPush(env, ANALYTICS_KEY, entry);
    await doLTrim(env, ANALYTICS_KEY, 0, ANALYTICS_MAX - 1);
    return;
  }

  if (hasRedis(env)) {
    await redisCmd(env, 'LPUSH', ANALYTICS_KEY, entry);
    await redisCmd(env, 'LTRIM', ANALYTICS_KEY, 0, ANALYTICS_MAX - 1);
    return;
  }

  // 영속 Redis가 전혀 없을 때 자체 메모리 리스트 폴백 (L4)
  const list = l4get(ANALYTICS_KEY) || [];
  list.unshift(entry);
  if (list.length > ANALYTICS_MAX) list.length = ANALYTICS_MAX;
  l4set(ANALYTICS_KEY, list);
}

export async function getAnalytics(env, count = 100) {
  if (doRedisAvailable(env)) {
    const items = await doLRange(env, ANALYTICS_KEY, 0, count - 1);
    if (Array.isArray(items) && items.length) {
      return items.map(i => { try { return JSON.parse(i); } catch (_) { return null; } }).filter(Boolean);
    }
  }

  if (hasRedis(env)) {
    const items = await redisCmd(env, 'LRANGE', ANALYTICS_KEY, 0, count - 1);
    if (Array.isArray(items)) {
      return items.map(i => { try { return JSON.parse(i); } catch (_) { return null; } }).filter(Boolean);
    }
  }

  const list = l4get(ANALYTICS_KEY) || [];
  return list.slice(0, count).map(i => { try { return JSON.parse(i); } catch (_) { return null; } }).filter(Boolean);
}

// ── 자체 제작 Redis(DO) 클러스터 관리 — 관리 패널 "Redis 관리" 탭에서 사용 ─────
export { doRedisAvailable, doRedisClusterStats, doRedisFlushAll } from './redis-do.js';
