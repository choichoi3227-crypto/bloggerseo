/**
 * BloggerSEO v6 — 자체 Cache Reserve 엔진
 * ─────────────────────────────────────────────────────────────────────
 * 클라우드플레어 Cache Reserve 방식을 100% 자체 구현
 * - 만료 기간: 4시간 (14400초)
 * - 저장소: Upstash Redis (store.js kvSet/kvGet)
 * - 계층: L1(메모리 30초) → L2(Redis 4시간) → Origin
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

// ── Cache Reserve 정리 (만료된 항목) ─────────────────────────────────
export async function cacheReservePurge(env, pattern = 'cache:*') {
  const keys = await kvScan(env, pattern, 500);
  let purged = 0;
  const now = Date.now();
  for (const k of keys) {
    const entry = await kvGetJson(env, k);
    if (!entry) continue;
    const age = (now - entry.ts) / 1000;
    if (age > entry.ttl) {
      await kvDel(env, k);
      purged++;
    }
  }
  return { purged };
}

// ── URL 특정 캐시 무효화 ─────────────────────────────────────────────
export async function cacheReserveInvalidate(env, url) {
  const keys = await kvScan(env, 'cache:*', 500);
  let invalidated = 0;
  for (const k of keys) {
    const entry = await kvGetJson(env, k);
    if (entry && entry.url && entry.url.includes(url)) {
      await kvDel(env, k);
      invalidated++;
    }
  }
  return { invalidated };
}

// ── 캐시 통계 ────────────────────────────────────────────────────────
export async function cacheReserveStats(env) {
  const keys  = await kvScan(env, 'cache:*', 1000);
  const now   = Date.now();
  let alive   = 0, stale = 0, total = keys.length;

  for (const k of keys) {
    const entry = await kvGetJson(env, k);
    if (!entry) continue;
    const age = (now - entry.ts) / 1000;
    if (age < entry.ttl) alive++;
    else stale++;
  }
  return { total, alive, stale, ttlSec: RESERVE_TTL_SEC };
}
