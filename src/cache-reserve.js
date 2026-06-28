/**
 * BloggerSEO v7 — 자체 Cache Reserve 엔진
 * ─────────────────────────────────────────────────────────────────────
 * 클라우드플레어 Cache Reserve 방식을 100% 자체 구현
 * - 만료 기간: 4시간 (14400초)
 * - 저장소: store.js의 kvSet/kvGet (1순위 DO Redis → KV → Upstash → 메모리)
 * - 계층: L1(메모리 30초) → L2(영속 스토리지 4시간) → Origin
 * - 전략: SWR(Stale-While-Revalidate) + Background revalidation
 * - 키: cache:{fnv1a(url+vary)} → { body, status, headers, ts, ttl, region }
 */

import { kvGet, kvSet, kvGetJson, kvSetJson, kvDel, kvScan } from './store.js';

const RESERVE_TTL_SEC  = 14400;  // 4시간
const SWR_WINDOW_SEC   = 3600;   // 1시간 (만료 전 stale 허용 윈도우)
const MAX_BODY_BYTES    = 512_000; // 512KB 이하만 캐시 (본문 크기 제한)

// ── FNV-1a 32bit (캐시 키 해시) ──────────────────────────────────────
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

function cacheKey(url, vary = '') {
  return 'cache:' + fnv1a32(url + '|' + vary);
}

// ── 캐시 가능 여부 판별 ───────────────────────────────────────────────
export function isCacheable(request, response) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (request.headers.get('cookie')) return false;
  if (request.headers.get('authorization')) return false;
  if (response && !response.ok) return false;
  return true;
}

// ── 캐시에서 읽기 ────────────────────────────────────────────────────
export async function cacheReserveGet(env, request) {
  const url    = request.url;
  const vary   = request.headers.get('accept-encoding') || '';
  const key    = cacheKey(url, vary);
  const entry  = await kvGetJson(env, key);

  if (!entry) return null;

  const age     = Math.floor((Date.now() - entry.ts) / 1000);
  const isStale = age > entry.ttl;
  const isSwr   = age > entry.ttl - SWR_WINDOW_SEC; // SWR 윈도우 진입

  if (isStale) {
    // 완전 만료 — 삭제 후 null 반환
    kvDel(env, key).catch(() => {});
    return null;
  }

  const headers = new Headers(entry.headers || {});
  headers.set('x-cache', 'HIT');
  headers.set('x-cache-age', String(age));
  headers.set('x-cache-ttl', String(entry.ttl - age));
  if (isSwr) headers.set('x-cache-swr', '1');

  return {
    response : new Response(entry.body, { status: entry.status || 200, headers }),
    isStale  : false,
    isSwr,
    entry,
  };
}

// ── 캐시에 저장 ──────────────────────────────────────────────────────
export async function cacheReservePut(env, request, response, options = {}) {
  if (!isCacheable(request, response)) return false;

  const ttl   = options.ttl || RESERVE_TTL_SEC;
  const url   = request.url;
  const vary  = request.headers.get('accept-encoding') || '';
  const key   = cacheKey(url, vary);
  const region = options.region || 'GLOBAL';

  // 본문 크기 확인
  const body = await response.text().catch(() => null);
  if (!body || body.length > MAX_BODY_BYTES) return false;

  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    const kl = k.toLowerCase();
    // 내부 헤더 제외
    if (['cf-cache-status','cf-ray','nel','report-to','server','set-cookie'].includes(kl)) continue;
    headers[kl] = v;
  }

  const entry = {
    body, headers, status: response.status,
    url, ts: Date.now(), ttl, region,
  };

  await kvSetJson(env, key, entry, ttl + 300); // Redis TTL은 +5분 여유
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

// ── Cache Reserve 정리 (만료된 항목) ─────────────────────────────────
export async function cacheReservePurge(env, pattern = 'cache:*') {
  const keys = await kvScan(env, pattern, 500);
  const now = Date.now();
  let purged = 0;

  await mapBatched(keys, async (k) => {
    const entry = await kvGetJson(env, k);
    if (!entry) return;
    const age = (now - entry.ts) / 1000;
    if (age > entry.ttl) {
      await kvDel(env, k);
      purged++;
    }
  });

  return { purged };
}

// ── URL 특정 캐시 무효화 ─────────────────────────────────────────────
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

  return { invalidated };
}

// ── 캐시 통계 ────────────────────────────────────────────────────────
// 키 개수가 많을 때 매 요청마다 전체를 다 훑으면 서브리퀘스트/CPU 비용이
// 커지므로 STATS_SAMPLE_CAP까지만 표본 조회하고, 전체 키 개수는 SCAN
// 결과(total)로만 보고한다 (alive/stale 비율은 표본 기준 추정치).
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

  // 표본 비율로 전체 추정 (표본 크기가 total과 같으면 정확한 값)
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
