/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * - blogspot.com 원본 탐지 없음
 * - 리다이렉트 추적 없음 (redirect: 'manual')
 * - cf.resolveOverride: 'ghs.google.com' 으로 DNS 우회
 * - CNAME 검증 실패해도 차단하지 않음 (soft 검증)
 * - 525 등 SSL 에러 방지
 *
 * ════════════════════════════════════════════════════════════════
 * [v3 변경 내역] — Durable Objects 제거 + WASM 가속 + 인프라 강화
 * ════════════════════════════════════════════════════════════════
 *
 * 1. Durable Objects 완전 제거 → GitHub 레포 JSON 상태 저장으로 대체
 *    (src/github-tenant.js)
 *    - 기존 TenantCoordinator(DO)가 메모리에서 하던 도메인별 동시성 제어
 *      + circuit breaker를 GitHub Contents API로 100% 동등하게 재구현.
 *    - 매 요청마다 GitHub API를 실시간으로 호출(GET으로 상태 읽기 →
 *      판정 → PUT으로 커밋)하는 "실시간 필수" 모드로 동작.
 *    - state/tenants/{sha256(host)[:16]}.json 파일에 도메인별 상태 저장.
 *    - HMAC-SHA256(WASM)으로 상태에 서명을 붙여 외부 변조를 감지.
 *    - GitHub API 실패/레이트리밋/타임아웃 시에는 전부 "통과"로 처리해
 *      본 서비스(SEO 프록시)가 절대 막히지 않음 — 기존 DO degrade
 *      철학을 100% 유지. GITHUB_TOKEN secret이 없으면 완전히 no-op.
 *
 * 2. WASM(AssemblyScript) 도입 → src/wasm-loader.js, wasm-src/
 *    - 슬러그 생성: 유니코드 정규화 기반 단일 패스 슬러그 생성기.
 *    - SHA-256 / HMAC-SHA256: GitHub state 서명, 호스트 해싱(보안 연산).
 *    - FNV-1a32: 캐시 키 해싱(고속, 비암호화 용도).
 *    - countOccurrences: HTML 사전 스캔(정규식 단계 스킵 판단).
 *    - 모든 WASM 호출은 실패 시 동일 결과의 JS 구현으로 즉시 폴백.
 *      WASM 유무와 무관하게 워커의 핵심 응답 경로는 100% 동일하게 동작.
 *
 * 3. EC2/Linux급 인프라 기능 추가 → src/infra.js
 *    - 구조화 로깅(JSON lines), 메트릭(레이턴시 히스토그램/에러율/처리량),
 *      레이트 리미팅(토큰 버킷), 재시도+지수백오프+지터, 동시성 게이트
 *      (인스턴스 로컬 세마포어), 커넥션 최적화 힌트.
 *
 * ── 이전 버전(v2) 변경 내역 ──────────────────────────────────────
 * 1. 슬러그: /yyyy/mm/원본.html → /제목기반슬러그 로 완전 평탄화
 * 2. 캐싱: HTML(KV Cache Reserve) 캐싱 완전 비활성화 (위젯 동작 보존)
 * 3. 위젯(검색/메뉴 등) 동작을 깨던 강제 <script defer> 주입 제거
 * 4. 이미지/스크립트 태그 강제 속성 주입 없음 (반응형 srcset, lazy-loading
 *    자동 주입을 모두 제거 — Blogger 테마 자체 lazy-load 스크립트와 충돌해
 *    이미지가 전혀 표시되지 않는 문제가 발생해 v3에서 완전히 되돌림)
 */

import { wasmCore } from './src/wasm-loader.js';
import { githubTenantAcquire, githubTenantRelease, githubTenantStatus } from './src/github-tenant.js';
import {
  structuredLog,
  Metrics,
  readRecentMetrics,
  checkRateLimit,
  fetchWithRetry,
  withConcurrencyGate,
  connectionOptimizedCf,
} from './src/infra.js';

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CNAME_CACHE_TTL = 24 * 3600 * 1000; // CNAME(DoH) 조회 결과는 계속 캐싱 (변하지 않는 DNS 정보)
const SLUG_CHECK_MS   = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY    = 0.25;
const LB_RTT_TTL      = 60;
const GHS_TARGET      = 'ghs.google.com';
const DOH_URL         = 'https://1.1.1.1/dns-query';

// 레이트 리미터 기본값 (env 변수로 오버라이드 가능)
const DEFAULT_RATE_LIMIT_PER_MIN = 600; // 호스트당 분당 요청 상한 (대부분의 정상 트래픽엔 영향 없는 보수적 기본값)

// [v4] CACHE_RESERVE_KV — "연산 결과"(pageCtx 메타데이터) 전용 캐시 TTL.
// ※ HTML 본문/최종 응답 바이트는 이 KV에 절대 저장하지 않음 (위젯 보존 원칙 유지).
//   캐시 대상은 extractPageContext()가 만드는 title/description/og이미지/
//   schema 데이터 같은 "파생 메타데이터"뿐이며, 응답은 매 요청마다 origin
//   HTML을 그대로 받아 항상 그 자리에서 새로 조립함.
const COMPUTE_CACHE_TTL_SEC = 600; // 10분

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvCname = h => 'cname_ok:' + h;
const kvRtt   = h => 'lb:rtt:'   + h;
const kvBw    = h => 'lb:bw:'    + h;

// [v4] CACHE_RESERVE_KV 전용 키 — host+path+(origin HTML 해시) 조합.
// origin HTML 내용이 바뀌면 해시가 달라져 캐시가 자동으로 무효화됨(수동 TTL과 별개의 안전장치).
const kvCompute = (host, path, hash) => `compute:${host}:${path}:${hash}`;

// [v4] 외부 모듈(wasmCore) 의존 없이 동작하는 경량 FNV-1a32 해시.
// 캐시 키/ETag 생성에 쓰이는 비암호화 용도 — 단순 XOR+곱셈 루프라
// 정규식 기반 추출보다 훨씬 가볍고, 외부 의존이 없어 항상 안전하게 동작함.
// (wasmCore에 동일 기능이 있을 수 있으나, 이 worker.js가 import하는
//  wasm-loader.js의 실제 export 형태를 단정할 수 없어 별도 의존을 추가하지 않음)
function fnv1a32Hex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // 길이를 추가로 섞어 넣어 우연한 해시 충돌 가능성을 낮춤(ETag는 완전
  // 동일성 판단이 중요하므로, 동일 해시값이라도 길이가 다르면 다른 값이 되게 함)
  hash ^= str.length;
  hash = Math.imul(hash, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // WASM 콜드스타트 워밍업 — 응답을 막지 않고 백그라운드로 인스턴스화
    ctx.waitUntil(wasmCore.warmup());
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      structuredLog('error', 'worker_exception', { error: String((e && e.message) || e) });
      return errResp(502, 'Worker exception: ' + String((e && e.message) || e));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env).catch(() => {}));
  },
};

async function handleFetch(request, env, ctx) {
  const url  = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;
  const metrics = new Metrics(env, ctx, host);
  const reqT0 = Date.now();

  // ── 디버그 엔드포인트 /__blogger_debug ────────
  if (path === '/__blogger_debug') {
    const resp = await safeStep(() => bloggerDebug(url, env), () => errResp(502, 'Debug failed'));
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // ── 메트릭 조회 엔드포인트 /__metrics ─────────
  if (path === '/__metrics') {
    const minutes = Math.min(60, Math.max(1, parseInt(url.searchParams.get('minutes') || '15', 10) || 15));
    const summary = await readRecentMetrics(env, minutes);
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // ── 캐시 전체 purge: /__purge_all ────────────
  if (path === '/__purge_all') {
    return safeStep(() => purgeAll(env), () => errResp(502, 'Purge failed'));
  }

  // ── CNAME 검증 (soft: 실패해도 차단 안 함, 로그만) ──
  ctx.waitUntil(warmCnameCache(host, env).catch(() => {}));

  // ── 레이트 리미팅 (호스트 기준, 토큰 버킷) ────
  const rlLimit = Number(env.RATE_LIMIT_PER_MIN) || DEFAULT_RATE_LIMIT_PER_MIN;
  const rl = await checkRateLimit(env, host, rlLimit, 60);
  if (!rl.allowed) {
    metrics.logEvent('rate_limited', { host, count: rl.count, limit: rl.limit });
    const resp = errResp(429, 'Too Many Requests');
    ctx.waitUntil(metrics.flush(429, Date.now() - reqT0));
    return resp;
  }

  // ── 1. 정적 자산 / Feed / Sitemap 직통 ──────
  // sitemap/feed 등은 슬러그 라우팅보다 먼저 확정해 충돌 방지.
  // 정적 자산이므로 캐시 강화(isStaticAsset=true) 적용
  if (isPassthrough(path, url)) {
    const resp = await proxyPass(url, request, env, true);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // ── 2. 캐시 우회 판별 ────────────────────────
  const bypassCache = shouldBypassCache(request, url, path);

  // purge 모드: KV에서 해당 키 삭제 후 origin에서 새로 가져옴
  if (bypassCache && url.searchParams.get('purge') === '1') {
    try {
      const cacheKey = buildCacheKey(url);
      await deleteCacheReserve(cacheKey, env);
    } catch (_) {}
    const clean = new URL(url.toString());
    clean.searchParams.delete('purge');
    return Response.redirect(clean.toString(), 302);
  }

  // 캐시 우회: origin 직통
  if (bypassCache) {
    const resp = await proxyPass(url, request, env);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // ── 3. 슬러그 라우팅 ──────────────────────────
  let slugRoute;
  try {
    slugRoute = await resolveSlugRoute(path, url, env);
  } catch (_) {
    slugRoute = { type: 'passthrough' };
  }

  if (slugRoute.type === 'redirect') {
    // 원본 blogspot 경로 → 제목 슬러그 경로(평탄화)로 301
    const dest = new URL(url.toString());
    dest.pathname = slugRoute.titlePath;
    return Response.redirect(dest.toString(), 301);
  }

  // alias 경로(제목 슬러그)로 들어온 요청:
  // KV에서 찾은 원본 경로로 내부 fetch하되 응답 URL은 슬러그 그대로 유지
  let fetchUrl = url;
  if (slugRoute.type === 'alias') {
    fetchUrl = new URL(url.toString());
    fetchUrl.pathname = slugRoute.originPath;
  }

  // ── 4. Origin Fetch ──────────────────────────
  // HTML KV 캐시(Cache Reserve)는 비활성화 상태 유지. Blogger 위젯(메뉴/검색/효과 등)이
  // 매 요청마다 새로 생성되는 동적 마크업에 의존하므로, HTML은 항상 origin에서
  // 새로 받아와야 함. 캐시 키만 유지해 두 가지 보조 기능에 재사용:
  //   - /__purge_all, ?purge=1 호환을 위해 buildCacheKey는 그대로 둠
  const cacheKey = buildCacheKey(url);

  // [v3] 도메인별 동시성/헬스 격리: GitHub state 기반(githubTenantAcquire).
  // GITHUB_TOKEN 미설정 시 항상 ok:true로 통과하므로 기존 동작에 영향 없음.
  const tenant = await githubTenantAcquire(host, env, wasmCore, metrics);
  if (!tenant.ok) {
    metrics.logEvent('tenant_rejected', { reason: tenant.reason });
    const resp = errResp(503, 'Tenant busy/unstable: ' + (tenant.reason || 'unknown'));
    ctx.waitUntil(metrics.flush(503, Date.now() - reqT0));
    return resp;
  }

  // [v3] 인스턴스 로컬 동시성 게이트 + 재시도(지수 백오프+지터) + 커넥션
  // 최적화 힌트를 적용해 origin fetch를 EC2/Linux급으로 강화.
  let originResp;
  let originSuccess = false;
  const t0 = Date.now();
  try {
    originResp = await withConcurrencyGate(() =>
      fetchWithRetry(
        () => bloggerFetch(fetchUrl, 'GET', request.headers, true),
        {
          maxRetries: 2,
          baseDelayMs: 60,
          retryableStatuses: [502, 503, 504],
          onRetry: (attempt, delay, info) => metrics.logEvent('origin_retry', { attempt, delay, info: String(info) }),
        }
      )
    );
    originSuccess = originResp.status < 500;
  } catch (e) {
    ctx.waitUntil(githubTenantRelease(host, false, env, wasmCore, metrics));
    metrics.logError('origin_fetch_failed', { error: String((e && e.message) || e) });
    const resp = errResp(502, 'Fetch failed: ' + String((e && e.message) || e));
    ctx.waitUntil(metrics.flush(502, Date.now() - reqT0));
    return resp;
  }
  ctx.waitUntil(githubTenantRelease(host, originSuccess, env, wasmCore, metrics));
  const rtt = Date.now() - t0;
  ctx.waitUntil(lbRecordRtt(host, rtt, env).catch(() => {}));
  metrics.recordLatency('origin_fetch', rtt);

  // 3xx: 리다이렉트 그대로 반환 (루프 방지)
  if (originResp.status >= 300 && originResp.status < 400) {
    const resp = stripInternalHeaders(originResp);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  if (originResp.status >= 500) {
    const resp = errResp(originResp.status, 'Origin error ' + originResp.status);
    ctx.waitUntil(metrics.flush(originResp.status, Date.now() - reqT0));
    return resp;
  }
  if (!isHtml(originResp) || !originResp.ok) {
    const resp = stripInternalHeaders(originResp);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // ── 6. HTML 파이프라인 ────────────────────────
  let html;
  try {
    html = await originResp.text();
  } catch (e) {
    const resp = errResp(502, 'Body read failed: ' + String((e && e.message) || e));
    ctx.waitUntil(metrics.flush(502, Date.now() - reqT0));
    return resp;
  }

  let result = html;
  let pageCtx = null;
  try {
    const transformT0 = Date.now();
    pageCtx = await getOrComputePageContext(html, url, host, path, env, ctx, metrics);
    result  = await transformHtml(html, pageCtx, url);
    metrics.recordLatency('html_transform', Date.now() - transformT0);
    if (!result || typeof result !== 'string') result = html; // 변환 결과 무결성 보장
  } catch (e) {
    result = html;   // 변환 실패 시 원본 HTML 그대로 응답 (서비스 중단 방지)
    pageCtx = null;
    metrics.logError('html_transform_failed', { error: String((e && e.message) || e) });
  }

  // ── 6.5. ETag + 304 Not Modified ──────────────────────────────
  // [v4] HTML "캐싱"이 아님 — origin에서 매 요청 새로 받은 result로 항상
  // 새로 계산하며, 콘텐츠가 100% 동일할 때만 본문 재전송을 생략함(no-store
  // 정책과 무관). 쿠키가 있는 요청(로그인/댓글 작성 등 세션 보유 사용자)은
  // 안전을 위해 304 대상에서 제외하고 항상 200 풀바디로 응답 — Blogger의
  // 로그인 상태 의존 마크업이 자칫 stale하게 보일 가능성을 원천 차단.
  let etag = '';
  const hasCookie = !!request.headers.get('cookie');
  if (!hasCookie) {
    try {
      etag = `"${fnv1a32Hex(result)}"`;
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        ctx.waitUntil(metrics.flush(304, Date.now() - reqT0));
        return new Response(null, {
          status: 304,
          headers: { etag, 'cache-control': 'no-store, must-revalidate' },
        });
      }
    } catch (_) { etag = ''; }
  }

  // ── 7. 비동기 후처리 (모두 방어적, 실패해도 응답에 영향 없음) ──
  const respHeaders = buildResponseHeaders(etag);
  if (pageCtx) ctx.waitUntil(updateSlugKV(pageCtx, url, env).catch(() => {}));
  ctx.waitUntil(lbRecordBandwidth(host, result.length, env).catch(() => {}));
  ctx.waitUntil(metrics.flush(200, Date.now() - reqT0));

  return new Response(result, { status: 200, headers: respHeaders });
}

async function safeStep(fn, onError) {
  try {
    return await fn();
  } catch (e) {
    return onError(e);
  }
}

// ─────────────────────────────────────────────
// 캐시 우회 판별
// ─────────────────────────────────────────────
function shouldBypassCache(request, url, path) {
  if (!['GET', 'HEAD'].includes(request.method)) return true;
  if (url.searchParams.get('purge') === '1') return true;
  if (request.headers.get('cache-control') === 'no-cache') return true;
  if (path.startsWith('/b/'))          return true;  // Blogger 관리 패널
  if (path.startsWith('/admin'))       return true;
  if (path === '/ncr')                 return true;
  if (url.searchParams.has('blogedit'))  return true;
  if (url.searchParams.has('postID'))    return true;
  if (url.searchParams.has('action'))    return true;
  if (url.searchParams.has('widgetType')) return true;
  if (path.startsWith('/search') && url.searchParams.has('q')) return true;
  return false;
}

// ─────────────────────────────────────────────
// 전체 캐시 purge
// meta:*/body:* — 과거(v2 이전) HTML 캐싱 시절의 잔존 엔트리 정리용(1회성).
//   HTML을 더 이상 KV에 저장하지 않으므로 신규 데이터는 쌓이지 않음.
// compute:* — [v4] pageCtx 메타데이터 연산 캐시(TTL 10분, 현재 활성).
//   여기엔 HTML 본문이 없으므로 그대로 둬도 무해하지만, 수동 무효화가
//   필요할 때(예: 슬러그 로직 변경 직후) 즉시 비울 수 있도록 함께 정리.
// ─────────────────────────────────────────────
async function purgeAll(env) {
  let legacyDeleted = 0;
  let computeDeleted = 0;

  if (env.CACHE_RESERVE_KV) {
    try {
      let cursor;
      do {
        const listed = await env.CACHE_RESERVE_KV.list({ prefix: 'meta:', cursor });
        for (const key of listed.keys) {
          const bodyKey = 'body:' + key.name.slice('meta:'.length);
          await env.CACHE_RESERVE_KV.delete(key.name).catch(() => {});
          await env.CACHE_RESERVE_KV.delete(bodyKey).catch(() => {});
          legacyDeleted++;
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    } catch (_) {}

    try {
      let cursor;
      do {
        const listed = await env.CACHE_RESERVE_KV.list({ prefix: 'compute:', cursor });
        for (const key of listed.keys) {
          await env.CACHE_RESERVE_KV.delete(key.name).catch(() => {});
          computeDeleted++;
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    } catch (_) {}
  }

  return new Response(JSON.stringify({
    purged: legacyDeleted,
    computeCachePurged: computeDeleted,
    note: env.CACHE_RESERVE_KV ? undefined : 'CACHE_RESERVE_KV not bound; nothing to purge',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─────────────────────────────────────────────
// CNAME 캐시 워밍 (soft, 차단 안 함)
// ─────────────────────────────────────────────
async function warmCnameCache(host, env) {
  if (!env.SLUG_KV) return;
  try {
    const raw = await env.SLUG_KV.get(kvCname(host));
    if (raw !== null) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      if (parsed && Date.now() - parsed.ts < CNAME_CACHE_TTL) return;
      env.SLUG_KV.delete(kvCname(host)).catch(() => {});
    }
    const ok = await checkCnameGhs(host);
    await env.SLUG_KV.put(
      kvCname(host),
      JSON.stringify({ ok, ts: Date.now() }),
      { expirationTtl: 86400 }
    );
  } catch (_) {}
}

// ─────────────────────────────────────────────
// CNAME 확인 (DoH)
// ─────────────────────────────────────────────
async function checkCnameGhs(host) {
  let current = host;
  const seen  = new Set();
  for (let i = 0; i < 10; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    let cname;
    try { cname = await dnsCname(current); } catch (_) { break; }
    if (!cname) break;
    const normalized = cname.replace(/\.$/, '').toLowerCase();
    if (normalized === GHS_TARGET) return true;
    current = normalized;
  }
  return false;
}

async function dnsCname(host) {
  try {
    const resp = await fetch(
      `${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`,
      { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !Array.isArray(data.Answer)) return null;
    const rec = data.Answer.find(r => r.type === 5);
    return rec ? String(rec.data) : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────
// Blogger fetch
// [v3] connectionOptimizedCf로 커넥션 재사용 힌트 추가(EC2/nginx의
// keepalive 튜닝과 동등 목적). bypassEdgeCache 파라미터는 기존과 동일.
// ─────────────────────────────────────────────
async function bloggerFetch(url, method, reqHeaders, bypassEdgeCache) {
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs = params.toString() ? '?' + params.toString() : '';

  const targetUrl = url.origin + url.pathname + qs;

  const headers = new Headers();
  for (const [k, v] of reqHeaders.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'host')            continue;
    if (kl.startsWith('cf-'))     continue;
    if (kl === 'x-forwarded-for') continue;
    if (kl === 'x-real-ip')       continue;
    headers.set(k, v);
  }
  headers.set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

  let cf = { resolveOverride: GHS_TARGET };
  if (bypassEdgeCache) {
    // HTML이 Cloudflare 자체 edge 캐시에 걸리지 않도록 명시적으로 우회.
    cf.cacheTtl = 0;
    cf.cacheEverything = false;
  }
  cf = connectionOptimizedCf(cf); // [v3] 커넥션 재사용/HTTP3 선호 힌트

  return fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : null,
    redirect: 'manual',
    cf,
  });
}

// ─────────────────────────────────────────────
// 디버그
// ─────────────────────────────────────────────
async function bloggerDebug(url, env) {
  const host = url.hostname;
  let status = 0, ok = false, errorMsg = null;
  try {
    const resp = await fetch(url.origin + '/', {
      method: 'HEAD',
      headers: { 'user-agent': 'Mozilla/5.0' },
      redirect: 'manual',
      cf: { resolveOverride: GHS_TARGET },
    });
    status = resp.status;
    ok = resp.ok || resp.status === 301 || resp.status === 302;
  } catch (e) {
    errorMsg = String((e && e.message) || e);
  }

  let cnameOk = null;
  if (env.SLUG_KV) {
    try {
      const raw = await env.SLUG_KV.get(kvCname(host));
      if (raw) cnameOk = JSON.parse(raw).ok;
    } catch (_) {}
  }

  const tenant = await githubTenantStatus(host, env, wasmCore);
  const wasmInfo = { lastBackend: wasmCore._lastBackend };

  const info = {
    host,
    resolveOverride: GHS_TARGET,
    ghsStatus: status,
    ok,
    cnamePointsToGhs: cnameOk,
    htmlCaching: 'disabled',                       // HTML은 항상 origin 직통, no-store
    staticAssetCaching: 'public, max-age=86400',   // js/css/이미지/폰트 등은 최소 1일 캐시 보장
    computeCache: {                                 // [v4] pageCtx 메타데이터 전용 연산 캐시
      bound: !!env.CACHE_RESERVE_KV,
      ttlSeconds: COMPUTE_CACHE_TTL_SEC,
      note: 'HTML 본문은 저장하지 않음 — title/description/og 등 파생 메타데이터만 캐시',
    },
    tenant,                                         // [v3] GitHub state 기반 동시성/헬스 상태
    wasm: wasmInfo,                                 // [v3] WASM/JS 폴백 사용 현황
    ...(errorMsg ? { error: errorMsg } : {}),
    message: errorMsg
      ? 'ERROR: fetch 실패: ' + errorMsg
      : ok
        ? 'OK: ghs.google.com resolveOverride 정상 동작'
        : 'FAIL: 응답 이상 (status=' + status + '). Blogger 커스텀 도메인 설정을 확인하세요.',
  };
  return new Response(JSON.stringify(info, null, 2), {
    status: ok ? 200 : 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─────────────────────────────────────────────
// 프록시 유틸
// isStaticAsset=true(JS/CSS/이미지/폰트 등 isPassthrough 대상)일 때만
// 장기 캐시 헤더를 보강. HTML 경로(캐시 우회로 들어온 /b/, /admin 등)는
// 절대 영향받지 않도록 분리.
// ─────────────────────────────────────────────
async function proxyPass(url, request, env, isStaticAsset) {
  try {
    const resp = await fetchWithRetry(
      () => bloggerFetch(url, request.method, request.headers),
      { maxRetries: 1, baseDelayMs: 50, retryableStatuses: [502, 503, 504] }
    );
    return stripInternalHeaders(resp, isStaticAsset);
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + String((e && e.message) || e));
  }
}

function stripInternalHeaders(resp, isStaticAsset) {
  try {
    const h = new Headers(resp.headers);
    h.delete('cf-cache-status');
    h.delete('cf-ray');
    h.delete('nel');
    h.delete('report-to');
    h.delete('server');
    // 정적 자산만 장기 캐시 보강. origin이 캐시 헤더를 약하게 주거나
    // 안 주는 경우를 대비해 최소 1일 캐시를 보장 (HTML과는 완전히 분리된 정책).
    if (isStaticAsset && resp.ok) {
      const existing = h.get('cache-control') || '';
      if (!existing || /no-store|no-cache|max-age=0/i.test(existing)) {
        h.set('cache-control', 'public, max-age=86400, stale-while-revalidate=3600');
      }
      // 파일 전송 최적화: Accept-Encoding 기준으로 압축 변형이 캐시되도록
      // Vary를 보강. 누락 시 일부 CDN/브라우저가 압축 안 된 응답을 잘못 캐싱해
      // 전송량이 커지는 문제를 방지.
      const vary = h.get('vary') || '';
      if (!/accept-encoding/i.test(vary)) {
        h.set('vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
      }
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  } catch (_) {
    return resp;
  }
}

function errResp(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type':  'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-error':       String(message).slice(0, 500),
    },
  });
}

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/'))               return true;
  if (path === '/atom.xml')                     return true;
  if (path === '/rss.xml')                      return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path))  return true;
  if (url.searchParams.has('alt'))              return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─────────────────────────────────────────────
// Cache Reserve (KV) — HTML 본문 캐싱 완전 비활성화
//
// 더 이상 HTML을 KV에 저장/조회하지 않음 (메뉴/드롭다운 등 위젯 JS가
// 매 요청마다 origin이 새로 생성하는 동적 데이터에 의존하기 때문).
// buildCacheKey/deleteCacheReserve는 기존 ?purge=1 호환과, 과거에
// 저장된 잔여 KV 엔트리를 정리하기 위한 목적으로만 유지.
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const s = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (s.toString() ? '?' + s : '');
}

async function deleteCacheReserve(key, env) {
  if (!env.CACHE_RESERVE_KV) return;
  try {
    await env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
    await env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 라우팅 [완전 평탄화]
//
// KV 구조:
//   origin:{originPath}  → { title, titleSlug, titlePath, createdAt, checkedAt }
//     원본 blogspot 경로(/yyyy/mm/x.html 또는 /p/x) → 평탄화된 제목 슬러그 경로(/제목, 확장자 없음)
//
//   alias:{titlePath}    → originPath
//     평탄화된 슬러그 경로 → 원본 경로 역방향 매핑
//
// 동작:
//   원본 경로(/yyyy/mm/...html, /p/...) 요청 → 평탄화된 /제목 경로로 301
//   평탄화된 슬러그 경로 요청 → 원본 경로로 내부 fetch (URL은 슬러그 그대로 유지)
// ─────────────────────────────────────────────

function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

// 슬러그 경로 충돌 방지: passthrough 대상이나 예약 경로와 겹치지 않게 검증
function isReservedFlatPath(p) {
  if (p === '/') return true;
  if (p === '')  return true;
  if (p.startsWith('/feeds/'))         return true;
  if (p.startsWith('/b/'))             return true;
  if (p.startsWith('/admin'))          return true;
  if (p.startsWith('/search'))         return true;
  if (p === '/ncr')                    return true;
  if (p === '/__blogger_debug')        return true;
  if (p === '/__purge_all')            return true;
  if (p === '/__metrics')              return true; // [v3] 새 디버그 엔드포인트도 예약 처리
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(p)) return true;
  if (p === '/atom.xml' || p === '/rss.xml') return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json|html?)$/i.test(p)) return true;
  return false;
}

// 평탄화된 슬러그 경로 생성: /[titleSlug] (.html 확장자 제거, 날짜/디렉토리 구조도 제거)
function buildFlatTitlePath(titleSlug) {
  return '/' + titleSlug;
}

// 요청 경로의 슬러그 라우팅 타입 반환
//   { type: 'redirect', titlePath }  → 원본 경로, 평탄화된 제목 슬러그로 301
//   { type: 'alias',    originPath } → 평탄화된 슬러그 경로, 원본으로 내부 fetch
//   { type: 'passthrough' }          → 처리 없이 통과
async function resolveSlugRoute(path, url, env) {
  if (!env.SLUG_KV) return { type: 'passthrough' };

  // 1. 원본(날짜형) 경로로 들어온 요청인지 확인 → 평탄화된 슬러그로 리다이렉트
  if (isPostPath(path)) {
    try {
      const rec = await env.SLUG_KV.get('origin:' + path, { type: 'json' });
      if (rec && rec.titlePath && rec.titlePath !== path) {
        return { type: 'redirect', titlePath: rec.titlePath };
      }
    } catch (_) {}
    return { type: 'passthrough' };
  }

  // 2. 평탄화된 슬러그 경로(/제목)로 들어온 요청인지 확인
  //    .html 확장자 없는 단일 세그먼트 경로(/foo)만 alias 대상으로 취급.
  //    슬래시가 더 있는 경로(/p/x, /2024/01/x.html)나 예약 경로는 절대 가로채지 않음
  if (/^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    try {
      const originPath = await env.SLUG_KV.get('alias:' + path);
      if (originPath && originPath !== path) {
        return { type: 'alias', originPath };
      }
    } catch (_) {}
  }

  return { type: 'passthrough' };
}

// HTML fetch 후 슬러그 KV 등록/갱신
// [v3] generateSlug → wasmCore.generateSlug (WASM 가속, 실패 시 JS 폴백 자동)
async function updateSlugKV(pageCtx, url, env) {
  if (!env.SLUG_KV) return;
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;

  const originPath = url.pathname;

  // 이미 평탄화된 슬러그 경로로 직접 접근한 경우(= alias 통해서 들어온 게 아니라
  // origin 자체가 평탄화된 경로) 등록 대상에서 제외
  if (!isPostPath(originPath)) return;

  const titleSlug = await wasmCore.generateSlug(pageCtx.title);
  const titlePath = buildFlatTitlePath(titleSlug); // 날짜 경로 제거, 완전 평탄화

  if (isReservedFlatPath(titlePath)) return; // 안전장치: 예약 경로와 충돌 시 등록 스킵

  try {
    const existing = await env.SLUG_KV.get('origin:' + originPath, { type: 'json' });
    const now = Date.now();

    if (!existing) {
      await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({
        title: pageCtx.title, titleSlug, titlePath, createdAt: now, checkedAt: now,
      }));
      await env.SLUG_KV.put('alias:' + titlePath, originPath);
    } else {
      const newSlug      = await wasmCore.generateSlug(pageCtx.title);
      const newTitlePath = buildFlatTitlePath(newSlug);

      if (newTitlePath !== existing.titlePath) {
        await env.SLUG_KV.delete('alias:' + existing.titlePath).catch(() => {});
        await env.SLUG_KV.put('alias:' + newTitlePath, originPath);
        await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({
          ...existing, title: pageCtx.title, titleSlug: newSlug, titlePath: newTitlePath, checkedAt: now,
        }));
      } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
        await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({ ...existing, checkedAt: now }));
      }
    }
  } catch (_) {}
}

async function runSlugAudit(env) {
  if (!env.SLUG_KV) return;
  try {
    const list = await env.SLUG_KV.list({ prefix: 'origin:' });
    const now  = Date.now();
    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data || now - data.checkedAt < SLUG_CHECK_MS) continue;
        const newSlug      = await wasmCore.generateSlug(data.title);
        const originPath   = key.name.replace(/^origin:/, '');
        const newTitlePath = buildFlatTitlePath(newSlug); // 평탄화 경로 기준
        if (newTitlePath !== data.titlePath) {
          await env.SLUG_KV.delete('alias:' + data.titlePath).catch(() => {});
          await env.SLUG_KV.put('alias:' + newTitlePath, originPath);
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, titleSlug: newSlug, titlePath: newTitlePath, checkedAt: now }));
        } else {
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, checkedAt: now }));
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// LB 기록
// ─────────────────────────────────────────────
async function lbRecordRtt(host, rttMs, env) {
  if (!env.SLUG_KV) return;
  try {
    const prev = await env.SLUG_KV.get(kvRtt(host), { type: 'json' });
    const ewma = prev && typeof prev.rtt === 'number'
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await env.SLUG_KV.put(kvRtt(host), JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

async function lbRecordBandwidth(host, bytes, env) {
  if (!env.SLUG_KV) return;
  try {
    const raw = await env.SLUG_KV.get(kvBw(host));
    const prev = parseInt(raw || '0', 10) || 0;
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await env.SLUG_KV.put(kvBw(host), String(next), { expirationTtl: 86400 });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인
// script defer 강제 주입 없음 → 위젯(검색/메뉴 등) 동작 보존
// [v3] async로 전환 — extractPageContext/transformHtml 내부에서
// wasmCore(슬러그 생성과 동일한 가속 경로)를 사용할 수 있도록 함.
// ─────────────────────────────────────────────
async function transformHtml(html, ctx, url) {
  let o = html;
  o = safeTransform(o, stripMobileParam);
  o = safeTransform(o, enforceHttps);
  o = safeTransform(o, h => injectMetaDescription(h, ctx));
  o = safeTransform(o, h => injectCanonical(h, ctx, url));
  o = safeTransform(o, h => injectSchemaMarkup(h, ctx, url));
  o = safeTransform(o, h => injectSeoTags(h, ctx));
  o = safeTransform(o, injectPerformanceOptimizations);
  return o;
}

// 각 변환 단계를 개별적으로 방어하여, 한 단계 실패가 전체 파이프라인을
// 무너뜨리지 않고 직전 단계 결과를 그대로 유지하도록 함
function safeTransform(html, fn) {
  try {
    const out = fn(html);
    return (typeof out === 'string' && out.length > 0) ? out : html;
  } catch (_) {
    return html;
  }
}

function stripMobileParam(html) {
  return html
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+&/gi, '$1?')
    .replace(/((?:href|src|action)=["'][^"']*)&m=\d+/gi,   '$1')
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+/gi,  '$1');
}

function enforceHttps(html) {
  return html.replace(/((?:src|href)=["'])http:\/\//gi, '$1https://');
}

// <script>에 defer를 강제로 주입하던 로직 없음.
// 기존 로직은 Blogger 위젯(검색, 메뉴, 댓글 등)이 기대하는 동기 실행 순서를
// 깨뜨려 해당 기능이 동작하지 않는 핵심 원인이었음. 이제 스크립트 태그는
// 원본 그대로 두고, dns-prefetch/preconnect 같은 안전한 최적화만 적용.
//
// [중요] 이미지 lazy-loading(loading="lazy") 자동 주입은 제거함.
// Blogger 테마가 자체 lazy-load 스크립트(IntersectionObserver 기반,
// data-src → src 전환 등)를 갖고 있는 경우가 많아, 모든 <img>에 네이티브
// loading="lazy"를 강제로 끼워넣으면 테마 스크립트와 충돌해 이미지가
// 영구적으로 로드되지 않는(완전히 안 보이는) 문제가 발생할 수 있음.
// 원인이 확실히 격리되기 전까지 이 최적화는 비활성화 상태로 유지.
function injectPerformanceOptimizations(html) {
  let o = html;
  if (!o.includes('rel="dns-prefetch"')) {
    const tags = [
      '<link rel="dns-prefetch" href="//www.blogger.com">',
      '<link rel="dns-prefetch" href="//www.gstatic.com">',
      '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
      '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
      '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    ].join('\n');
    o = o.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
  }
  return o;
}

// ─────────────────────────────────────────────
// 응답 헤더
// ─────────────────────────────────────────────
function buildResponseHeaders(etag) {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  // HTML 캐싱 완전 비활성화: 브라우저/CDN 어디에도 캐싱되지 않도록 no-store.
  // public/max-age를 내려보내면 KV 캐시를 꺼도 브라우저나 Cloudflare edge가
  // 자체적으로 HTML을 캐싱해버려서 메뉴/드롭다운 등 동적 위젯이 그대로 깨짐.
  // ETag를 같이 내려도 no-store이므로 브라우저가 디스크/메모리에 저장하지
  // 않음 — 304는 오직 "지금 이 요청에 대해 본문을 다시 안 보내도 됨"만 의미.
  h.set('cache-control',          'no-store, must-revalidate');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding, Cookie');
  if (etag) h.set('etag', etag);
  return h;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 — CACHE_RESERVE_KV 캐시 래퍼 [v4]
//
// 캐싱 대상은 extractPageContext()가 만드는 메타데이터(JSON, 수 KB)뿐임.
// HTML 본문이나 최종 응답 바이트는 절대 저장하지 않음 — 위젯(검색/메뉴 등)이
// 매 요청 origin이 새로 그려주는 마크업에 의존하는 구조는 그대로 유지되고,
// 캐시는 오직 "이미 한 번 분석한 동일 HTML을 정규식으로 다시 훑는" 비용만 줄임.
//
// 캐시 키: host+path+(origin HTML 앞부분 해시) → 글 내용이 바뀌면 해시가
// 달라져 자동으로 무효화됨. 추가로 TTL 10분을 둬서, 같은 키라도 일정 시간
// 후엔 강제로 재계산하도록 함(메타데이터 자체가 오래된 값으로 굳는 것 방지).
//
// 조회/저장 어느 쪽이 실패하더라도 전부 무시하고 직접 계산으로 폴백 —
// 이 캐시는 순수 가속 레이어이며 응답 가능 여부에는 절대 영향을 주지 않음.
// ─────────────────────────────────────────────
async function getOrComputePageContext(html, url, host, path, env, ctx, metrics) {
  let cacheKey = null;

  if (env.CACHE_RESERVE_KV) {
    try {
      // 해시는 앞부분만 사용(대형 포스트에서 해싱 비용 절감) — 머리글이 같으면
      // 거의 항상 본문도 같다고 봐도 되는 캐시 키 용도이지, 무결성 검증 용도가 아님.
      const sample = html.length > 8192 ? html.slice(0, 8192) : html;
      const hash = fnv1a32Hex(sample);
      cacheKey = kvCompute(host, path, hash);
      const cached = await env.CACHE_RESERVE_KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object') {
          if (metrics && typeof metrics.logEvent === 'function') {
            metrics.logEvent('compute_cache_hit', { host, path });
          }
          return parsed;
        }
      }
    } catch (_) {
      cacheKey = null; // 조회 실패 — 무시하고 아래에서 직접 계산
    }
  }

  const computed = await extractPageContext(html, url);

  if (cacheKey) {
    // 쓰기는 응답 경로를 막지 않도록 비동기로 분리. 실패해도 무시.
    ctx.waitUntil(
      env.CACHE_RESERVE_KV.put(cacheKey, JSON.stringify(computed), {
        expirationTtl: COMPUTE_CACHE_TTL_SEC,
      }).catch(() => {})
    );
  }

  return computed;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 추출 (순수 함수 — 동일 html/url 입력엔 항상 동일 결과)
// ─────────────────────────────────────────────
async function extractPageContext(html, url) {
  const ctx = {
    type: detectPageType(url), title: '', description: '', imageUrl: '',
    author: '', publishDate: '', updateDate: '', tags: [],
    postUrl: url.toString(), siteName: extractSiteName(html), logoUrl: extractLogoUrl(html),
  };
  ctx.title       = extractMeta(html, 'og:title') || extractTagContent(html, /<title[^>]*>([^<]+)<\/title>/i) || '';
  const bodyText  = extractBodyText(html);
  ctx.description = extractMeta(html, 'description') || extractMeta(html, 'og:description') || buildMetaDescription(bodyText, ctx.title);
  ctx.imageUrl    = extractMeta(html, 'og:image') || extractFirstImage(html) || '';
  ctx.publishDate = extractMeta(html, 'article:published_time') || extractJsonLdDate(html, 'datePublished') || '';
  ctx.updateDate  = extractMeta(html, 'article:modified_time')  || extractJsonLdDate(html, 'dateModified')  || ctx.publishDate;
  ctx.author      = extractMeta(html, 'article:author') || extractTagContent(html, /class="fn"[^>]*>([^<]+)</i) || '';
  ctx.tags        = extractLabels(html);
  return ctx;
}

function detectPageType(url) {
  const p = url.pathname;
  if (p === '/' || p === '')                   return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p))  return 'post';
  if (/^\/p\//.test(p))                         return 'page';
  if (p.startsWith('/search/label/'))           return 'label';
  if (p.startsWith('/search'))                  return 'search';
  // 평탄화된 /[slug] 경로(확장자 없는 단일 세그먼트, 예약 경로 제외)도 post로 인식
  if (/^\/[^/]+$/.test(p) && !isReservedFlatPath(p)) return 'post';
  return 'other';
}

// ─────────────────────────────────────────────
// SEO 주입
// ─────────────────────────────────────────────
function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;
  const esc = escapeAttr(ctx.description);
  if (/<meta[^>]+name=["']description["']/i.test(html))
    return html.replace(/(<meta[^>]+name=["']description["'][^>]+content=["'])[^"']*["']/i, `$1${esc}"`);
  return html.replace(/(<\/head>)/i, `<meta name="description" content="${esc}">\n$1`);
}

function injectCanonical(html, ctx, url) {
  if (/<link[^>]+rel=["']canonical["']/i.test(html)) return html;
  return html.replace(/(<\/head>)/i, `<link rel="canonical" href="${escapeAttr(ctx.postUrl || url.toString())}">\n$1`);
}

function injectSeoTags(html, ctx) {
  if (!ctx.title) return html;
  const tags = [];
  const og = (p, c) => { if (c && !new RegExp(`property=["']${escapeRe(p)}["']`).test(html)) tags.push(`<meta property="${p}" content="${escapeAttr(c)}">`); };
  const tw = (n, c) => { if (c && !new RegExp(`name=["']${escapeRe(n)}["']`).test(html))     tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`); };
  og('og:title',       ctx.title);
  og('og:description', ctx.description);
  og('og:url',         ctx.postUrl);
  og('og:type',        ctx.type === 'post' ? 'article' : 'website');
  og('og:site_name',   ctx.siteName);
  if (ctx.imageUrl) og('og:image', ctx.imageUrl);
  tw('twitter:card',        ctx.imageUrl ? 'summary_large_image' : 'summary');
  tw('twitter:title',       ctx.title);
  tw('twitter:description', ctx.description);
  if (ctx.imageUrl) tw('twitter:image', ctx.imageUrl);
  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

function injectSchemaMarkup(html, ctx, url) {
  if (html.includes('"@context":"https://schema.org"') ||
      html.includes('"@context": "https://schema.org"')) return html;
  const schemas = [buildWebsiteSchema(ctx, url)];
  if (ctx.type === 'post') schemas.push(buildArticleSchema(ctx, url));
  else schemas.push(buildWebPageSchema(ctx, url));
  const ld = `<script type="application/ld+json">${JSON.stringify(schemas)}<\/script>`;
  return html.replace(/(<\/head>)/i, ld + '\n$1');
}

function buildWebsiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': url.origin + '/#website', url: url.origin + '/',
    name: ctx.siteName || ctx.title,
    ...(ctx.logoUrl ? { publisher: { '@type': 'Organization', name: ctx.siteName, logo: { '@type': 'ImageObject', url: ctx.logoUrl } } } : {}),
  };
}

function buildArticleSchema(ctx, url) {
  const s = {
    '@context': 'https://schema.org', '@type': 'Article',
    '@id': ctx.postUrl + '#article', mainEntityOfPage: ctx.postUrl + '#webpage',
    headline: ctx.title, description: ctx.description,
    author: { '@type': 'Person', name: ctx.author || ctx.siteName },
    inLanguage: 'ko-KR',
  };
  if (ctx.imageUrl)    { s.image = { '@type': 'ImageObject', url: ctx.imageUrl }; }
  if (ctx.publishDate) s.datePublished = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified  = ctx.updateDate;
  if (ctx.tags.length) s.keywords      = ctx.tags.join(', ');
  return s;
}

function buildWebPageSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebPage',
    '@id': ctx.postUrl + '#webpage', url: ctx.postUrl,
    name: ctx.title, description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' }, inLanguage: 'ko-KR',
    ...(ctx.publishDate ? { datePublished: ctx.publishDate } : {}),
    ...(ctx.updateDate  ? { dateModified:  ctx.updateDate  } : {}),
  };
}

// ─────────────────────────────────────────────
// HTML 파싱 유틸
// ─────────────────────────────────────────────
function extractMeta(html, name) {
  const r = escapeRe(name);
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${r}["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+name=["']${r}["'][^>]+content=["']([^"']+)["']`,    'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`,    'i')) ||
    []
  )[1] || '';
}

function extractTagContent(html, re) { return (html.match(re) || ['', ''])[1].trim(); }

function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildMetaDescription(bodyText, title) {
  let t = title ? bodyText.replace(title, '').trim() : bodyText;
  if (t.length > 160) {
    t = t.slice(0, 160);
    const l = t.lastIndexOf(' ');
    if (l > 100) t = t.slice(0, l);
    t += '…';
  }
  return t;
}

function extractFirstImage(html)  { return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || ''; }
function extractSiteName(html)    { return extractMeta(html, 'og:site_name') || extractTagContent(html, /<title[^>]*>([^<|]+)/i) || ''; }
function extractLogoUrl(html) {
  return (
    html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) ||
    []
  )[1] || '';
}
function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi; let m;
  while ((m = re.exec(html)) !== null) {
    const l = m[1].trim();
    if (l && !labels.includes(l)) labels.push(l);
  }
  return labels;
}
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(str)   { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
