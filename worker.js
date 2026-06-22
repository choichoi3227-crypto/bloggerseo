/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * 설정 제로 — Route 추가만 하면 끝
 *
 * ┌─ 핵심 동작 원리 ───────────────────────────────────────────────┐
 * │  요청 호스트의 CNAME이 ghs.google.com인지 1.1.1.1 DoH로 검증. │
 * │  검증된 커스텀 도메인으로 그대로 fetch → Blogger 직접 응답.    │
 * │  blogspot.com 원본 도메인 탐지 불필요.                         │
 * │                                                                  │
 * │  CNAME 검증 결과는 KV에 캐시 (24h) → 이후 요청 즉시 통과.     │
 * │  검증 실패 시 → 502 Bad Gateway (사이트 준비 중 페이지 없음).  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Feed / Sitemap / RSS / Atom ─────────────────────────────────┐
 * │  /feeds/*, /sitemap.xml, /atom.xml, /rss.xml 등 모두          │
 * │  커스텀 도메인으로 직접 fetch → 그대로 반환.                   │
 * └───────────────────────────────────────────────────────────────┘
 *
 * ┌─ 로드 밸런싱 (자체 구현, CF 유료 기능 불사용) ─────────────────┐
 * │  단일 도메인이면 LB 스킵 (오버헤드 제로)                        │
 * │  다중 커스텀 도메인: least_rtt (EWMA 응답속도 최소) [기본]      │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CACHE_TTL        = 30 * 60;          // HTML 캐시 TTL (초)
const CNAME_CACHE_TTL  = 24 * 3600 * 1000; // CNAME 검증 캐시 (ms)
const SLUG_CHECK_MS    = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY     = 0.25;
const LB_RTT_TTL       = 60;
const GHS_CNAME_TARGET = 'ghs.google.com';
const DOH_URL          = 'https://1.1.1.1/dns-query';

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvCname     = h => 'cname_ok:'       + h;
const kvCanonical = h => 'canonical:host:' + h;
const kvRtt       = o => 'lb:rtt:'         + o;
const kvBw        = o => 'lb:bw:'          + o;
const kvRr        = h => 'lb:rr:'          + h;

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

  // ── CNAME 검증 (ghs.google.com 여부) ────────
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
    originResp = await bloggerFetch(url, 'GET', request.headers, null);
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

  // ── 6. 비동기 후처리 (응답 지연 없음) ────────
  const respHeaders = buildResponseHeaders();
  ctx.waitUntil(updateSlugKV(pageCtx, url, env));
  ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));
  ctx.waitUntil(lbRecordBandwidth(host, result.length, env));

  return new Response(result, { status: 200, headers: respHeaders });
}

// ─────────────────────────────────────────────
// CNAME 검증: 1.1.1.1 DoH로 확인
// ghs.google.com을 최종적으로 가리키면 true
// ─────────────────────────────────────────────
async function isBloggerDomain(host, env, ctx) {
  // KV 캐시 먼저 확인
  try {
    const raw = env.SLUG_KV ? await env.SLUG_KV.get(kvCname(host)) : null;
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < CNAME_CACHE_TTL) {
        return parsed.ok;
      }
    }
  } catch (_) {}

  const ok = await checkCnameGhs(host);

  // KV에 저장
  try {
    if (env.SLUG_KV) {
      ctx.waitUntil(
        env.SLUG_KV.put(kvCname(host), JSON.stringify({ ok, ts: Date.now() }), { expirationTtl: 86400 })
      );
    }
  } catch (_) {}

  return ok;
}

// Cloudflare 프록시 IP 대역 (오렌지 클라우드 상태이면 A 레코드가 이 대역)
// https://www.cloudflare.com/ips/
const CF_IP_RANGES_V4 = [
  [0x67100000, 20], // 103.16.0.0/20  (103.16.x.x)  — 실제론 아래 대역이 주요
  [0x671503FC, 22], // 103.21.244.0/22
  [0x671603C8, 22], // 103.22.200.0/22
  [0x671F0400, 22], // 103.31.4.0/22
  [0x68100000, 13], // 104.16.0.0/13
  [0x68180000, 14], // 104.24.0.0/14
  [0x6CA2C000, 18], // 108.162.192.0/18
  [0x830048, 22],   // 131.0.72.0/22
  [0x8D650000, 18], // 141.101.64.0/18 — skip (불필요 복잡)
  [0xA29E0000, 15], // 162.158.0.0/15
  [0xAC400000, 13], // 172.64.0.0/13   ← 172.67.x.x 포함
  [0xADF53000, 20], // 173.245.48.0/20
  [0xBC720000, 20], // 188.114.96.0/20
  [0xBE5DF000, 20], // 190.93.240.0/20
  [0xC5EAF000, 22], // 197.234.240.0/22
  [0xC6298000, 17], // 198.41.128.0/17
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function isCfIp(ip) {
  // IPv6이면 일단 CF로 간주 (2606:4700::/32 대역)
  if (ip.includes(':')) return ip.toLowerCase().startsWith('2606:4700') || ip.toLowerCase().startsWith('2400:cb00');
  const n = ipToInt(ip);
  for (const [base, prefix] of CF_IP_RANGES_V4) {
    const mask = prefix === 32 ? 0xFFFFFFFF : ~((1 << (32 - prefix)) - 1) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

// DoH로 A 레코드 조회 → 모두 Cloudflare IP이면 프록시 상태
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
    // 모든 A 레코드가 CF IP 대역이면 프록시 상태
    return aRecs.every(ip => isCfIp(ip));
  } catch (_) { return false; }
}

// 1.1.1.1 DoH CNAME 체인 추적 → ghs.google.com 포함 여부 반환
// Cloudflare 프록시(오렌지 클라우드) 상태에서는 CNAME이 외부에서 안 보임.
// 이 경우 A 레코드가 전부 CF IP 대역이면 → 해당 존의 Worker가 이미 실행 중 = 신뢰.
async function checkCnameGhs(host) {
  // Case 1: CNAME 체인 직접 추적 (회색 클라우드 / CF 외부 DNS)
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

  // Case 2: Cloudflare 프록시(오렌지 클라우드) 상태
  // → CNAME이 숨겨지고 A 레코드가 CF IP로만 노출됨.
  // → A 레코드 전체가 CF IP 대역이면 프록시 통과 상태 = 이 Worker가 해당 존에서 동작 중 = Blogger 도메인으로 신뢰.
  const proxied = await isProxiedByCf(host);
  if (proxied) return true;

  return false;
}

// 1.1.1.1 DoH API로 CNAME 레코드 조회
async function dnsCname(host) {
  const resp = await fetch(
    `${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`,
    {
      headers: { accept: 'application/dns-json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !Array.isArray(data.Answer)) return null;
  const rec = data.Answer.find(r => r.type === 5); // type 5 = CNAME
  return rec ? String(rec.data) : null;
}

// ─────────────────────────────────────────────
// Blogger fetch: 커스텀 도메인으로 직접 요청
// ?m=1 제거 (Blogger 모바일 파라미터)
// ─────────────────────────────────────────────
async function bloggerFetch(url, method, reqHeaders, body) {
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs        = params.toString() ? '?' + params.toString() : '';
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
  // Googlebot UA로 설정 (Blogger가 크롤러에게 최적 응답 반환)
  headers.set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

  return fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
    redirect: 'follow',
  });
}

// Feed/Sitemap 등 직통 프록시 (HTML 처리 없이 그대로 반환)
async function proxyPass(url, request, env) {
  try {
    const resp = await bloggerFetch(url, request.method, request.headers, request.body);
    return stripInternalHeaders(resp);
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + e.message);
  }
}

// CF 내부 헤더 제거
function stripInternalHeaders(resp) {
  const h = new Headers(resp.headers);
  h.delete('cf-cache-status');
  h.delete('cf-ray');
  h.delete('nel');
  h.delete('report-to');
  h.delete('server');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// ─────────────────────────────────────────────
// 에러 응답 (사이트 준비 중 페이지 없음)
// ─────────────────────────────────────────────
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
  // Feed: /feeds/*, /atom.xml, /rss.xml, /sitemap.xml, /sitemap-*.xml
  if (path.startsWith('/feeds/'))          return true;
  if (path === '/atom.xml')                return true;
  if (path === '/rss.xml')                 return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path)) return true;
  // ?alt=json/rss 파라미터
  if (url.searchParams.has('alt'))         return true;
  // 정적 자산
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
        const np = path.replace(/[^/]+\.html$/, newSlug   + '.html');
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
          const op = data.path.replace(/[^/]+\.html$/, data.slug   + '.html');
          const np = data.path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (op !== np) await env.SLUG_KV.put('canonical:' + op, np);
        }
        await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, slug: newSlug, checkedAt: now }));
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 생성 (다국어)
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
// LB 기록 (호스트 단위)
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
  if (p.startsWith('/search/label/'))           return 'label';
  if (p.startsWith('/search'))                  return 'search';
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
function extractLogoUrl(html)     {
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
