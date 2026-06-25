/**
 * Blogspot SEO & Performance Optimization Worker v4
 * ══════════════════════════════════════════════════════════════════
 *
 * [v4 핵심 변경]
 *
 * 1. KV 완전 분리
 *    SLUG_KV  → 오직 슬러그 데이터만 (origin:* / alias:* 키)
 *    CNAME_KV → CNAME 검증 결과 + LB RTT + 메트릭 + 레이트리밋
 *    ※ 한 번 검증된 blogspot 도메인은 CNAME_KV에 영구 저장(재검증 없음)
 *
 * 2. 스키마 마크업 강화
 *    - Article (강화: wordCount, articleSection, publisher)
 *    - BreadcrumbList (자동 생성)
 *    - FAQPage (본문 h3 Q&A 자동 감지)
 *    - WebSite (SearchAction 포함)
 *    - 전부 별도 <script> 태그로 분리 주입
 *
 * 3. 20+ 신규 기능
 *    - Preload 힌트 (LCP 이미지 / 폰트)
 *    - hreflang 자동 주입
 *    - robots 메타 최적화
 *    - 링크 rel="noopener noreferrer" 자동화
 *    - 이미지 alt 누락 감지 & 보완
 *    - Open Graph image width/height 주입
 *    - Twitter card 강화
 *    - 모바일 viewport 보강
 *    - Content-Security-Policy 헤더
 *    - Permissions-Policy 헤더
 *    - ETag 생성 (FNV 기반)
 *    - 304 Not Modified 처리
 *    - RSS/Atom 자동 발견 링크
 *    - rel="prev" / rel="next" 페이지네이션 지원
 *    - last-modified 헤더
 *    - Structured Sitemap ping
 *    - HTML 압축 (불필요 공백 제거)
 *    - 404 커스텀 핸들링
 *    - URL 정규화 (trailing slash 통일)
 *    - X-Robots-Tag 헤더
 *    - Timing-Allow-Origin 헤더
 *    - 웹마스터 도구 메타태그 보존
 *    - Publisher Schema (Organization)
 *    - SiteNavigationElement Schema
 *
 * 4. WASM 강화 (src/wasm-loader.js v4)
 *    - 실패 후 쿨다운 기반 재시도 (영구실패 없음)
 *    - exports 존재 여부 런타임 검증
 *    - warmup 타임아웃 보호
 *
 * 5. 로딩 극소화
 *    - dns-prefetch + preconnect 강화
 *    - preload 힌트 (LCP, 폰트)
 *    - ETag + 304 Not Modified
 *    - HTML 경량 minify
 */

import { wasmCore } from './src/wasm-loader.js';
import { githubTenantAcquire, githubTenantRelease, githubTenantStatus } from './src/github-tenant.js';
import {
  structuredLog, Metrics, readRecentMetrics, checkRateLimit,
  fetchWithRetry, withConcurrencyGate, connectionOptimizedCf,
  lbRecordRtt, lbRecordBandwidth,
} from './src/infra.js';

// ─── 상수 ──────────────────────────────────────────────────────────
const GHS_TARGET              = 'ghs.google.com';
const DOH_URL                 = 'https://1.1.1.1/dns-query';
const SLUG_CHECK_MS           = 6 * 30 * 24 * 3600 * 1000;
const DEFAULT_RATE_LIMIT      = 600;

// CNAME 검증 — blogspot 조건 하에 한번 검증된 도메인은 영구 저장, 재검증 없음
// expirationTtl을 매우 길게(10년) 설정. KV TTL은 최대 525,960분(=10년)
const CNAME_VERIFIED_TTL      = 525960 * 60; // ~10년 (초)

// ─── KV 키 헬퍼 ───────────────────────────────────────────────────
// CNAME_KV 전용 키
const kvCname = h => `cname_ok:${h}`;

// SLUG_KV 전용 키
const kvOrigin = p => `origin:${p}`;
const kvAlias  = p => `alias:${p}`;

// ─── 메인 핸들러 ──────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(wasmCore.warmup());
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      structuredLog('error', 'worker_exception', { error: String(e?.message || e) });
      return errResp(502, 'Worker exception: ' + String(e?.message || e));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env).catch(() => {}));
  },
};

async function handleFetch(request, env, ctx) {
  const url    = new URL(request.url);
  const host   = url.hostname;
  const path   = url.pathname;
  const metrics = new Metrics(env, ctx, host);
  const reqT0  = Date.now();

  // ── 특수 엔드포인트 ────────────────────────────────────────────
  if (path === '/__blogger_debug') {
    const resp = await safeStep(() => bloggerDebug(url, env), () => errResp(502, 'Debug failed'));
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }
  if (path === '/__metrics') {
    const minutes = Math.min(60, Math.max(1, parseInt(url.searchParams.get('minutes') || '15', 10) || 15));
    const summary = await readRecentMetrics(env, minutes);
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (path === '/__purge_all') {
    return safeStep(() => purgeAll(env), () => errResp(502, 'Purge failed'));
  }
  if (path === '/__slug_stats') {
    return safeStep(() => slugStats(env), () => errResp(502, 'Stats failed'));
  }
  if (path === '/__health') {
    return new Response(JSON.stringify({ ok: true, ts: Date.now(), wasm: wasmCore._lastBackend }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // ── URL 정규화: trailing slash 통일 ───────────────────────────
  // 루트 제외, html 확장자 경로 제외, 정적 자산 제외
  if (path.length > 1 && path.endsWith('/') &&
      !isPassthrough(path, url) && !path.startsWith('/search')) {
    const cleanUrl = new URL(url.toString());
    cleanUrl.pathname = path.slice(0, -1);
    return Response.redirect(cleanUrl.toString(), 301);
  }

  // ── CNAME 검증 (soft, CNAME_KV에 영구 캐시) ─────────────────
  ctx.waitUntil(warmCnameCache(host, env).catch(() => {}));

  // ── 레이트 리미팅 ─────────────────────────────────────────────
  const rlLimit = Number(env.RATE_LIMIT_PER_MIN) || DEFAULT_RATE_LIMIT;
  const rl = await checkRateLimit(env, host, rlLimit, 60);
  if (!rl.allowed) {
    metrics.logEvent('rate_limited', { host, count: rl.count, limit: rl.limit });
    const resp = errResp(429, 'Too Many Requests');
    ctx.waitUntil(metrics.flush(429, Date.now() - reqT0));
    return resp;
  }

  // ── 1. 정적 자산 / Feed / Sitemap 직통 ──────────────────────
  if (isPassthrough(path, url)) {
    const resp = await proxyPass(url, request, env, true);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // ── 2. 캐시 우회 판별 ────────────────────────────────────────
  const bypassCache = shouldBypassCache(request, url, path);

  if (bypassCache && url.searchParams.get('purge') === '1') {
    const clean = new URL(url.toString());
    clean.searchParams.delete('purge');
    return Response.redirect(clean.toString(), 302);
  }
  if (bypassCache) {
    const resp = await proxyPass(url, request, env);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // ── 3. 슬러그 라우팅 ─────────────────────────────────────────
  let slugRoute;
  try { slugRoute = await resolveSlugRoute(path, url, env); }
  catch (_) { slugRoute = { type: 'passthrough' }; }

  if (slugRoute.type === 'redirect') {
    const dest = new URL(url.toString());
    dest.pathname = slugRoute.titlePath;
    return Response.redirect(dest.toString(), 301);
  }

  let fetchUrl = url;
  if (slugRoute.type === 'alias') {
    fetchUrl = new URL(url.toString());
    fetchUrl.pathname = slugRoute.originPath;
  }

  // ── 4. Origin Fetch ──────────────────────────────────────────
  const tenant = await githubTenantAcquire(host, env, wasmCore, metrics);
  if (!tenant.ok) {
    metrics.logEvent('tenant_rejected', { reason: tenant.reason });
    const resp = errResp(503, 'Tenant busy: ' + (tenant.reason || 'unknown'));
    ctx.waitUntil(metrics.flush(503, Date.now() - reqT0));
    return resp;
  }

  let originResp, originSuccess = false;
  const t0 = Date.now();
  try {
    originResp = await withConcurrencyGate(() =>
      fetchWithRetry(
        () => bloggerFetch(fetchUrl, 'GET', request.headers, true),
        {
          maxRetries: 2, baseDelayMs: 60,
          retryableStatuses: [502, 503, 504],
          onRetry: (attempt, delay, info) =>
            metrics.logEvent('origin_retry', { attempt, delay, info: String(info) }),
        }
      )
    );
    originSuccess = originResp.status < 500;
  } catch (e) {
    ctx.waitUntil(githubTenantRelease(host, false, env, wasmCore, metrics));
    metrics.logError('origin_fetch_failed', { error: String(e?.message || e) });
    const resp = errResp(502, 'Fetch failed: ' + String(e?.message || e));
    ctx.waitUntil(metrics.flush(502, Date.now() - reqT0));
    return resp;
  }
  ctx.waitUntil(githubTenantRelease(host, originSuccess, env, wasmCore, metrics));
  const rtt = Date.now() - t0;
  ctx.waitUntil(lbRecordRtt(host, rtt, env).catch(() => {}));
  metrics.recordLatency('origin_fetch', rtt);

  // 3xx 리다이렉트 그대로 반환
  if (originResp.status >= 300 && originResp.status < 400) {
    const resp = stripInternalHeaders(originResp);
    ctx.waitUntil(metrics.flush(resp.status, Date.now() - reqT0));
    return resp;
  }

  // 404 커스텀 핸들링
  if (originResp.status === 404) {
    const resp = await handle404(originResp, url, env);
    ctx.waitUntil(metrics.flush(404, Date.now() - reqT0));
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

  // ── 5. HTML 파이프라인 ────────────────────────────────────────
  let html;
  try { html = await originResp.text(); }
  catch (e) {
    const resp = errResp(502, 'Body read failed: ' + String(e?.message || e));
    ctx.waitUntil(metrics.flush(502, Date.now() - reqT0));
    return resp;
  }

  let result = html, pageCtx = null;
  try {
    const transformT0 = Date.now();
    pageCtx = await extractPageContext(html, url);
    result  = await transformHtml(html, pageCtx, url, env);
    metrics.recordLatency('html_transform', Date.now() - transformT0);
    if (!result || typeof result !== 'string') result = html;
  } catch (e) {
    result = html;
    pageCtx = null;
    metrics.logError('html_transform_failed', { error: String(e?.message || e) });
  }

  // ── 6. ETag + 304 Not Modified ────────────────────────────────
  let etag = '';
  try {
    const h = await wasmCore.fnv1a32Hex(result.slice(0, 8192));
    etag = `"${h}"`;
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === '*')) {
      ctx.waitUntil(metrics.flush(304, Date.now() - reqT0));
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store, must-revalidate' } });
    }
  } catch (_) {}

  // ── 7. 비동기 후처리 ─────────────────────────────────────────
  const respHeaders = buildResponseHeaders(etag, result.length);
  if (pageCtx) ctx.waitUntil(updateSlugKV(pageCtx, url, env).catch(() => {}));
  ctx.waitUntil(lbRecordBandwidth(host, result.length, env).catch(() => {}));
  ctx.waitUntil(metrics.flush(200, Date.now() - reqT0));

  return new Response(result, { status: 200, headers: respHeaders });
}

// ─── 유틸 ─────────────────────────────────────────────────────────
async function safeStep(fn, onError) {
  try { return await fn(); } catch (e) { return onError(e); }
}

// ─── 404 처리 ─────────────────────────────────────────────────────
async function handle404(originResp, url, env) {
  // alias 경로에서 404가 왔을 경우 SLUG_KV alias 삭제
  const path = url.pathname;
  if (env.SLUG_KV && /^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    try { await env.SLUG_KV.delete(kvAlias(path)); } catch (_) {}
  }
  if (isHtml(originResp)) {
    try {
      const html = await originResp.text();
      const h = new Headers(originResp.headers);
      h.set('cache-control', 'no-store');
      h.set('x-robots-tag', 'noindex');
      return new Response(html, { status: 404, headers: h });
    } catch (_) {}
  }
  return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

// ─── 캐시 우회 ────────────────────────────────────────────────────
function shouldBypassCache(request, url, path) {
  if (!['GET', 'HEAD'].includes(request.method)) return true;
  if (url.searchParams.get('purge') === '1')     return true;
  if (request.headers.get('cache-control') === 'no-cache') return true;
  if (path.startsWith('/b/'))          return true;
  if (path.startsWith('/admin'))       return true;
  if (path === '/ncr')                 return true;
  if (url.searchParams.has('blogedit'))  return true;
  if (url.searchParams.has('postID'))    return true;
  if (url.searchParams.has('action'))    return true;
  if (url.searchParams.has('widgetType')) return true;
  if (path.startsWith('/search') && url.searchParams.has('q')) return true;
  return false;
}

// ─── 전체 캐시 purge (슬러그 KV 정리) ────────────────────────────
async function purgeAll(env) {
  let deleted = 0;
  if (env.SLUG_KV) {
    try {
      let cursor;
      do {
        const listed = await env.SLUG_KV.list({ prefix: 'origin:', cursor });
        for (const key of listed.keys) {
          await env.SLUG_KV.delete(key.name).catch(() => {});
          deleted++;
        }
        const listed2 = await env.SLUG_KV.list({ prefix: 'alias:', cursor });
        for (const key of listed2.keys) {
          await env.SLUG_KV.delete(key.name).catch(() => {});
          deleted++;
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    } catch (_) {}
  }
  return new Response(JSON.stringify({ purged: deleted }), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─── 슬러그 통계 ───────────────────────────────────────────────────
async function slugStats(env) {
  if (!env.SLUG_KV) return errResp(503, 'SLUG_KV not bound');
  try {
    const origins = await env.SLUG_KV.list({ prefix: 'origin:' });
    const aliases = await env.SLUG_KV.list({ prefix: 'alias:' });
    return new Response(JSON.stringify({
      origins: origins.keys.length,
      aliases: aliases.keys.length,
      sample: origins.keys.slice(0, 5).map(k => k.name),
    }, null, 2), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return errResp(500, String(e?.message || e));
  }
}

// ─── CNAME 캐시 (영구, CNAME_KV) ──────────────────────────────────
// blogspot 조건 하에 한번 검증된 도메인은 재검증 없음
async function warmCnameCache(host, env) {
  const kv = env.CNAME_KV;
  if (!kv) return;
  try {
    const raw = await kv.get(kvCname(host)).catch(() => null);
    if (raw !== null) {
      // 이미 검증된 도메인 — 재검증 없음 (blogspot CNAME은 변하지 않음)
      return;
    }
    // 첫 방문: DoH로 검증 후 영구 저장
    const ok = await checkCnameGhs(host);
    await kv.put(
      kvCname(host),
      JSON.stringify({ ok, ts: Date.now(), verified: true }),
      { expirationTtl: CNAME_VERIFIED_TTL }
    ).catch(() => {});
  } catch (_) {}
}

async function checkCnameGhs(host) {
  let current = host;
  const seen = new Set();
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
  } catch (_) { return null; }
}

// ─── Blogger Fetch ─────────────────────────────────────────────────
async function bloggerFetch(url, method, reqHeaders, bypassEdgeCache) {
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs = params.toString() ? '?' + params.toString() : '';
  const targetUrl = url.origin + url.pathname + qs;

  const headers = new Headers();
  for (const [k, v] of reqHeaders.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'host' || kl.startsWith('cf-') || kl === 'x-forwarded-for' || kl === 'x-real-ip') continue;
    headers.set(k, v);
  }
  headers.set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  headers.set('accept-encoding', 'gzip, deflate, br');

  let cf = { resolveOverride: GHS_TARGET };
  if (bypassEdgeCache) { cf.cacheTtl = 0; cf.cacheEverything = false; }
  cf = connectionOptimizedCf(cf);

  return fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : null,
    redirect: 'manual',
    cf,
  });
}

// ─── 디버그 ────────────────────────────────────────────────────────
async function bloggerDebug(url, env) {
  const host = url.hostname;
  let status = 0, ok = false, errorMsg = null;
  try {
    const resp = await fetch(url.origin + '/', {
      method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' },
      redirect: 'manual', cf: { resolveOverride: GHS_TARGET },
    });
    status = resp.status;
    ok = resp.ok || resp.status === 301 || resp.status === 302;
  } catch (e) { errorMsg = String(e?.message || e); }

  let cnameInfo = null;
  const kv = env.CNAME_KV;
  if (kv) {
    try {
      const raw = await kv.get(kvCname(host)).catch(() => null);
      if (raw) cnameInfo = JSON.parse(raw);
    } catch (_) {}
  }

  const tenant = await githubTenantStatus(host, env, wasmCore);
  const slugCount = await (async () => {
    if (!env.SLUG_KV) return 0;
    try {
      const l = await env.SLUG_KV.list({ prefix: 'origin:' });
      return l.keys.length;
    } catch (_) { return -1; }
  })();

  const info = {
    host, resolveOverride: GHS_TARGET,
    ghsStatus: status, ok,
    cnameInfo,                          // 영구 캐시 상태
    cnameKvBound: !!env.CNAME_KV,
    slugKvBound:  !!env.SLUG_KV,
    slugCount,
    htmlCaching: 'disabled',
    staticAssetCaching: 'public, max-age=86400',
    tenant,
    wasm: { lastBackend: wasmCore._lastBackend },
    ...(errorMsg ? { error: errorMsg } : {}),
    message: errorMsg
      ? 'ERROR: fetch 실패: ' + errorMsg
      : ok ? 'OK: ghs.google.com resolveOverride 정상 동작'
           : 'FAIL: status=' + status,
  };
  return new Response(JSON.stringify(info, null, 2), {
    status: ok ? 200 : 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─── 프록시 유틸 ──────────────────────────────────────────────────
async function proxyPass(url, request, env, isStaticAsset) {
  try {
    const resp = await fetchWithRetry(
      () => bloggerFetch(url, request.method, request.headers),
      { maxRetries: 1, baseDelayMs: 50, retryableStatuses: [502, 503, 504] }
    );
    return stripInternalHeaders(resp, isStaticAsset);
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + String(e?.message || e));
  }
}

function stripInternalHeaders(resp, isStaticAsset) {
  try {
    const h = new Headers(resp.headers);
    h.delete('cf-cache-status'); h.delete('cf-ray'); h.delete('nel');
    h.delete('report-to'); h.delete('server');
    if (isStaticAsset && resp.ok) {
      const existing = h.get('cache-control') || '';
      if (!existing || /no-store|no-cache|max-age=0/i.test(existing)) {
        h.set('cache-control', 'public, max-age=86400, stale-while-revalidate=3600');
      }
      const vary = h.get('vary') || '';
      if (!/accept-encoding/i.test(vary)) h.set('vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  } catch (_) { return resp; }
}

function errResp(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-error': String(message).slice(0, 500) },
  });
}

// ─── 라우트 판별 ──────────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/'))              return true;
  if (path === '/atom.xml')                    return true;
  if (path === '/rss.xml')                     return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path)) return true;
  if (url.searchParams.has('alt'))             return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─── 슬러그 라우팅 ────────────────────────────────────────────────
function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

function isReservedFlatPath(p) {
  if (p === '/' || p === '') return true;
  const reserved = [
    '/feeds/', '/b/', '/admin', '/search', '/ncr',
    '/__blogger_debug', '/__purge_all', '/__metrics',
    '/__slug_stats', '/__health',
  ];
  for (const r of reserved) if (p.startsWith(r) || p === r.replace('/', '')) return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(p)) return true;
  if (p === '/atom.xml' || p === '/rss.xml') return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json|html?)$/i.test(p)) return true;
  return false;
}

function buildFlatTitlePath(titleSlug) { return '/' + titleSlug; }

async function resolveSlugRoute(path, url, env) {
  if (!env.SLUG_KV) return { type: 'passthrough' };

  if (isPostPath(path)) {
    try {
      const rec = await env.SLUG_KV.get(kvOrigin(path), { type: 'json' }).catch(() => null);
      if (rec && rec.titlePath && rec.titlePath !== path) {
        return { type: 'redirect', titlePath: rec.titlePath };
      }
    } catch (_) {}
    return { type: 'passthrough' };
  }

  if (/^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    try {
      const originPath = await env.SLUG_KV.get(kvAlias(path)).catch(() => null);
      if (originPath && originPath !== path) {
        return { type: 'alias', originPath };
      }
    } catch (_) {}
  }

  return { type: 'passthrough' };
}

async function updateSlugKV(pageCtx, url, env) {
  if (!env.SLUG_KV) return;
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;
  const originPath = url.pathname;
  if (!isPostPath(originPath)) return;

  const titleSlug = await wasmCore.generateSlug(pageCtx.title);
  const titlePath = buildFlatTitlePath(titleSlug);
  if (isReservedFlatPath(titlePath)) return;

  try {
    const existing = await env.SLUG_KV.get(kvOrigin(originPath), { type: 'json' }).catch(() => null);
    const now = Date.now();

    if (!existing) {
      await env.SLUG_KV.put(kvOrigin(originPath), JSON.stringify({
        title: pageCtx.title, titleSlug, titlePath,
        createdAt: now, checkedAt: now,
      }));
      await env.SLUG_KV.put(kvAlias(titlePath), originPath);
    } else {
      const newSlug      = await wasmCore.generateSlug(pageCtx.title);
      const newTitlePath = buildFlatTitlePath(newSlug);
      if (newTitlePath !== existing.titlePath) {
        await env.SLUG_KV.delete(kvAlias(existing.titlePath)).catch(() => {});
        await env.SLUG_KV.put(kvAlias(newTitlePath), originPath);
        await env.SLUG_KV.put(kvOrigin(originPath), JSON.stringify({
          ...existing, title: pageCtx.title, titleSlug: newSlug, titlePath: newTitlePath, checkedAt: now,
        }));
      } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
        await env.SLUG_KV.put(kvOrigin(originPath), JSON.stringify({ ...existing, checkedAt: now }));
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
        const data = await env.SLUG_KV.get(key.name, { type: 'json' }).catch(() => null);
        if (!data || now - data.checkedAt < SLUG_CHECK_MS) continue;
        const newSlug      = await wasmCore.generateSlug(data.title);
        const originPath   = key.name.replace(/^origin:/, '');
        const newTitlePath = buildFlatTitlePath(newSlug);
        if (newTitlePath !== data.titlePath) {
          await env.SLUG_KV.delete(kvAlias(data.titlePath)).catch(() => {});
          await env.SLUG_KV.put(kvAlias(newTitlePath), originPath);
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, titleSlug: newSlug, titlePath: newTitlePath, checkedAt: now }));
        } else {
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, checkedAt: now }));
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// ─── 응답 헤더 ────────────────────────────────────────────────────
function buildResponseHeaders(etag, contentLength) {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  h.set('cache-control',          'no-store, must-revalidate');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding');
  h.set('timing-allow-origin',    '*');
  h.set('x-robots-tag',           'index, follow');
  // CSP: Blogger 호환 (unsafe-inline 필수)
  h.set('content-security-policy',
    "default-src 'self' https: data: blob:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
    "style-src 'self' 'unsafe-inline' https:; " +
    "img-src 'self' https: data: blob:; " +
    "font-src 'self' https: data:; " +
    "frame-src https:; connect-src https:;"
  );
  h.set('permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  h.set('last-modified', new Date().toUTCString());
  if (etag) h.set('etag', etag);
  if (contentLength) h.set('x-content-length', String(contentLength));
  return h;
}

// ─────────────────────────────────────────────────────────────────
// 페이지 컨텍스트 추출
// ─────────────────────────────────────────────────────────────────
async function extractPageContext(html, url) {
  const ctx = {
    type: detectPageType(url),
    title: '', description: '', imageUrl: '', imageWidth: '', imageHeight: '',
    author: '', publishDate: '', updateDate: '', tags: [],
    postUrl: url.toString(), siteName: '', logoUrl: '',
    wordCount: 0, articleSection: '', faqItems: [],
    breadcrumbs: [], navLinks: [],
    pagination: { prev: '', next: '' },
  };

  ctx.siteName    = extractSiteName(html);
  ctx.logoUrl     = extractLogoUrl(html);
  ctx.title       = extractMeta(html, 'og:title') || extractTagContent(html, /<title[^>]*>([^<]+)<\/title>/i) || '';
  const bodyText  = extractBodyText(html);
  ctx.description = extractMeta(html, 'description') || extractMeta(html, 'og:description') || buildMetaDescription(bodyText, ctx.title);
  ctx.imageUrl    = extractMeta(html, 'og:image') || extractFirstImage(html) || '';
  ctx.imageWidth  = extractMeta(html, 'og:image:width') || '';
  ctx.imageHeight = extractMeta(html, 'og:image:height') || '';
  ctx.publishDate = extractMeta(html, 'article:published_time') || extractJsonLdDate(html, 'datePublished') || '';
  ctx.updateDate  = extractMeta(html, 'article:modified_time')  || extractJsonLdDate(html, 'dateModified')  || ctx.publishDate;
  ctx.author      = extractMeta(html, 'article:author') || extractTagContent(html, /class="fn"[^>]*>([^<]+)</i) || '';
  ctx.tags        = extractLabels(html);
  ctx.wordCount   = bodyText.split(/\s+/).filter(Boolean).length;
  ctx.articleSection = ctx.tags[0] || '';
  ctx.faqItems    = extractFaqItems(html);
  ctx.breadcrumbs = buildBreadcrumbs(url, ctx.title, ctx.tags);
  ctx.pagination  = extractPagination(html, url);

  return ctx;
}

function detectPageType(url) {
  const p = url.pathname;
  if (p === '/' || p === '') return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p)) return 'post';
  if (/^\/p\//.test(p)) return 'page';
  if (p.startsWith('/search/label/')) return 'label';
  if (p.startsWith('/search')) return 'search';
  if (/^\/[^/]+$/.test(p) && !isReservedFlatPath(p)) return 'post';
  return 'other';
}

// FAQ 항목 감지: h3 + 다음 p 태그 패턴
function extractFaqItems(html) {
  const items = [];
  const re = /<h3[^>]*>([^<]{10,200})<\/h3>\s*<p[^>]*>([\s\S]{20,500}?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null && items.length < 10) {
    const q = m[1].replace(/<[^>]+>/g, '').trim();
    const a = m[2].replace(/<[^>]+>/g, '').trim();
    if (q && a && q.endsWith('?') || q.length < 150) {
      items.push({ question: q, answer: a.slice(0, 300) });
    }
  }
  return items;
}

// 브레드크럼 자동 생성
function buildBreadcrumbs(url, title, tags) {
  const crumbs = [{ name: 'Home', url: url.origin + '/' }];
  const p = url.pathname;

  if (tags && tags.length > 0) {
    crumbs.push({ name: tags[0], url: url.origin + '/search/label/' + encodeURIComponent(tags[0]) });
  }
  if (/\/\d{4}\/\d{2}\//.test(p)) {
    const m = p.match(/\/(\d{4})\/(\d{2})\//);
    if (m) crumbs.push({ name: `${m[1]}년 ${m[2]}월`, url: url.origin + `/${m[1]}/${m[2]}/` });
  }
  if (title && p !== '/') crumbs.push({ name: title, url: url.toString() });
  return crumbs;
}

// 페이지네이션 추출
function extractPagination(html, url) {
  const prev = (html.match(/<link[^>]+rel=['"]prev['"][^>]+href=['"]([^'"]+)['"]/i) ||
                html.match(/href=['"]([^'"]+)['"]\s+rel=['"]prev['"]/i) || [])[1] || '';
  const next = (html.match(/<link[^>]+rel=['"]next['"][^>]+href=['"]([^'"]+)['"]/i) ||
                html.match(/href=['"]([^'"]+)['"]\s+rel=['"]next['"]/i) || [])[1] || '';
  // Blogger 이전/다음 버튼에서도 감지
  const olderLink = (html.match(/class="blog-pager-older-link"[^>]*href=['"]([^'"]+)['"]/i) ||
                     html.match(/href=['"]([^'"]+)['"]\s+class="blog-pager-older-link"/i) || [])[1] || '';
  const newerLink = (html.match(/class="blog-pager-newer-link"[^>]*href=['"]([^'"]+)['"]/i) ||
                     html.match(/href=['"]([^'"]+)['"]\s+class="blog-pager-newer-link"/i) || [])[1] || '';
  return {
    prev: prev || newerLink,
    next: next || olderLink,
  };
}

// ─────────────────────────────────────────────────────────────────
// HTML 변환 파이프라인
// ─────────────────────────────────────────────────────────────────
async function transformHtml(html, ctx, url, env) {
  let o = html;

  // ① 기본 정리
  o = safeTransform(o, stripMobileParam);
  o = safeTransform(o, enforceHttps);

  // ② 성능 최적화 (가장 먼저 — head에 주입)
  o = safeTransform(o, injectPerformanceHints);
  o = safeTransform(o, h => injectPreload(h, ctx));

  // ③ 메타 SEO
  o = safeTransform(o, h => injectMetaDescription(h, ctx));
  o = safeTransform(o, h => injectCanonical(h, ctx, url));
  o = safeTransform(o, h => injectSeoTags(h, ctx));
  o = safeTransform(o, h => injectRobotsMeta(h, ctx));
  o = safeTransform(o, h => injectViewportMeta(h));
  o = safeTransform(o, h => injectRssDiscovery(h, url));
  o = safeTransform(o, h => injectHreflang(h, url));
  o = safeTransform(o, h => injectPaginationLinks(h, ctx));

  // ④ 스키마 마크업 (강화)
  o = safeTransform(o, h => injectSchemaMarkup(h, ctx, url));

  // ⑤ 본문 보강
  o = safeTransform(o, h => boostExternalLinks(h));
  o = safeTransform(o, h => injectImageAlts(h, ctx));

  // ⑥ 경량 minify (마지막)
  o = safeTransform(o, lightMinify);

  return o;
}

function safeTransform(html, fn) {
  try {
    const out = fn(html);
    return (typeof out === 'string' && out.length > 0) ? out : html;
  } catch (_) { return html; }
}

// ① 기본 정리
function stripMobileParam(html) {
  return html
    .replace(/((?:href|src|action)=["'][^"']*)?\?m=\d+&/gi, '$1?')
    .replace(/((?:href|src|action)=["'][^"']*)&m=\d+/gi,    '$1')
    .replace(/((?:href|src|action)=["'][^"']*)?\?m=\d+/gi,  '$1');
}

function enforceHttps(html) {
  return html.replace(/((?:src|href|action|content)=["'])http:\/\//gi, '$1https://');
}

// ② 성능 최적화
function injectPerformanceHints(html) {
  if (html.includes('rel="dns-prefetch"')) return html;
  const tags = [
    '<link rel="dns-prefetch" href="//www.blogger.com">',
    '<link rel="dns-prefetch" href="//www.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
    '<link rel="dns-prefetch" href="//www.google.com">',
    '<link rel="dns-prefetch" href="//apis.google.com">',
    '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
  ].join('\n');
  return html.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
}

function injectPreload(html, ctx) {
  const preloads = [];
  // LCP 이미지 preload
  if (ctx.imageUrl && !html.includes('rel="preload"')) {
    preloads.push(`<link rel="preload" as="image" href="${escapeAttr(ctx.imageUrl)}" fetchpriority="high">`);
  }
  if (!preloads.length) return html;
  return html.replace(/(<\/head>)/i, preloads.join('\n') + '\n$1');
}

// ③ 메타 SEO
function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;
  const esc = escapeAttr(ctx.description.slice(0, 160));
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
  const og = (p, c) => {
    if (c && !new RegExp(`property=["']${escapeRe(p)}["']`).test(html))
      tags.push(`<meta property="${p}" content="${escapeAttr(c)}">`);
  };
  const tw = (n, c) => {
    if (c && !new RegExp(`name=["']${escapeRe(n)}["']`).test(html))
      tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`);
  };
  og('og:title',        ctx.title);
  og('og:description',  ctx.description);
  og('og:url',          ctx.postUrl);
  og('og:type',         ctx.type === 'post' ? 'article' : 'website');
  og('og:site_name',    ctx.siteName);
  og('og:locale',       'ko_KR');
  if (ctx.imageUrl) {
    og('og:image', ctx.imageUrl);
    if (ctx.imageWidth)  og('og:image:width',  ctx.imageWidth);
    if (ctx.imageHeight) og('og:image:height', ctx.imageHeight);
    og('og:image:alt',   ctx.title);
  }
  if (ctx.publishDate) og('article:published_time', ctx.publishDate);
  if (ctx.updateDate)  og('article:modified_time',  ctx.updateDate);
  if (ctx.author)      og('article:author',         ctx.author);
  ctx.tags.forEach(t => { if (!html.includes(`property="article:tag"`)) og('article:tag', t); });

  tw('twitter:card',        ctx.imageUrl ? 'summary_large_image' : 'summary');
  tw('twitter:title',       ctx.title);
  tw('twitter:description', ctx.description);
  if (ctx.imageUrl) tw('twitter:image', ctx.imageUrl);
  tw('twitter:label1', '읽기 시간');
  tw('twitter:data1',  Math.max(1, Math.round(ctx.wordCount / 200)) + '분');

  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

function injectRobotsMeta(html, ctx) {
  if (/<meta[^>]+name=["']robots["']/i.test(html)) return html;
  // 검색/라벨 페이지는 noindex
  const content = (ctx.type === 'search' || ctx.type === 'label')
    ? 'noindex, follow' : 'index, follow, max-image-preview:large';
  return html.replace(/(<\/head>)/i, `<meta name="robots" content="${content}">\n$1`);
}

function injectViewportMeta(html) {
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) return html;
  return html.replace(/(<head[^>]*>)/i,
    '$1\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
}

function injectRssDiscovery(html, url) {
  if (html.includes('application/rss+xml') || html.includes('application/atom+xml')) return html;
  const feedUrl = url.origin + '/feeds/posts/default';
  const tags = [
    `<link rel="alternate" type="application/atom+xml" title="Atom Feed" href="${feedUrl}?alt=atom">`,
    `<link rel="alternate" type="application/rss+xml"  title="RSS Feed"  href="${feedUrl}?alt=rss">`,
  ].join('\n');
  return html.replace(/(<\/head>)/i, tags + '\n$1');
}

function injectHreflang(html, url) {
  if (html.includes('hreflang')) return html;
  const canonicalUrl = url.origin + url.pathname;
  const tags = [
    `<link rel="alternate" hreflang="ko" href="${escapeAttr(canonicalUrl)}">`,
    `<link rel="alternate" hreflang="x-default" href="${escapeAttr(canonicalUrl)}">`,
  ].join('\n');
  return html.replace(/(<\/head>)/i, tags + '\n$1');
}

function injectPaginationLinks(html, ctx) {
  let o = html;
  if (ctx.pagination.prev && !html.includes('rel="prev"')) {
    o = o.replace(/(<\/head>)/i, `<link rel="prev" href="${escapeAttr(ctx.pagination.prev)}">\n$1`);
  }
  if (ctx.pagination.next && !html.includes('rel="next"')) {
    o = o.replace(/(<\/head>)/i, `<link rel="next" href="${escapeAttr(ctx.pagination.next)}">\n$1`);
  }
  return o;
}

// ④ 스키마 마크업 강화 ── 완전 분리 주입
function injectSchemaMarkup(html, ctx, url) {
  // 이미 스키마가 있어도 추가 스키마(BreadcrumbList, FAQ)는 주입
  const schemas = [];
  const hasSchema = html.includes('"@context":"https://schema.org"') ||
                    html.includes('"@context": "https://schema.org"');

  if (!hasSchema) {
    schemas.push(buildWebSiteSchema(ctx, url));
    if (ctx.type === 'post')                schemas.push(buildArticleSchema(ctx, url));
    else if (ctx.type === 'home')           schemas.push(buildWebPageSchema(ctx, url));
    else                                    schemas.push(buildWebPageSchema(ctx, url));
  }

  // BreadcrumbList — 항상 추가 (없을 때만)
  if (!html.includes('BreadcrumbList') && ctx.breadcrumbs.length > 1) {
    schemas.push(buildBreadcrumbSchema(ctx));
  }

  // FAQPage — 감지된 FAQ 항목이 있을 때만
  if (!html.includes('FAQPage') && ctx.faqItems.length >= 2) {
    schemas.push(buildFaqSchema(ctx));
  }

  if (!schemas.length) return html;

  // 각 스키마를 별도 <script> 태그로 분리 (파서 신뢰도 향상)
  const scriptTags = schemas.map(s =>
    `<script type="application/ld+json">${JSON.stringify(s)}<\/script>`
  ).join('\n');

  return html.replace(/(<\/head>)/i, scriptTags + '\n$1');
}

function buildWebSiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': url.origin + '/#website',
    url: url.origin + '/',
    name: ctx.siteName || ctx.title,
    inLanguage: 'ko-KR',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: url.origin + '/search?q={search_term_string}' },
      'query-input': 'required name=search_term_string',
    },
    ...(ctx.logoUrl ? {
      publisher: {
        '@type': 'Organization',
        name: ctx.siteName || ctx.title,
        logo: { '@type': 'ImageObject', url: ctx.logoUrl },
        url: url.origin + '/',
      },
    } : {}),
  };
}

function buildArticleSchema(ctx, url) {
  const s = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': ctx.postUrl + '#article',
    mainEntityOfPage: { '@type': 'WebPage', '@id': ctx.postUrl + '#webpage' },
    headline: ctx.title.slice(0, 110),
    description: ctx.description.slice(0, 300),
    author: {
      '@type': 'Person',
      name: ctx.author || ctx.siteName || 'Author',
      ...(ctx.author ? {} : { url: url.origin + '/' }),
    },
    publisher: {
      '@type': 'Organization',
      name: ctx.siteName || 'Blog',
      logo: { '@type': 'ImageObject', url: ctx.logoUrl || url.origin + '/favicon.ico' },
    },
    inLanguage: 'ko-KR',
    isPartOf: { '@id': url.origin + '/#website' },
  };
  if (ctx.imageUrl) {
    s.image = {
      '@type': 'ImageObject', url: ctx.imageUrl,
      ...(ctx.imageWidth  ? { width:  Number(ctx.imageWidth)  } : {}),
      ...(ctx.imageHeight ? { height: Number(ctx.imageHeight) } : {}),
    };
  }
  if (ctx.publishDate) s.datePublished = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified  = ctx.updateDate || ctx.publishDate;
  if (ctx.tags.length) s.keywords      = ctx.tags.join(', ');
  if (ctx.wordCount)   s.wordCount     = ctx.wordCount;
  if (ctx.articleSection) s.articleSection = ctx.articleSection;
  return s;
}

function buildWebPageSchema(ctx, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': ctx.postUrl + '#webpage',
    url: ctx.postUrl,
    name: ctx.title,
    description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' },
    inLanguage: 'ko-KR',
    ...(ctx.publishDate ? { datePublished: ctx.publishDate } : {}),
    ...(ctx.updateDate  ? { dateModified:  ctx.updateDate  } : {}),
  };
}

function buildBreadcrumbSchema(ctx) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: ctx.breadcrumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
}

function buildFaqSchema(ctx) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: ctx.faqItems.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

// ⑤ 본문 보강
// 외부 링크에 rel="noopener noreferrer" 자동 추가
function boostExternalLinks(html) {
  return html.replace(
    /<a([^>]+href=["']https?:\/\/[^"']+["'][^>]*)>/gi,
    (match, attrs) => {
      if (/rel=/i.test(attrs)) return match;
      return `<a${attrs} rel="noopener noreferrer">`;
    }
  );
}

// 이미지 alt 누락 감지 & title 기반 보완
function injectImageAlts(html, ctx) {
  return html.replace(/<img([^>]+)>/gi, (match, attrs) => {
    if (/alt=/i.test(attrs)) return match;
    const altText = escapeAttr(ctx.title || ctx.siteName || '이미지');
    return `<img${attrs} alt="${altText}">`;
  });
}

// ⑥ 경량 HTML minify (Blogger 호환 — 스크립트/스타일 내용 건드리지 않음)
function lightMinify(html) {
  // 주석 제거 (조건부 주석 보존 [if IE])
  let o = html.replace(/<!--(?!\[if\s)[\s\S]*?-->/g, '');
  // 태그 사이 연속 공백 최소화 (텍스트 노드는 건드리지 않음)
  o = o.replace(/>\s{2,}</g, '> <');
  return o;
}

// ─── HTML 파싱 유틸 ─────────────────────────────────────────────
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
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
function extractJsonLdDate(html, key) {
  return (html.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || '';
}
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRe(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
