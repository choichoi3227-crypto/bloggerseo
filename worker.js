/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * 설정 제로 — Route 추가만 하면 끝
 *
 * ┌─ 핵심 동작 원리 ───────────────────────────────────────────────┐
 * │  요청 호스트의 CNAME이 ghs.google.com인지 1.1.1.1 DoH로 검증. │
 * │  검증된 커스텀 도메인 → ghs.google.com HEAD로 blogspot URL    │
 * │  추출 → blogspot.com으로 직접 fetch → 콘텐츠 반환.            │
 * │                                                                  │
 * │  CNAME 검증 결과는 KV에 캐시 (24h) → 이후 요청 즉시 통과.     │
 * │  origin URL은 KV에 캐시 (30d) → 탐지는 최초 1회만.            │
 * │  검증 실패 시 → 502 Bad Gateway.                               │
 * └──────────────────────────────────────────────────────────────────┘
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CACHE_TTL        = 30 * 60;
const CNAME_CACHE_TTL  = 24 * 3600 * 1000;
const SLUG_CHECK_MS    = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY     = 0.25;
const LB_RTT_TTL       = 60;
const GHS_CNAME_TARGET = 'ghs.google.com';
const DOH_URL          = 'https://1.1.1.1/dns-query';

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvCname = h => 'cname_ok:' + h;
const kvRtt   = o => 'lb:rtt:'   + o;
const kvBw    = o => 'lb:bw:'    + o;

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return errResp(502, 'Worker exception: ' + String(e && e.message || e));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env));
  },
};

async function handleFetch(request, env, ctx) {
  const url  = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;

  // ── 디버그 엔드포인트 /__blogger_debug ────────
  if (path === '/__blogger_debug') {
    return bloggerDebug(url, env);
  }

  // ── CNAME 검증 ────────────────────────────────
  const isValid = await isBloggerDomain(host, env, ctx);
  if (!isValid) {
    return errResp(502, 'CNAME validation failed: ' + host + ' does not point to ghs.google.com');
  }

  // ── 1. 정적 자산 / Feed / Sitemap 직통 ──────
  if (isPassthrough(path, url)) {
    return proxyPass(url, request, env);
  }

  // ── 2. 슬러그 canonical 리다이렉트 ──────────
  const slugRedir = await checkSlugRedirect(path, url, env);
  if (slugRedir) return slugRedir;

  // ── 3. KV Cache Reserve ──────────────────────
  const cacheKey = buildCacheKey(url);
  const cached   = await getCacheReserve(cacheKey, env);
  if (cached) {
    return new Response(cached.body, { status: 200, headers: buildCachedHeaders(cached.headers) });
  }

  // ── 4. Origin Fetch ──────────────────────────
  let originResp;
  const t0 = Date.now();
  try {
    originResp = await bloggerFetch(url, 'GET', request.headers, null, env);
  } catch (e) {
    return errResp(502, 'Fetch failed: ' + e.message);
  }
  const rtt = Date.now() - t0;
  ctx.waitUntil(lbRecordRtt(host, rtt, env));

  if (originResp.status >= 500) return errResp(originResp.status, 'Origin error ' + originResp.status);
  if (!isHtml(originResp) || !originResp.ok) return stripInternalHeaders(originResp);

  // ── 5. HTML 파이프라인 ────────────────────────
  const html = await originResp.text();
  let result, pageCtx;
  try {
    pageCtx = extractPageContext(html, url);
    result  = transformHtml(html, pageCtx, url);
  } catch (_) {
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ── 6. 비동기 후처리 ──────────────────────────
  const respHeaders = buildResponseHeaders();
  ctx.waitUntil(updateSlugKV(pageCtx, url, env));
  ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));
  ctx.waitUntil(lbRecordBandwidth(host, result.length, env));

  return new Response(result, { status: 200, headers: respHeaders });
}

// ─────────────────────────────────────────────
// CNAME 검증
// ─────────────────────────────────────────────
async function isBloggerDomain(host, env, ctx) {
  try {
    const raw = env.SLUG_KV ? await env.SLUG_KV.get(kvCname(host)) : null;
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < CNAME_CACHE_TTL) return true;
      env.SLUG_KV.delete(kvCname(host)).catch(() => {});
    }
  } catch (_) {}

  const ok = await checkCnameGhs(host);

  if (ok) {
    try {
      if (env.SLUG_KV) {
        ctx.waitUntil(
          env.SLUG_KV.put(kvCname(host), JSON.stringify({ ok: true, ts: Date.now() }), { expirationTtl: 86400 })
        );
      }
    } catch (_) {}
  }

  return ok;
}

const CF_IP_RANGES_V4 = [
  [0x671503FC, 22],
  [0x671603C8, 22],
  [0x671F0400, 22],
  [0x68100000, 13],
  [0x68180000, 14],
  [0x6CA2C000, 18],
  [0x830048,   22],
  [0xA29E0000, 15],
  [0xAC400000, 13],
  [0xADF53000, 20],
  [0xBC720000, 20],
  [0xBE5DF000, 20],
  [0xC5EAF000, 22],
  [0xC6298000, 17],
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function isCfIp(ip) {
  if (ip.includes(':')) return ip.toLowerCase().startsWith('2606:4700') || ip.toLowerCase().startsWith('2400:cb00');
  const n = ipToInt(ip);
  for (const [base, prefix] of CF_IP_RANGES_V4) {
    const mask = prefix === 32 ? 0xFFFFFFFF : ~((1 << (32 - prefix)) - 1) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

async function isProxiedByCf(host) {
  try {
    const resp = await fetch(
      `${DOH_URL}?name=${encodeURIComponent(host)}&type=A`,
      { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 60, cacheEverything: true } }
    );
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data || !Array.isArray(data.Answer)) return false;
    const aRecs = data.Answer.filter(r => r.type === 1).map(r => String(r.data));
    if (aRecs.length === 0) return false;
    return aRecs.every(ip => isCfIp(ip));
  } catch (_) { return false; }
}

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
    if (normalized === GHS_CNAME_TARGET) return true;
    current = normalized;
  }
  const proxied = await isProxiedByCf(host);
  if (proxied) return true;
  return false;
}

async function dnsCname(host) {
  const resp = await fetch(
    `${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`,
    { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !Array.isArray(data.Answer)) return null;
  const rec = data.Answer.find(r => r.type === 5);
  return rec ? String(rec.data) : null;
}

// ─────────────────────────────────────────────
// Blogger origin 탐지 + fetch
//
// ghs.google.com에 HEAD + Host: 커스텀도메인
// → Google이 301 Location: https://xxx.blogspot.com/ 반환
// → 해당 blogspot.com URL로 실제 콘텐츠 fetch
//
// - Worker 재호출 없음 (SNI = ghs.google.com, 525 없음)
// - blogspot.com fetch 시 Google이 커스텀도메인으로 리다이렉트 안 함
// - origin URL은 KV에 30일 캐시 → 탐지는 최초 1회만
// ─────────────────────────────────────────────
async function getOriginUrl(host, env) {
  const kvKey = 'origin:' + host;
  try {
    if (env.SLUG_KV) {
      const cached = await env.SLUG_KV.get(kvKey);
      if (cached) return cached;
    }
  } catch (_) {}

  let origin = null;

  // 1차: ghs.google.com HEAD → 301 Location
  try {
    const resp = await fetch('https://ghs.google.com/', {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        'host':       host,
        'user-agent': 'Mozilla/5.0',
      },
    });
    const loc = resp.headers.get('location') || '';
    const m   = loc.match(/https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i);
    if (m) origin = 'https://' + m[1];
  } catch (_) {}

  // 2차 fallback: ghs.google.com feeds 요청
  if (!origin) {
    try {
      const resp = await fetch('https://ghs.google.com/feeds/posts/default?alt=json&max-results=1', {
        redirect: 'follow',
        headers: {
          'host':       host,
          'user-agent': 'Mozilla/5.0',
        },
      });
      const text = await resp.text().catch(() => '');
      const m = text.match(/https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i);
      if (m) origin = 'https://' + m[1];
    } catch (_) {}
  }

  if (origin) {
    try {
      if (env.SLUG_KV) await env.SLUG_KV.put(kvKey, origin, { expirationTtl: 86400 * 30 });
    } catch (_) {}
  }

  return origin;
}

async function bloggerFetch(url, method, reqHeaders, body, env) {
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs = params.toString() ? '?' + params.toString() : '';

  const origin = await getOriginUrl(url.hostname, env);
  if (!origin) throw new Error('blogspot origin 탐지 실패: ' + url.hostname);

  const targetUrl = origin + url.pathname + qs;

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

  return fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
    redirect: 'follow',
  });
}

// ─────────────────────────────────────────────
// 디버그
// ─────────────────────────────────────────────
async function bloggerDebug(url, env) {
  const host   = url.hostname;
  const origin = await getOriginUrl(host, env);
  const info   = {
    host,
    detectedOrigin: origin,
    message: origin
      ? 'OK: blogspot origin 탐지 성공'
      : 'FAIL: blogspot origin 탐지 실패. Blogger 커스텀 도메인 설정을 확인하세요.',
  };
  return new Response(JSON.stringify(info, null, 2), {
    status: origin ? 200 : 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─────────────────────────────────────────────
// 프록시 유틸
// ─────────────────────────────────────────────
async function proxyPass(url, request, env) {
  try {
    const resp = await bloggerFetch(url, request.method, request.headers, request.body, env);
    return stripInternalHeaders(resp);
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + e.message);
  }
}

function stripInternalHeaders(resp) {
  const h = new Headers(resp.headers);
  h.delete('cf-cache-status');
  h.delete('cf-ray');
  h.delete('nel');
  h.delete('report-to');
  h.delete('server');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function errResp(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type':  'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-error':       message,
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
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path)) return true;
  if (url.searchParams.has('alt'))              return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─────────────────────────────────────────────
// Cache Reserve (KV)
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const s = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (s.toString() ? '?' + s : '');
}

async function getCacheReserve(key, env) {
  if (!env.CACHE_RESERVE_KV) return null;
  try {
    const meta = await env.CACHE_RESERVE_KV.get('meta:' + key, { type: 'json' });
    if (!meta || Date.now() - meta.ts > CACHE_TTL * 1000) {
      if (meta) {
        env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
        env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
      }
      return null;
    }
    const body = await env.CACHE_RESERVE_KV.get('body:' + key);
    return body ? { body, headers: meta.headers } : null;
  } catch (_) { return null; }
}

async function setCacheReserve(key, body, headers, env) {
  if (!env.CACHE_RESERVE_KV) return;
  try {
    const opts = { expirationTtl: CACHE_TTL * 2 };
    await env.CACHE_RESERVE_KV.put('meta:' + key, JSON.stringify({ ts: Date.now(), headers: Object.fromEntries(headers.entries()) }), opts);
    await env.CACHE_RESERVE_KV.put('body:' + key, body, opts);
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 canonical 리다이렉트
// ─────────────────────────────────────────────
async function checkSlugRedirect(path, url, env) {
  if (!isPostPath(path) || !env.SLUG_KV) return null;
  try {
    const canonical = await env.SLUG_KV.get('canonical:' + path);
    if (canonical && canonical !== path) {
      const dest = new URL(url.toString());
      dest.pathname = canonical;
      return Response.redirect(dest.toString(), 301);
    }
  } catch (_) {}
  return null;
}

function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

// ─────────────────────────────────────────────
// 슬러그 KV
// ─────────────────────────────────────────────
async function updateSlugKV(ctx, url, env) {
  if (!env.SLUG_KV) return;
  if (!['post', 'page'].includes(ctx.type) || !ctx.title) return;
  const path = url.pathname, slug = generateSlug(ctx.title);
  try {
    const existing = await env.SLUG_KV.get('slug:' + path, { type: 'json' });
    const now = Date.now();
    if (!existing) {
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ title: ctx.title, slug, path, createdAt: now, checkedAt: now }));
    } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
      const newSlug = generateSlug(ctx.title);
      if (newSlug !== existing.slug) {
        const op = path.replace(/[^/]+\.html$/, existing.slug + '.html');
        const np = path.replace(/[^/]+\.html$/, newSlug + '.html');
        if (op !== np) await env.SLUG_KV.put('canonical:' + op, np);
      }
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ ...existing, slug: newSlug, checkedAt: now }));
    }
  } catch (_) {}
}

async function runSlugAudit(env) {
  if (!env.SLUG_KV) return;
  try {
    const list = await env.SLUG_KV.list({ prefix: 'slug:' });
    const now  = Date.now();
    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data || now - data.checkedAt < SLUG_CHECK_MS) continue;
        const newSlug = generateSlug(data.title);
        if (newSlug !== data.slug) {
          const op = data.path.replace(/[^/]+\.html$/, data.slug + '.html');
          const np = data.path.replace(/[^/]+\.html$/, newSlug   + '.html');
          if (op !== np) await env.SLUG_KV.put('canonical:' + op, np);
        }
        await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, slug: newSlug, checkedAt: now }));
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 생성
// ─────────────────────────────────────────────
function generateSlug(title) {
  if (!title) return 'untitled';
  let s = title.trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/_+/g, '-')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/[^\p{L}\p{N}\-]/gu, '-')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (/[^\x00-\x7F]/.test(s))
    s = encodeURIComponent(s).replace(/%20/g, '-').replace(/%2F/gi, '-');
  return s || 'post';
}

// ─────────────────────────────────────────────
// LB 기록
// ─────────────────────────────────────────────
async function lbRecordRtt(host, rttMs, env) {
  if (!env.SLUG_KV) return;
  try {
    const prev = await env.SLUG_KV.get(kvRtt(host), { type: 'json' });
    const ewma = prev && prev.rtt != null
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await env.SLUG_KV.put(kvRtt(host), JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

async function lbRecordBandwidth(host, bytes, env) {
  if (!env.SLUG_KV) return;
  try {
    const prev = parseInt((await env.SLUG_KV.get(kvBw(host))) || '0', 10);
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await env.SLUG_KV.put(kvBw(host), String(next), { expirationTtl: 86400 });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인
// ─────────────────────────────────────────────
function transformHtml(html, ctx, url) {
  let o = html;
  o = stripMobileParam(o);
  o = enforceHttps(o);
  o = injectMetaDescription(o, ctx);
  o = injectCanonical(o, ctx, url);
  o = injectSchemaMarkup(o, ctx, url);
  o = injectSeoTags(o, ctx, url);
  o = injectPerformanceOptimizations(o);
  return o;
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
  let o = html.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
  o = o.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');
  o = o.replace(/(<script(?![^>]*(defer|async|type=["']application\/ld\+json["']|type=["']text\/template["']))[^>]*src=["'][^"']+["'][^>]*)>/gi, '$1 defer>');
  return o;
}

// ─────────────────────────────────────────────
// 응답 헤더
// ─────────────────────────────────────────────
function buildResponseHeaders() {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  h.set('cache-control',          `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}, stale-while-revalidate=60`);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding');
  return h;
}

function buildCachedHeaders(saved) {
  const h = new Headers(saved || {});
  h.set('x-cache',       'HIT');
  h.set('cache-control', `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`);
  return h;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트
// ─────────────────────────────────────────────
function extractPageContext(html, url) {
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
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p)) return 'post';
  if (/^\/p\//.test(p))                        return 'page';
  if (p.startsWith('/search/label/'))          return 'label';
  if (p.startsWith('/search'))                 return 'search';
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
  const og = (p, c) => { if (c && !new RegExp(`property=["']${p}["']`).test(html)) tags.push(`<meta property="${p}" content="${escapeAttr(c)}">`); };
  const tw = (n, c) => { if (c && !new RegExp(`name=["']${n}["']`).test(html))     tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`); };
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

function extractTagContent(html, re) { return (html.match(re) || ['',''])[1].trim(); }

function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildMetaDescription(bodyText, title) {
  let t = bodyText.replace(title, '').trim();
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
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRe(str)   { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
