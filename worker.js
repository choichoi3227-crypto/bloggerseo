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
 * 4. 이미지 반응형 srcset 자동 생성 (Blogger 네이티브 리사이즈 활용)
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

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvCname = h => 'cname_ok:' + h;
const kvRtt   = h => 'lb:rtt:'   + h;
const kvBw    = h => 'lb:bw:'    + h;

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
    pageCtx = await extractPageContext(html, url);
    result  = await transformHtml(html, pageCtx, url);
    metrics.recordLatency('html_transform', Date.now() - transformT0);
    if (!result || typeof result !== 'string') result = html; // 변환 결과 무결성 보장
  } catch (e) {
    result = html;   // 변환 실패 시 원본 HTML 그대로 응답 (서비스 중단 방지)
    pageCtx = null;
    metrics.logError('html_transform_failed', { error: String((e && e.message) || e) });
  }

  // ── 7. 비동기 후처리 (모두 방어적, 실패해도 응답에 영향 없음) ──
  const respHeaders = buildResponseHeaders();
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
// HTML을 더 이상 KV에 저장하지 않으므로, 이 엔드포인트는 과거 버전에서
// 이미 저장된 잔존 캐시 엔트리(meta:*, body:*)를 정리하는 1회성 청소 용도로만
// 의미가 있음. 신규 데이터는 더 이상 쌓이지 않음.
// ─────────────────────────────────────────────
async function purgeAll(env) {
  if (!env.CACHE_RESERVE_KV) {
    return new Response(JSON.stringify({ purged: 0, note: 'CACHE_RESERVE_KV not bound; HTML caching is disabled, nothing to purge' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  try {
    let deleted = 0;
    let cursor;
    do {
      const listed = await env.CACHE_RESERVE_KV.list({ prefix: 'meta:', cursor });
      for (const key of listed.keys) {
        const bodyKey = 'body:' + key.name.slice('meta:'.length);
        await env.CACHE_RESERVE_KV.delete(key.name).catch(() => {});
        await env.CACHE_RESERVE_KV.delete(bodyKey).catch(() => {});
        deleted++;
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
    return new Response(JSON.stringify({ purged: deleted }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return errResp(500, 'Purge failed: ' + String((e && e.message) || e));
  }
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
  o = safeTransform(o, injectResponsiveImages); // 이미지 전송 최적화: 반응형 srcset
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
// 원본 그대로 두고, 이미지 lazy-loading과 dns-prefetch/preconnect 같은
// 안전한 최적화만 적용.
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
  // 이미지 lazy-loading은 스크립트 실행 순서와 무관하므로 안전하게 유지
  o = o.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');
  return o;
}

// ─────────────────────────────────────────────
// 이미지 전송 속도 최적화 — 반응형 srcset 자동 생성
//
// Blogger/googleusercontent 이미지는 URL 안에 사이즈 세그먼트(/s320/, /w320-h240/)
// 또는 쿼리 형태(=s320, =w320-h240)가 있고, 그 숫자를 바꾸면 Google 서버가
// 즉석에서 리사이즈된 이미지를 내려줌(별도 이미지 처리 서버 불필요).
// 이미 srcset이 있거나 사이즈 패턴이 없는 이미지는 건드리지 않음(안전 우선).
// ─────────────────────────────────────────────
const RESPONSIVE_WIDTHS = [320, 480, 800, 1200, 1600];

function injectResponsiveImages(html) {
  return html.replace(/<img\b[^>]*>/gi, tag => {
    try {
      if (/\bsrcset=/i.test(tag)) return tag; // 이미 srcset 있으면 건드리지 않음
      const m = tag.match(/\bsrc=["']([^"']+)["']/i);
      if (!m) return tag;
      const src = m[1];
      const srcset = buildBloggerSrcset(src);
      if (!srcset) return tag;
      // sizes는 보편적인 반응형 본문 이미지 기준값. 테마별로 다를 수 있어
      // 보수적인 기본값만 제공(실제 표시 크기를 넘는 다운로드는 방지하되,
      // 작은 화면에서 과도하게 작은 이미지가 선택되지 않도록 함).
      return tag
        .replace(/<img\b/i, `<img srcset="${escapeAttr(srcset)}" sizes="(max-width: 800px) 100vw, 800px"`);
    } catch (_) {
      return tag;
    }
  });
}

// Blogger 이미지 URL의 사이즈 세그먼트를 RESPONSIVE_WIDTHS 각각으로 교체해
// "url width" 쌍의 srcset 문자열을 생성. 패턴이 없으면 null 반환(원본 유지).
//
// [주의] =w320-h240처럼 너비+높이가 모두 고정된 패턴은 너비만 바꾸면 원본
// 비율이 깨져버리므로(높이를 비례 계산할 정보가 없음) 의도적으로 제외하고
// 원본 그대로 둠. 너비만 있거나(=w320) 정사각형 크롭(=s320, /s320/)처럼
// 한 변만 지정하는 패턴만 안전하게 교체함.
function buildBloggerSrcset(src) {
  // 패턴 A: 경로형 .../s320/... 또는 .../s320-c/... (정사각형 기준 한 변)
  const pathPattern = /\/s\d{2,4}(-c)?\//i;
  // 패턴 B: 쿼리형 한 변만 지정 ...=s320 또는 ...=w320 (높이 고정값 없음)
  const queryPattern = /=([sw])\d{2,4}(-c)?(?=$|[?&])/i;
  // 너비+높이가 모두 고정된 패턴은 비율 깨짐 위험이 있어 제외
  const fixedAspectPattern = /=[sw]\d{2,4}-h\d{2,4}/i;

  if (fixedAspectPattern.test(src)) return null;

  if (pathPattern.test(src)) {
    const entries = RESPONSIVE_WIDTHS.map(w => `${src.replace(pathPattern, `/s${w}$1/`)} ${w}w`);
    return entries.join(', ');
  }
  if (queryPattern.test(src)) {
    const entries = RESPONSIVE_WIDTHS.map(w => `${src.replace(queryPattern, `=$1${w}$2`)} ${w}w`);
    return entries.join(', ');
  }
  return null;
}

// ─────────────────────────────────────────────
// 응답 헤더
// ─────────────────────────────────────────────
function buildResponseHeaders() {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  // HTML 캐싱 완전 비활성화: 브라우저/CDN 어디에도 캐싱되지 않도록 no-store.
  // public/max-age를 내려보내면 KV 캐시를 꺼도 브라우저나 Cloudflare edge가
  // 자체적으로 HTML을 캐싱해버려서 메뉴/드롭다운 등 동적 위젯이 그대로 깨짐.
  h.set('cache-control',          'no-store, must-revalidate');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding');
  return h;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트
// [v3] async — countOccurrences(WASM)로 og:title 등의 존재 여부를 먼저
// 빠르게 스캔해, 정규식 추출 단계의 불필요한 백트래킹을 줄임(대형 HTML에서
// 유효). 결과는 기존 extractMeta 등과 동일.
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
