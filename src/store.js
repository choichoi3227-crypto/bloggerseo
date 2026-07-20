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
 *       slug:origin:{host}:{path} → JSON (슬러그 원본 경로, 사이트별 격리)
 *       slug:alias:{host}:{path}  → string (슬러그 별칭, 사이트별 격리)
 *       cache:{hash}              → JSON (Cache Reserve 항목)
 *       schema:{hash}             → JSON (스키마 마크업 캐시)
 *       state:block:{ip}          → 1 (차단 IP)
 *       state:region:{region}     → JSON (지역별 캐시 통계)
 *       state:worker:{id}         → JSON (워커 인스턴스 상태)
 *       sitemap:index:{host}      → XML (사이트별 격리)
 *       rss:feed:{host}           → XML (사이트별 격리)
 *
 *   [버그 수정] 이전에는 slug:origin:/slug:alias:/sitemap:index/rss:feed가
 *   전부 호스트 구분 없는 단일 전역 키였다. 이 Worker 하나가 여러 개인
 *   도메인(Blogspot 사이트)을 동시에 서빙하는 구조이기 때문에, 사이트 A의
 *   슬러그가 사이트 B의 사이트맵/RSS에 섞여 들어가고, 사이트맵/RSS 캐시도
 *   전역 키 하나만 있어 어느 사이트가 요청하든 같은(가장 최근에 생성된)
 *   결과를 받게 되는 문제가 있었다. 이제 모든 관련 키에 host를 포함시켜
 *   사이트별로 완전히 독립적으로 저장·조회되도록 한다.
 */

import {
  doRedisAvailable, doRedisGet, doRedisSet, doRedisDel, doRedisScanAll,
  doRedisLPush as doLPush, doRedisLRange as doLRange, doRedisLTrim as doLTrim,
} from './redis-do.js';

// ── 3순위: L1 메모리 캐시 (인스턴스 수명 동안 유효, TTL=30초) ────────
const _l1 = new Map();
const L1_TTL_MS = 30_000;
// ✅ [에러 방지 장치] 이 Map은 _doWriteThrottle/_slugLookupCache와 달리
// 크기 상한이 없었다. 트래픽이 다양한 키(예: 서로 다른 게시물 경로가
// 매우 많은 대형 블로그)로 계속 들어오면 하나의 Worker 인스턴스가
// 재시작 없이 오래 살아있는 동안 이 Map이 무한정 커져 메모리 사용량이
// 계속 늘어날 수 있었다(OOM으로 인스턴스가 강제 종료되면 그 순간 처리
// 중이던 요청들이 실패하는 형태로 나타난다). 다른 인스턴스 캐시들과
// 동일한 상한/청소 패턴을 적용한다.
const L1_MAX_SIZE = 5000;

function l1EvictIfNeeded() {
  if (_l1.size <= L1_MAX_SIZE) return;
  const now = Date.now();
  // 1차: 만료된 항목부터 제거
  for (const [k, e] of _l1) {
    if (now > e.exp) _l1.delete(k);
    if (_l1.size <= L1_MAX_SIZE) return;
  }
  // 2차: 그래도 초과하면 Map 삽입 순서(가장 오래된 것)부터 강제 제거
  while (_l1.size > L1_MAX_SIZE) {
    const oldestKey = _l1.keys().next().value;
    if (oldestKey === undefined) break;
    _l1.delete(oldestKey);
  }
}

function l1get(key) {
  const e = _l1.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { _l1.delete(key); return undefined; }
  return e.val;
}
function l1set(key, val, ttlMs = L1_TTL_MS) {
  _l1.set(key, { val, exp: Date.now() + ttlMs });
  l1EvictIfNeeded();
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
// ✅ [에러 방지 장치] L1과 동일한 이유로 상한을 둔다. L4는 slug:* 매핑처럼
// 최대 30일 TTL을 가질 수 있는 데이터의 최후 폴백 계층이라 L1보다 상한을
// 넉넉하게 잡아 실사용 중 조기 축출로 인한 캐시 미스 증가를 최소화한다.
const L4_MAX_SIZE = 20000;

function l4EvictIfNeeded() {
  if (_l4.size <= L4_MAX_SIZE) return;
  const now = Date.now();
  for (const [k, e] of _l4) {
    if (e.exp && now > e.exp) _l4.delete(k);
    if (_l4.size <= L4_MAX_SIZE) return;
  }
  while (_l4.size > L4_MAX_SIZE) {
    const oldestKey = _l4.keys().next().value;
    if (oldestKey === undefined) break;
    _l4.delete(oldestKey);
  }
}

function l4get(key) {
  const e = _l4.get(key);
  if (!e) return undefined;
  if (e.exp && Date.now() > e.exp) { _l4.delete(key); return undefined; }
  return e.val;
}
function l4set(key, val, ttlSec = 0) {
  _l4.set(key, { val, exp: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
  l4EvictIfNeeded();
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

// ── 통합 KV 연산 ──────────────────────────────────────────────────────
// [v7.1 변경] 기존에는 DO Redis→KV→Upstash를 순차로 await했는데, 이러면
// 캐시 MISS(키가 어디에도 없음)일 때마다 최대 3단계 네트워크 왕복이
// 직렬로 쌓여 레이턴시가 크게 늘어났다. 이제는:
//   1. L1 메모리를 먼저 확인 (0ms, 동기) — 있으면 즉시 반환
//   2. 영속 계층(DO Redis / KV / Upstash)을 모두 "동시에" 호출해서
//      가장 먼저 도착한 유효 값을 채택 (순차 대기 제거)
//   3. 영속 계층이 전부 비어있거나 실패하면 L4 메모리로 최후 폴백
// ── 데이터 최대 보유 기간 제한 (최대 1시간, 단 슬러그 매핑은 예외) ───────
// [버그 수정] 이전에는 slug:origin:*/slug:alias:* 매핑도 다른 캐시성 데이터와
// 동일하게 "무제한 요청 시 1시간으로 캡"이 적용됐다. 문제는 upsertSlug()가
// 슬러그 값이 실제로 바뀌지 않으면 재저장(TTL 갱신)을 하지 않고, 별칭(alias)
// 조회는 읽기 전용이라 TTL을 갱신할 방법이 없었다는 점이다. 그 결과 사람들이
// 제목 슬러그 URL로만 계속 방문해도 그 매핑은 정확히 1시간 뒤 스토리지에서
// 자동 소멸했고, 이후 같은 슬러그 URL 방문은 매핑을 찾지 못해 passthrough로
// 떨어져 Blogger에 존재하지 않는 경로로 요청이 가서 사실상 404가 났다.
// 슬러그 매핑은 글이 삭제/제목 변경되기 전까지 사실상 영구적이어야 하는
// 데이터이므로, cache:* 등 진짜 일시적 데이터와 분리해 훨씬 긴 상한(30일)을
// 적용한다.
// ✅ [슬러그 로직 재설계] 이전에는 시간당 전체 재스캔(runSlugAudit)이 모든
// slug:* 매핑을 값 변경 여부와 무관하게 주기적으로 다시 써서 TTL을
// 갱신했다. 이는 "발행 시 1회 확정, 이후 조회만" 원칙과 맞지 않아 제거
// 했다. 이제 TTL 갱신은 오직 실제 방문이 그 슬러그를 조회할 때만
// (resolveSlugRoute → touchSlug, worker.js) 저비용으로 일어난다. 즉 30일간
// 아무도 방문하지 않은 글의 매핑만 자연 소멸하며, 실제로 트래픽이 있는
// 글은 방문 자체가 TTL을 계속 연장한다.
const MAX_DATA_TTL_SEC = 3600;              // 1시간 — cache:/schema: 등 일시적 데이터
const SLUG_MAX_TTL_SEC = 30 * 24 * 3600;    // 30일 — slug:* 매핑 (실제 방문 시에만 갱신)
const BPADMIN_SESSION_MAX_TTL_SEC = 30 * 24 * 3600; // 30일 — bp-admin 로그인 세션(자동 로그인 유지)

function clampTtlForKey(key, ttlSec) {
  const k = typeof key === 'string' ? key : String(key ?? '');
  const cap = k.startsWith('slug:') ? SLUG_MAX_TTL_SEC
    : k.startsWith('bpadmin:session:') ? BPADMIN_SESSION_MAX_TTL_SEC
    : MAX_DATA_TTL_SEC;
  if (!ttlSec || ttlSec <= 0) return cap;
  return Math.min(ttlSec, cap);
}

// ── DO 호출 쓰로틀 (분당 요청 폭증 방지) ─────────────────────────────
// DO는 고비용 바인딩이므로, 같은 키를 짧은 시간 안에 반복 조회할 때
// L1 메모리로 막아서 DO RPC 횟수를 극적으로 줄인다.
// 읽기 쓰로틀: L1 히트 시 DO 완전 건너뜀 (이미 위에서 처리)
// 쓰기 쓰로틀: 같은 키에 대해 DO 쓰기를 5초에 1회로 제한
const _doWriteThrottle = new Map(); // key → lastDoWriteTs
const DO_WRITE_THROTTLE_MS = 5000; // 5초

function shouldWriteToDo(key) {
  const last = _doWriteThrottle.get(key) || 0;
  const now  = Date.now();
  if (now - last < DO_WRITE_THROTTLE_MS) return false;
  _doWriteThrottle.set(key, now);
  // 오래된 항목 정리 (메모리 누수 방지)
  if (_doWriteThrottle.size > 5000) {
    const cutoff = now - DO_WRITE_THROTTLE_MS * 10;
    for (const [k, ts] of _doWriteThrottle) {
      if (ts < cutoff) _doWriteThrottle.delete(k);
    }
  }
  return true;
}

// ── 키 분류: slug/state 키는 DO 우선, cache 키는 KV 우선 ────────────
// DO는 slug/state 등 쓰기 빈도가 낮고 일관성이 중요한 데이터에 집중
// cache 키는 KV(글로벌 저지연)로 보내 DO 부하 최소화
function preferKvFirst(key) {
  // ✅ [에러 방지 장치] key가 문자열이 아니면 startsWith 호출 자체가
  // TypeError로 죽는다. 호출부 실수(숫자/undefined를 key로 전달)로부터
  // kvGet/kvSet 전체가 죽는 것을 막기 위해 방어적으로 문자열 변환한다.
  const k = typeof key === 'string' ? key : String(key ?? '');
  return k.startsWith('cache:') || k.startsWith('schema:') ||
         k.startsWith('sitemap:') || k.startsWith('rss:');
}

export async function kvGet(env, key) {
  // L1 메모리 (동기, 0ms) — DO 호출 없이 즉시 반환
  const fromL1 = l1get(key);
  if (fromL1 !== undefined) return fromL1;

  // 키 유형에 따라 조회 순서 결정:
  //   cache/schema/sitemap/rss → KV 먼저 (저지연 글로벌), DO 건너뜀
  //   slug/state              → DO 먼저 (일관성 중요), KV 폴백
  let value = null;

  if (preferKvFirst(key)) {
    // 1순위: KV
    value = await kvNativeGet(env, key).catch(() => null);
    // 2순위: Upstash (KV 미스 시만)
    if (value === null) value = await redisGet(env, key).catch(() => null);
    // 3순위: DO (최후 — 고비용이므로 마지막)
    if (value === null && doRedisAvailable(env)) {
      value = await doRedisGet(env, key).catch(() => null);
    }
  } else {
    // 1순위: DO Redis (slug/state 데이터 — 일관성 우선)
    if (doRedisAvailable(env)) {
      value = await doRedisGet(env, key).catch(() => null);
    }
    // 2순위: KV 폴백
    if (value === null) value = await kvNativeGet(env, key).catch(() => null);
    // 3순위: Upstash 폴백
    if (value === null) value = await redisGet(env, key).catch(() => null);
  }

  if (value !== null && value !== undefined) {
    l1set(key, value);
    l4set(key, value);
    return value;
  }

  // 최후 폴백: L4 메모리
  const fromL4 = l4get(key);
  if (fromL4 !== undefined) return fromL4;

  return null;
}

export async function kvSet(env, key, value, ttlSec = 0) {
  // slug:* 키는 30일, 그 외(cache/schema 등)는 1시간으로 캡핑
  const effectiveTtl = clampTtlForKey(key, ttlSec);

  // 메모리 계층은 항상 즉시 갱신
  l1set(key, value, Math.min(effectiveTtl * 1000, L1_TTL_MS));
  l4set(key, value, effectiveTtl);

  if (preferKvFirst(key)) {
    // cache/schema 등: KV + Upstash 동시 쓰기, DO는 쓰로틀 적용
    const writes = [
      kvNativePut(env, key, value, effectiveTtl),
      redisSet(env, key, value, effectiveTtl),
    ];
    // DO는 쓰로틀 통과 시에만 비동기 백그라운드 쓰기 (응답 블로킹 없음)
    if (doRedisAvailable(env) && shouldWriteToDo(key)) {
      writes.push(doRedisSet(env, key, value, effectiveTtl));
    }
    const results = await Promise.allSettled(writes);
    return results.some(r => r.status === 'fulfilled' && r.value);
  } else {
    // slug/state: DO 우선 + KV 동시 (Upstash는 선택적 추가 백업)
    const doWrite  = doRedisAvailable(env) && shouldWriteToDo(key)
                      ? doRedisSet(env, key, value, effectiveTtl)
                      : Promise.resolve(false);
    const kvWrite  = kvNativePut(env, key, value, effectiveTtl);
    const upWrite  = redisSet(env, key, value, effectiveTtl);
    const results  = await Promise.allSettled([doWrite, kvWrite, upWrite]);
    const doOk     = results[0].status === 'fulfilled' && results[0].value === true;
    const kvOk     = results[1].status === 'fulfilled' && results[1].value === true;
    const upOk     = results[2].status === 'fulfilled' && results[2].value !== null;
    return doOk || kvOk || upOk;
  }
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
  // ✅ [에러 방지 장치] pattern이 문자열이 아니면 .replace 호출이 즉시
  // TypeError로 죽는다.
  const patternStr = typeof pattern === 'string' ? pattern : String(pattern ?? '');
  // SLUG_KV.list()는 정확 일치 패턴이 아니라 prefix만 지원하므로,
  // 'slug:origin:*' 같은 패턴에서 '*' 앞부분을 prefix로 사용
  const prefix = patternStr.replace(/\*+$/, '');

  const [doKeys, kvKeys, redisKeys] = await Promise.all([
    doRedisAvailable(env) ? doRedisScanAll(env, prefix, count) : Promise.resolve([]),
    kvNativeList(env, prefix, count),
    redisScan(env, patternStr, count),
  ]);

  const memKeys = [...l1scanPrefix(prefix), ...l4scanPrefix(prefix)];

  const merged = new Set([...doKeys, ...kvKeys, ...redisKeys, ...memKeys]);
  return Array.from(merged).slice(0, count);
}

// ── CNAME 캐시 (메모리 전용 — 24h TTL, 자주 안 바뀌는 값이라 메모리로 충분) ─
const _cnameCache = new Map();
const CNAME_MEM_TTL = 24 * 3600 * 1000;
// ✅ [에러 방지 장치] 이 Worker는 다수의 커스텀 도메인(테넌트)을 동시에
// 서빙하는 멀티테넌트 구조라, 테넌트 수가 많은 배포에서는 이 Map도
// 무한정 커질 수 있었다. 다른 인스턴스 캐시와 동일한 상한을 적용한다.
const CNAME_MAX_SIZE = 2000;

export function cnameGet(host) {
  const e = _cnameCache.get(host);
  if (!e) return null;
  if (Date.now() - e.ts > CNAME_MEM_TTL) { _cnameCache.delete(host); return null; }
  return e.ok;
}
export function cnameSet(host, ok) {
  _cnameCache.set(host, { ok, ts: Date.now() });
  if (_cnameCache.size > CNAME_MAX_SIZE) {
    const now = Date.now();
    for (const [k, e] of _cnameCache) {
      if (now - e.ts > CNAME_MEM_TTL) _cnameCache.delete(k);
      if (_cnameCache.size <= CNAME_MAX_SIZE) break;
    }
    while (_cnameCache.size > CNAME_MAX_SIZE) {
      const oldest = _cnameCache.keys().next().value;
      if (oldest === undefined) break;
      _cnameCache.delete(oldest);
    }
  }
}

// ── 레이트 리밋 (메모리, 1분 윈도우) ──────────────────────────────────
const _rateLimit   = new Map();
const RL_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_SIZE = 2000; // 동시 활성 테넌트 호스트 수 상한

export function checkRateLimit(host, limitPerMin = 600) {
  const now = Date.now();
  let b = _rateLimit.get(host);
  if (!b || now - b.windowStart > RL_WINDOW_MS) b = { count: 0, windowStart: now };
  b.count++;
  _rateLimit.set(host, b);
  // ✅ [에러 방지 장치] 활성 윈도우가 지난 오래된 host 항목부터 정리해
  // 이 Map도 테넌트 수 증가에 따라 무한정 커지지 않도록 한다.
  if (_rateLimit.size > RATE_LIMIT_MAX_SIZE) {
    for (const [k, e] of _rateLimit) {
      if (now - e.windowStart > RL_WINDOW_MS) _rateLimit.delete(k);
      if (_rateLimit.size <= RATE_LIMIT_MAX_SIZE) break;
    }
  }
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

// ── 슬러그 조회 전용 초고속 캐시 (히트 + 네거티브 모두 캐싱) ─────────────
// resolveSlugRoute()가 "모든 요청마다" slugOriginGet/slugAliasGet을 호출하는데,
// 기존 구조에서는 slug:* 키가 DO(Durable Object)를 1순위로 조회해서 매 요청마다
// 네트워크 왕복이 하나 더 붙어 전체 응답이 느려지는 원인이었다.
// 여기서는 짧은 TTL(5초)로 "값이 있음"과 "매핑이 없음(네거티브)"을 모두
// 인스턴스 메모리에 캐싱해서, 같은 인스턴스에서 반복되는 조회는 DO/KV
// 왕복 없이 즉시 반환되게 한다. TTL이 짧아 신규 슬러그 반영 지연은 최대 5초.
const _slugLookupCache = new Map(); // key → { val, exp }
const SLUG_LOOKUP_TTL_MS = 5_000;
const SLUG_NEGATIVE = Symbol('slug-miss');

function slugCacheGet(key) {
  const e = _slugLookupCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { _slugLookupCache.delete(key); return undefined; }
  return e.val;
}
function slugCacheSet(key, val) {
  _slugLookupCache.set(key, { val, exp: Date.now() + SLUG_LOOKUP_TTL_MS });
  if (_slugLookupCache.size > 5000) {
    const now = Date.now();
    for (const [k, e] of _slugLookupCache) if (now > e.exp) _slugLookupCache.delete(k);
  }
}
function slugCacheInvalidate(key) {
  _slugLookupCache.delete(key);
}

// ── 사이트(host) 키 정규화 ─────────────────────────────────────────────
// 슬러그/사이트맵/RSS 키에 host를 섞어 넣기 전에 항상 이 함수를 거쳐서
// 대소문자·프로토콜·트레일링 슬래시 차이로 같은 사이트가 다른 키로
// 갈라지는 일이 없게 한다. host가 없으면 'default'로 묶어 완전히 깨지는
// 것보다는 최소한 하나의 격리된 버킷으로라도 동작하게 한다.
export function normalizeSiteKey(host) {
  if (!host) return 'default';
  return String(host)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim() || 'default';
}

// ── 슬러그 영속 스토리지 (사이트별 격리) ───────────────────────────────
// [버그 수정] originPath/titlePath만으로 키를 만들면 서로 다른 사이트의
// 글이 같은 키로 충돌하고, 사이트맵/RSS 생성기가 "이 사이트의 글"만
// 골라낼 방법이 없었다. 이제 host를 키에 포함해 사이트별로 완전히
// 분리 저장한다.
export async function slugOriginGet(env, host, originPath) {
  const site = normalizeSiteKey(host);
  const cacheKey = 'slug:origin:' + site + ':' + originPath;
  const cached = slugCacheGet(cacheKey);
  if (cached !== undefined) return cached === SLUG_NEGATIVE ? null : cached;

  const val = await kvGetJson(env, cacheKey);
  slugCacheSet(cacheKey, val === null ? SLUG_NEGATIVE : val);
  return val;
}
export async function slugAliasGet(env, host, titlePath) {
  const site = normalizeSiteKey(host);
  const cacheKey = 'slug:alias:' + site + ':' + titlePath;
  const cached = slugCacheGet(cacheKey);
  if (cached !== undefined) return cached === SLUG_NEGATIVE ? null : cached;

  const val = await kvGet(env, cacheKey);
  slugCacheSet(cacheKey, val === null || val === undefined ? SLUG_NEGATIVE : val);
  return val ?? null;
}
// [v9] 리디렉션 과다 수정: 이전에는 쓰기 후 로컬 캐시를 "무효화"만 했다.
// Cloudflare KV는 최종 일관성(eventual consistency) 스토리지라서 쓰기
// 직후 같은 요청 파이프라인 안에서 바로 읽어도 새 값이 안 보일 수 있는데,
// 그 순간 다른 요청이 먼저 조회해 버리면 negative(없음)로 캐싱되어 최대
// 5초간 "방금 만든 슬러그가 존재하지 않는" 것처럼 보였다. 이게 슬러그
// 확정 직후 리디렉션이 튀는(원본↔슬러그를 오가는) 현상의 핵심 원인이었다.
// 이제는 무효화 대신 write-through로 새 값을 즉시 로컬 캐시에 채워서,
// KV 전파가 끝나기 전에도 같은 Isolate에서는 항상 최신 값을 보게 한다.
export async function slugOriginPut(env, host, originPath, data) {
  const site = normalizeSiteKey(host);
  slugCacheSet('slug:origin:' + site + ':' + originPath, data);
  return kvSetJson(env, 'slug:origin:' + site + ':' + originPath, data);
}
export async function slugAliasPut(env, host, titlePath, originPath) {
  const site = normalizeSiteKey(host);
  slugCacheSet('slug:alias:' + site + ':' + titlePath, originPath);
  return kvSet(env, 'slug:alias:' + site + ':' + titlePath, originPath);
}
export async function slugAliasDelete(env, host, titlePath) {
  const site = normalizeSiteKey(host);
  // 삭제는 진짜로 "없음" 상태이므로 negative로 캐싱해 즉시 반영한다.
  slugCacheSet('slug:alias:' + site + ':' + titlePath, SLUG_NEGATIVE);
  return kvDel(env, 'slug:alias:' + site + ':' + titlePath);
}

export async function upsertSlug(env, host, originPath, title, titleSlug) {
  if (!title || !titleSlug) return;
  const titlePath = '/' + titleSlug;
  const existing  = await slugOriginGet(env, host, originPath);
  const now       = Date.now();

  if (!existing) {
    await slugOriginPut(env, host, originPath, { title, titleSlug, titlePath, createdAt: now, checkedAt: now });
    await slugAliasPut(env, host, titlePath, originPath);
  } else if (existing.titlePath !== titlePath) {
    await slugAliasDelete(env, host, existing.titlePath);
    await slugAliasPut(env, host, titlePath, originPath);
    await slugOriginPut(env, host, originPath, { ...existing, title, titleSlug, titlePath, checkedAt: now });
  }
}

// ── 슬러그 매핑 TTL 갱신(touch) — 값이 안 바뀌어도 만료 시점을 늦춤 ────
// slug:* 키의 저장 상한은 30일이다(clampTtlForKey). 이 함수는 더 이상
// 시간당 전체 재스캔에서 호출되지 않는다(그 기능은 제거됨) — 대신
// worker.js의 resolveSlugRoute()가 캐시 미스 시 실제로 조회된 슬러그에
// 대해서만 이 함수를 호출한다. 즉 "발행 시 1회 확정 + 실제 방문 시에만
// TTL 연장"이 되어, 트래픽이 있는 글의 매핑은 방문 자체로 계속 살아있고
// 아무도 찾지 않는 매핑만 30일 후 자연 소멸한다.
export async function touchSlug(env, host, originPath, existing) {
  if (!existing?.titlePath) return;
  await slugOriginPut(env, host, originPath, { ...existing, checkedAt: Date.now() });
  await slugAliasPut(env, host, existing.titlePath, originPath);
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

// ── 사이트맵 / RSS 저장 (사이트별 격리) ─────────────────────────────────
// [버그 수정] 이전에는 'sitemap:index' / 'rss:feed' 라는 단일 전역 키에
// 모든 사이트의 결과를 덮어썼다. 그 결과 어느 사이트가 /sitemap.xml을
// 요청하든 "가장 최근에 생성된" (사실상 무작위) 사이트의 캐시를 그대로
// 받아버렸다. host를 키에 포함해 사이트별로 독립적으로 캐싱한다.
export async function saveSitemap(env, xml, host) {
  const site = normalizeSiteKey(host);
  return kvSet(env, 'sitemap:index:' + site, xml, 7200); // 2시간 TTL
}
export async function getSitemap(env, host) {
  const site = normalizeSiteKey(host);
  return kvGet(env, 'sitemap:index:' + site);
}
export async function saveRss(env, xml, host) {
  const site = normalizeSiteKey(host);
  return kvSet(env, 'rss:feed:' + site, xml, 3600); // 1시간 TTL
}
export async function getRss(env, host) {
  const site = normalizeSiteKey(host);
  return kvGet(env, 'rss:feed:' + site);
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
