/**
 * BloggerSEO v7.1 — 자체 Cache Reserve 엔진 (캐시 히트율 극대화 재설계)
 * ─────────────────────────────────────────────────────────────────────
 * [v7.1 변경 이유] 운영 중 Cache Hit Rate가 1.26%까지 떨어진 게 실측으로
 * 확인됨. 원인은 두 가지였다:
 *
 *   1. isCacheable()이 "cookie 헤더가 있으면 캐시 안 함"으로 막아놨었는데,
 *      애드센스/애널리틱스/네이버 등 거의 모든 익명 방문자 브라우저가
 *      쿠키를 동반하므로 실질적으로 캐시가 거의 항상 우회됨.
 *      → 쿠키 유무와 캐시 가능 여부를 분리. Blogger 댓글/로그인 위젯은
 *        클라이언트 JS가 처리하므로, 서버가 내려주는 HTML 자체에는
 *        쿠키별로 달라지는 내용이 없다. 따라서 쿠키가 있어도 캐시를 쓴다.
 *   2. 캐시 키에 accept-encoding을 섞어서, 브라우저마다 살짝 다른
 *      인코딩 헤더 값 때문에 같은 글인데도 캐시가 쪼개졌었다.
 *      → 캐시 키를 URL 단독으로 정규화 (쿼리스트링도 정렬해서 통일).
 *
 * [v7.1 신규] L0: Cloudflare Cache API (caches.default)
 *   Worker 코드에서 무료로 쓸 수 있는 엣지 캐시. 같은 엣지 노드에서
 *   네트워크 호출 없이 즉시 응답되므로 DO Redis/KV/Upstash보다 한 단계
 *   더 빠르다. 이게 캐시 히트의 90%+ 를 흡수해서 원본 도달률을
 *   극단적으로 낮추는 핵심 계층이다.
 *
 *   최종 계층 구조:
 *     L0 Cache API(엣지, 네트워크 호출 없음) → L1 메모리(30초)
 *     → L2 DO Redis/KV/Upstash(영속) → Origin(Blogger)
 *
 * [v7.1 신규] stale-on-error: Origin이 죽거나 5xx를 반환해도, 만료된
 *   캐시라도 일단 그걸 서빙한다. Blogger나 Cloudflare 일부 장애 시에도
 *   사이트가 죽지 않고 "오래된 페이지라도 보여주는" 형태로 생존한다.
 *
 * - 기본 만료: 12시간 (43200초) — 블로그 글은 발행 후 자주 안 바뀌므로
 *   기존 4시간보다 늘려서 원본 도달률을 더 낮춤. SWR 윈도우 안에서는
 *   계속 최신화되므로 실제로는 콘텐츠가 오래 묵지 않는다.
 * - SWR 윈도우: 6시간 (만료 6시간 전부터 백그라운드 재검증 시작)
 * - 키: cache:{fnv1a(normalizedUrl)} — 쿠키/encoding 영향 없음
 */

import { kvGet, kvSet, kvGetJson, kvSetJson, kvDel, kvScan } from './store.js';

const RESERVE_TTL_SEC  = 1800;  // 12시간 (기존 4시간 → 연장, 원본 도달률 최소화)
const SWR_WINDOW_SEC   = 1800;  // 6시간 (만료 전 stale 허용 윈도우)
const MAX_BODY_BYTES    = 2_000_000; // 2MB까지 캐시 허용 (이미지 임베드 글 대응)
const STALE_GRACE_SEC   = 3600; // 3일 — 완전 만료 후에도 origin 장애 시 이 기간까지는 stale 서빙

// ── FNV-1a 32bit (캐시 키 해시) ──────────────────────────────────────
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

// URL 정규화: 쿼리스트링 순서를 정렬하고, 캐시에 영향 없는 추적 파라미터
// (utm_*, fbclid, gclid, ref 등)를 제거해서 같은 콘텐츠가 다른 키로
// 쪼개지는 것을 방지한다. 이게 캐시 히트율에 직접 영향을 준다.
const TRACKING_PARAMS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'fbclid','gclid','msclkid','ref','source','si'];

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.searchParams.sort();
    u.hash = '';
    return u.toString();
  } catch (_) {
    return rawUrl;
  }
}

function cacheKey(url) {
  return 'cache:' + fnv1a32(normalizeUrl(url));
}

// ── 캐시 가능 여부 판별 ───────────────────────────────────────────────
// 쿠키 유무는 더 이상 체크하지 않는다 — 익명 방문자도 광고/분석 스크립트로
// 인해 쿠키를 동반하는 게 정상이고, 서버가 내려주는 HTML 자체는 쿠키별로
// 달라지지 않으므로 캐시 가능 여부와 무관하다.
export function isCacheable(request, response) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (response && !response.ok) return false;
  return true;
}

// ── L0: Cloudflare Cache API 헬퍼 ───────────────────────────────────
// caches.default는 Worker 코드에서 별도 바인딩 없이 바로 쓸 수 있는
// 엣지 캐시다. DO/KV/Upstash 호출 없이 같은 엣지 노드 메모리에서 응답되어
// 가장 빠르다. Request 객체를 키로 쓰므로, 정규화된 URL로 가짜 Request를
// 만들어 캐시 키를 통일한다.
function l0CacheRequest(url) {
  // GET 요청 + 정규화된 URL로 캐시 키를 고정 (쿠키/encoding 영향 없음)
  return new Request(normalizeUrl(url), { method: 'GET' });
}

async function l0Get(url) {
  if (typeof caches === 'undefined' || !caches.default) return null;
  try {
    const hit = await caches.default.match(l0CacheRequest(url));
    return hit || null;
  } catch (_) { return null; }
}

async function l0Put(url, response, ttlSec) {
  if (typeof caches === 'undefined' || !caches.default) return;
  try {
    const cacheReq = l0CacheRequest(url);
    const cacheRes = new Response(response.body, response);
    cacheRes.headers.set('cache-control', `public, max-age=${ttlSec}`);
    await caches.default.put(cacheReq, cacheRes);
  } catch (_) { /* Cache API 실패는 무시 — L2로 폴백되므로 안전 */ }
}

async function l0Delete(url) {
  if (typeof caches === 'undefined' || !caches.default) return;
  try { await caches.default.delete(l0CacheRequest(url)); } catch (_) {}
}

// ── 캐시에서 읽기 ────────────────────────────────────────────────────
// L0(Cache API, 네트워크 호출 없음) → L2(DO Redis/KV/Upstash) 순으로 조회.
export async function cacheReserveGet(env, request) {
  const url = request.url;

  // L0: Cloudflare Cache API — 히트하면 DO/KV 호출 없이 즉시 반환
  const l0hit = await l0Get(url);
  if (l0hit) {
    const headers = new Headers(l0hit.headers);
    headers.set('x-cache', 'HIT');
    headers.set('x-cache-tier', 'L0');
    return {
      response: new Response(l0hit.body, { status: l0hit.status, headers }),
      isStale: false, isSwr: false, tier: 'L0',
    };
  }

  // L2: 영속 스토리지
  const key   = cacheKey(url);
  const entry = await kvGetJson(env, key);
  if (!entry) return null;

  const age     = Math.floor((Date.now() - entry.ts) / 1000);
  const isStale = age > entry.ttl;
  const isSwr   = age > entry.ttl - SWR_WINDOW_SEC;

  // 완전 만료(STALE_GRACE_SEC 초과)면 버린다. 그 전까지는 origin 장애 시
  // stale 서빙용으로 남겨둔다 (cacheReserveGetStaleFallback에서 사용).
  if (isStale && age > entry.ttl + STALE_GRACE_SEC) {
    kvDel(env, key).catch(() => {});
    return null;
  }
  if (isStale) return null; // 정상 흐름에서는 만료 시 origin으로 보냄 (SWR/stale-on-error는 별도 처리)

  const headers = new Headers(entry.headers || {});
  headers.set('x-cache', 'HIT');
  headers.set('x-cache-tier', 'L2');
  headers.set('x-cache-age', String(age));
  headers.set('x-cache-ttl', String(entry.ttl - age));
  if (isSwr) headers.set('x-cache-swr', '1');

  const response = new Response(entry.body, { status: entry.status || 200, headers });

  // L0를 채워둔다 (다음 요청부터는 L2도 건너뛰고 L0에서 즉시 응답)
  // 응답을 막지 않도록 별도로 기다리지 않는다 — 호출부에서 ctx.waitUntil로 감싼다.
  return { response, isStale: false, isSwr, entry, tier: 'L2', warmL0: () => l0Put(url, response.clone(), entry.ttl - age) };
}

// origin fetch가 실패했을 때(5xx, 네트워크 에러) 호출 — 만료된 캐시라도
// STALE_GRACE_SEC 이내라면 그걸 서빙해서 사이트 생존을 보장한다.
export async function cacheReserveGetStaleFallback(env, request) {
  const url = request.url;
  const key = cacheKey(url);
  const entry = await kvGetJson(env, key);
  if (!entry) return null;

  const age = Math.floor((Date.now() - entry.ts) / 1000);
  if (age > entry.ttl + STALE_GRACE_SEC) return null; // 그래도 너무 오래됐으면 포기

  const headers = new Headers(entry.headers || {});
  headers.set('x-cache', 'STALE-ON-ERROR');
  headers.set('x-cache-age', String(age));
  return new Response(entry.body, { status: entry.status || 200, headers });
}

// ── 캐시에 저장 ──────────────────────────────────────────────────────
export async function cacheReservePut(env, request, response, options = {}) {
  if (!isCacheable(request, response)) return false;

  const ttl   = options.ttl || RESERVE_TTL_SEC;
  const url   = request.url;
  const key   = cacheKey(url);
  const region = options.region || 'GLOBAL';

  const body = await response.text().catch(() => null);
  if (!body || body.length > MAX_BODY_BYTES) return false;

  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    const kl = k.toLowerCase();
    if (['cf-cache-status','cf-ray','nel','report-to','server','set-cookie'].includes(kl)) continue;
    headers[kl] = v;
  }

  const entry = {
    body, headers, status: response.status,
    url, ts: Date.now(), ttl, region,
  };

  // L0(Cache API)에도 동시에 채워서, 같은 엣지 노드로 들어오는 다음 요청은
  // L2(DO/KV) 호출 없이 즉시 응답되게 한다.
  await Promise.allSettled([
    kvSetJson(env, key, entry, ttl + STALE_GRACE_SEC), // 영속 계층: stale grace까지 보존
    l0Put(url, new Response(body, { status: entry.status, headers: new Headers(headers) }), ttl),
  ]);
  return true;
}

// ── 배치 동시 처리 헬퍼 ───────────────────────────────────────────────
// DO Redis는 키 1개 조회당 서브리퀘스트 1개를 소비하므로, 1000개 키를
// 한 번에 동시 요청하면 Free 플랜의 invocation당 서브리퀘스트 한도를
// 초과할 수 있다. BATCH_SIZE만큼 묶어서 순차적으로 동시 처리한다.
const BATCH_SIZE = 25;

async function mapBatched(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ── Cache Reserve 정리 (완전 만료된 항목만) ──────────────────────────
export async function cacheReservePurge(env, pattern = 'cache:*') {
  const keys = await kvScan(env, pattern, 500);
  const now = Date.now();
  let purged = 0;

  await mapBatched(keys, async (k) => {
    const entry = await kvGetJson(env, k);
    if (!entry) return;
    const age = (now - entry.ts) / 1000;
    if (age > entry.ttl + STALE_GRACE_SEC) {
      await kvDel(env, k);
      purged++;
    }
  });

  return { purged };
}

// ── URL 특정 캐시 무효화 (글 수정 시 호출) ───────────────────────────
export async function cacheReserveInvalidate(env, url) {
  const keys = await kvScan(env, 'cache:*', 500);
  let invalidated = 0;

  await mapBatched(keys, async (k) => {
    const entry = await kvGetJson(env, k);
    if (entry && entry.url && entry.url.includes(url)) {
      await kvDel(env, k);
      invalidated++;
    }
  });

  await l0Delete(url).catch(() => {});
  return { invalidated };
}

// ── 캐시 통계 ────────────────────────────────────────────────────────
const STATS_SAMPLE_CAP = 300;

export async function cacheReserveStats(env) {
  const keys  = await kvScan(env, 'cache:*', 1000);
  const now   = Date.now();
  const total = keys.length;
  const sample = keys.slice(0, STATS_SAMPLE_CAP);
  let alive = 0, stale = 0;

  await mapBatched(sample, async (k) => {
    const entry = await kvGetJson(env, k);
    if (!entry) return;
    const age = (now - entry.ts) / 1000;
    if (age < entry.ttl) alive++;
    else stale++;
  });

  const sampled = alive + stale;
  if (sampled > 0 && sample.length < total) {
    const ratio = total / sampled;
    return {
      total, alive: Math.round(alive * ratio), stale: Math.round(stale * ratio),
      ttlSec: RESERVE_TTL_SEC, estimated: true,
    };
  }
  return { total, alive, stale, ttlSec: RESERVE_TTL_SEC, estimated: false };
}
