/**
 * BloggerSEO Worker v5
 * ─────────────────────────────────────────────────────────────────────
 * 변경 요약 (v4→v5):
 *   1) blog-post 버그 수정: alias 경로로 내부 fetch할 때 originPath로 KV 등록하도록
 *   2) GitHub API 완전 제거 (github-tenant.js 삭제)
 *   3) KV 사용 대폭 감소 (요청당 최대 1회 읽기, 슬러그 변경 없으면 쓰기 0회)
 *   4) CNAME/레이트리밋/메트릭 → 인스턴스 메모리 (KV 사용 0)
 *   5) CACHE_RESERVE_KV 제거 (의존성 단순화)
 *   6) WASM v5 슬러그 버그 수정 (한글 제목 → slug 정상 생성)
 *   7) 성능: origin fetch 동시성 게이트, 재시도, HTTP3
 *   8) Python 자동화 스크립트: scripts/deploy.py, scripts/slug_audit.py 추가
 */

import { wasmCore } from './src/wasm-loader.js';
import {
  cnameGet, cnameSet,
  checkRateLimit,
  recordMetric, getMetrics,
  slugOriginGet, slugAliasGet, upsertSlug,
  purgeAllSlugs,
} from './src/store.js';

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const GHS_TARGET = 'ghs.google.com';
const DOH_URL    = 'https://1.1.1.1/dns-query';

// 동시성 게이트 (인스턴스 레벨)
let _inFlight = 0;
const MAX_INFLIGHT = 48;

// ─────────────────────────────────────────────
// FNV-1a (ETag용, WASM 없이 동작)
// ─────────────────────────────────────────────
function fnv1a32Hex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= str.length; h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(wasmCore.warmup());
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return errResp(502, 'Worker exception: ' + String(e?.message ?? e));
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
  const t0   = Date.now();

  // ── 디버그/관리 엔드포인트 ────────────────────
  if (path === '/__blogger_debug') return bloggerDebug(url, env);
  if (path === '/__metrics')       return new Response(JSON.stringify(getMetrics(), null, 2), jsonHeaders());
  if (path === '/__purge_all')     return purgeAll(env);

  // ── CNAME 워밍 (메모리 캐시, KV 0회) ─────────
  ctx.waitUntil(warmCname(host).catch(() => {}));

  // ── 레이트 리밋 (메모리, KV 0회) ──────────────
  const rlLimit = Number(env.RATE_LIMIT_PER_MIN) || 600;
  const rl = checkRateLimit(host, rlLimit);
  if (!rl.allowed) {
    recordMetric(429, Date.now() - t0);
    return errResp(429, 'Too Many Requests');
  }

  // ── 정적 자산 / Feed 직통 ─────────────────────
  if (isPassthrough(path, url)) {
    const resp = await proxyPass(url, request);
    recordMetric(resp.status, Date.now() - t0);
    return resp;
  }

  // ── 캐시 우회 ─────────────────────────────────
  if (shouldBypassCache(request, url, path)) {
    const resp = await proxyPass(url, request);
    recordMetric(resp.status, Date.now() - t0);
    return resp;
  }

  // ── 슬러그 라우팅 (KV 최대 1회 읽기) ──────────
  let slugRoute = { type: 'passthrough' };
  // originPath = 실제 Blogger 원본 경로 (alias 통해 온 경우에도 보존)
  let originPathForKV = path;
  try {
    slugRoute = await resolveSlugRoute(path, env);
    if (slugRoute.type === 'redirect') {
      return Response.redirect(new URL(slugRoute.titlePath, url).toString(), 301);
    }
    if (slugRoute.type === 'alias') {
      // [v5 핵심 수정] alias로 들어온 경우 originPath를 fetch URL이 아니라
      // KV에서 찾은 실제 blogspot 원본 경로로 저장 → blog-post 버그 제거
      originPathForKV = slugRoute.originPath;
    }
  } catch (_) {}

  // ── Origin Fetch ──────────────────────────────
  let fetchUrl = new URL(url.toString());
  if (slugRoute.type === 'alias') fetchUrl.pathname = slugRoute.originPath;

  if (_inFlight >= MAX_INFLIGHT) {
    recordMetric(503, Date.now() - t0);
    return errResp(503, 'Too busy');
  }
  _inFlight++;

  let originResp;
  try {
    originResp = await fetchWithRetry(() => bloggerFetch(fetchUrl, request.headers));
  } catch (e) {
    _inFlight--;
    recordMetric(502, Date.now() - t0);
    return errResp(502, 'Fetch failed: ' + String(e?.message ?? e));
  }
  _inFlight--;

  // 3xx 그대로 반환
  if (originResp.status >= 300 && originResp.status < 400) {
    recordMetric(originResp.status, Date.now() - t0);
    return stripInternalHeaders(originResp);
  }
  if (originResp.status >= 500) {
    recordMetric(originResp.status, Date.now() - t0);
    return errResp(originResp.status, 'Origin error ' + originResp.status);
  }
  if (!isHtml(originResp) || !originResp.ok) {
    recordMetric(originResp.status, Date.now() - t0);
    return stripInternalHeaders(originResp);
  }

  // ── HTML 파이프라인 ────────────────────────────
  let html;
  try { html = await originResp.text(); }
  catch (e) { return errResp(502, 'Body read failed'); }

  let pageCtx = null;
  let result = html;
  try {
    pageCtx = await extractPageContext(html, url);
    result  = await transformHtml(html, pageCtx, url);
    if (!result || typeof result !== 'string') result = html;
  } catch (_) { result = html; pageCtx = null; }

  // ── ETag / 304 ────────────────────────────────
  let etag = '';
  const hasCookie = !!request.headers.get('cookie');
  if (!hasCookie) {
    try {
      etag = `"${fnv1a32Hex(result)}"`;
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        recordMetric(304, Date.now() - t0);
        return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store, must-revalidate' } });
      }
    } catch (_) { etag = ''; }
  }

  // ── 비동기 후처리 ─────────────────────────────
  // [v5] originPathForKV = alias 통해 온 경우 실제 /yyyy/mm/x.html 경로
  if (pageCtx) {
    ctx.waitUntil(updateSlugKV(pageCtx, originPathForKV, env).catch(() => {}));
  }

  recordMetric(200, Date.now() - t0);
  return new Response(result, { status: 200, headers: buildResponseHeaders(etag) });
}

// ─────────────────────────────────────────────
// 슬러그 라우팅
// ─────────────────────────────────────────────
function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

function isReservedFlatPath(p) {
  if (p === '/' || p === '') return true;
  if (p.startsWith('/feeds/') || p.startsWith('/b/') || p.startsWith('/admin')) return true;
  if (p.startsWith('/search')) return true;
  if (p === '/ncr' || p === '/__blogger_debug' || p === '/__purge_all' || p === '/__metrics') return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(p)) return true;
  if (p === '/atom.xml' || p === '/rss.xml') return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json|html?)$/i.test(p)) return true;
  return false;
}

// [v5] KV 최대 1회 읽기
async function resolveSlugRoute(path, env) {
  if (!env.SLUG_KV) return { type: 'passthrough' };

  if (isPostPath(path)) {
    const rec = await slugOriginGet(env, path);        // KV 읽기 1회
    if (rec?.titlePath && rec.titlePath !== path) {
      return { type: 'redirect', titlePath: rec.titlePath };
    }
    return { type: 'passthrough' };
  }

  if (/^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    const originPath = await slugAliasGet(env, path);  // KV 읽기 1회
    if (originPath && originPath !== path) {
      return { type: 'alias', originPath };
    }
  }

  return { type: 'passthrough' };
}

// ─────────────────────────────────────────────
// 슬러그 KV 등록/갱신
// [v5] originPath = 항상 실제 blogspot 경로 (/yyyy/mm/x.html)
//       절대 alias 경로(/제목)가 들어오지 않음
// ─────────────────────────────────────────────
async function updateSlugKV(pageCtx, originPath, env) {
  if (!env.SLUG_KV) return;
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;
  if (!isPostPath(originPath)) return;  // 안전장치: 실제 blogspot 경로만

  const titleSlug = await wasmCore.generateSlug(pageCtx.title);
  if (!titleSlug || titleSlug === 'post' || titleSlug === 'untitled') return;

  await upsertSlug(env, originPath, pageCtx.title, titleSlug);
}

// ─────────────────────────────────────────────
// 스케줄드: 슬러그 감사
// ─────────────────────────────────────────────
async function runSlugAudit(env) {
  if (!env.SLUG_KV) return;
  try {
    const list = await env.SLUG_KV.list({ prefix: 'slug:origin:' });
    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data || !data.title) continue;
        const newSlug = await wasmCore.generateSlug(data.title);
        if (!newSlug || newSlug === 'post') continue;
        const newTitlePath = '/' + newSlug;
        const originPath = key.name.replace(/^slug:origin:/, '');
        if (newTitlePath !== data.titlePath) {
          await upsertSlug(env, originPath, data.title, newSlug);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// CNAME (메모리 캐시, KV 0회)
// ─────────────────────────────────────────────
async function warmCname(host) {
  const cached = cnameGet(host);
  if (cached !== null) return cached;
  const ok = await checkCnameGhs(host).catch(() => false);
  cnameSet(host, ok);
  return ok;
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
    const n = cname.replace(/\.$/, '').toLowerCase();
    if (n === GHS_TARGET) return true;
    current = n;
  }
  return false;
}

async function dnsCname(host) {
  const resp = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`, {
    headers: { accept: 'application/dns-json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const rec = (data?.Answer || []).find(r => r.type === 5);
  return rec ? String(rec.data) : null;
}

// ─────────────────────────────────────────────
// Blogger Fetch
// ─────────────────────────────────────────────
async function bloggerFetch(url, reqHeaders) {
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

  return fetch(targetUrl, {
    method: 'GET',
    headers,
    redirect: 'manual',
    cf: { resolveOverride: GHS_TARGET, cacheTtl: 0, cacheEverything: false, http3: true },
  });
}

async function fetchWithRetry(fn, maxRetries = 2) {
  let lastErr, lastResp;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fn();
      if (resp && ![502, 503, 504].includes(resp.status)) return resp;
      lastResp = resp;
      if (attempt === maxRetries) return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) throw e;
    }
    await new Promise(r => setTimeout(r, 60 * Math.pow(2, attempt) + Math.random() * 60));
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

// ─────────────────────────────────────────────
// 프록시 유틸
// ─────────────────────────────────────────────
async function proxyPass(url, request) {
  try {
    const resp = await fetchWithRetry(() => bloggerFetch(url, request.headers), 1);
    return stripInternalHeaders(resp, isPassthrough(url.pathname, url));
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + String(e?.message ?? e));
  }
}

function stripInternalHeaders(resp, isStaticAsset) {
  try {
    const h = new Headers(resp.headers);
    ['cf-cache-status', 'cf-ray', 'nel', 'report-to', 'server'].forEach(k => h.delete(k));
    if (isStaticAsset && resp.ok) {
      const cc = h.get('cache-control') || '';
      if (!cc || /no-store|no-cache|max-age=0/i.test(cc)) {
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

function jsonHeaders() {
  return { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
}

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/') || path === '/atom.xml' || path === '/rss.xml') return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path)) return true;
  if (url.searchParams.has('alt')) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) { return (resp.headers.get('content-type') || '').includes('text/html'); }

function shouldBypassCache(request, url, path) {
  if (!['GET', 'HEAD'].includes(request.method)) return true;
  if (request.headers.get('cache-control') === 'no-cache') return true;
  if (path.startsWith('/b/') || path.startsWith('/admin') || path === '/ncr') return true;
  if (url.searchParams.has('blogedit') || url.searchParams.has('postID') ||
      url.searchParams.has('action') || url.searchParams.has('widgetType')) return true;
  if (path.startsWith('/search') && url.searchParams.has('q')) return true;
  return false;
}

// ─────────────────────────────────────────────
// 응답 헤더
// ─────────────────────────────────────────────
function buildResponseHeaders(etag) {
  const h = new Headers();
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store, must-revalidate');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'SAMEORIGIN');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('vary', 'Accept-Encoding, Cookie');
  if (etag) h.set('etag', etag);
  return h;
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인
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

function safeTransform(html, fn) {
  try { const out = fn(html); return (typeof out === 'string' && out.length > 0) ? out : html; }
  catch (_) { return html; }
}

function stripMobileParam(html) {
  return html
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+&/gi, '$1?')
    .replace(/((?:href|src|action)=["'][^"']*)&m=\d+/gi, '$1')
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+/gi, '$1');
}

function enforceHttps(html) {
  return html.replace(/((?:src|href)=["'])http:\/\//gi, '$1https://');
}

function injectPerformanceOptimizations(html) {
  if (html.includes('rel="dns-prefetch"')) return html;
  const tags = [
    '<link rel="dns-prefetch" href="//www.blogger.com">',
    '<link rel="dns-prefetch" href="//www.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
    '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  ].join('\n');
  return html.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 추출
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
  ctx.updateDate  = extractMeta(html, 'article:modified_time') || extractJsonLdDate(html, 'dateModified') || ctx.publishDate;
  ctx.author      = extractMeta(html, 'article:author') || extractTagContent(html, /class="fn"[^>]*>([^<]+)</i) || '';
  ctx.tags        = extractLabels(html);
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
  const tw = (n, c) => { if (c && !new RegExp(`name=["']${escapeRe(n)}["']`).test(html)) tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`); };
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
  if (html.includes('"@context":"https://schema.org"') || html.includes('"@context": "https://schema.org"')) return html;
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
  if (ctx.imageUrl)    s.image = { '@type': 'ImageObject', url: ctx.imageUrl };
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
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`,    'i')) || []
  )[1] || '';
}
function extractTagContent(html, re) { return (html.match(re) || ['', ''])[1].trim(); }
function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
function buildMetaDescription(bodyText, title) {
  let t = title ? bodyText.replace(title, '').trim() : bodyText;
  if (t.length > 160) { t = t.slice(0, 160); const l = t.lastIndexOf(' '); if (l > 100) t = t.slice(0, l); t += '…'; }
  return t;
}
function extractFirstImage(html) { return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || ''; }
function extractSiteName(html)   { return extractMeta(html, 'og:site_name') || extractTagContent(html, /<title[^>]*>([^<|]+)/i) || ''; }
function extractLogoUrl(html) {
  return (
    html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) || []
  )[1] || '';
}
function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi; let m;
  while ((m = re.exec(html)) !== null) { const l = m[1].trim(); if (l && !labels.includes(l)) labels.push(l); }
  return labels;
}
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(str)   { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─────────────────────────────────────────────
// 디버그
// ─────────────────────────────────────────────
async function bloggerDebug(url, env) {
  const host = url.hostname;
  let status = 0, ok = false, errorMsg = null;
  try {
    const resp = await fetch(url.origin + '/', {
      method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' },
      redirect: 'manual', cf: { resolveOverride: GHS_TARGET },
    });
    status = resp.status;
    ok = resp.ok || status === 301 || status === 302;
  } catch (e) { errorMsg = String(e?.message ?? e); }

  const cnameOk = cnameGet(host);
  const info = {
    host, resolveOverride: GHS_TARGET, ghsStatus: status, ok,
    cnamePointsToGhs: cnameOk,
    kvUsage: 'slug:origin:* / slug:alias:* (영속 NoSQL)',
    kvCallsPerRequest: 'max 1 read + 0-3 writes (background)',
    githubApi: 'removed in v5',
    wasm: { lastBackend: wasmCore._lastBackend },
    ...(errorMsg ? { error: errorMsg } : {}),
    message: errorMsg ? 'ERROR: ' + errorMsg : ok ? 'OK' : 'FAIL (status=' + status + ')',
  };
  return new Response(JSON.stringify(info, null, 2), {
    status: ok ? 200 : 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─────────────────────────────────────────────
// Purge
// ─────────────────────────────────────────────
async function purgeAll(env) {
  const result = await purgeAllSlugs(env);
  return new Response(JSON.stringify(result), jsonHeaders());
}
