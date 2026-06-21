/**
 * Blogspot SEO & Performance Optimization Worker
 * ------------------------------------------------
 * 설정 불필요 — Blogspot 원본 주소 자동 감지
 *
 * 동작 원리:
 *   1) KV(SLUG_KV)에 캐시된 origin 사용 (가장 빠름)
 *   2) 없으면 현재 도메인으로 HEAD 요청 → Location 헤더에서 blogspot.com 자동 추출
 *   3) 추출된 origin을 KV에 영구 저장 (이후 요청은 1번 경로)
 */

const CACHE_TTL     = 30 * 60;
const SLUG_CHECK_MS = 6 * 30 * 24 * 3600 * 1000;
const ORIGIN_KV_KEY = '__blogspot_origin__';

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── 원본 자동 감지 ───────────────────────
    const origin = await resolveOrigin(url, env);
    if (!origin) {
      return new Response('Blogspot 원본을 자동 감지할 수 없습니다. 도메인이 Blogspot에 연결되어 있는지 확인하세요.', { status: 502 });
    }

    // ── 1. 정적 자산 / Feed → 원본 직통 ─────
    if (isPassthrough(path, url)) {
      return proxyToOrigin(request, url, origin);
    }

    // ── 2. 슬러그 canonical 리다이렉트 ──────
    const slugRedirect = await checkSlugRedirect(path, url, env);
    if (slugRedirect) return slugRedirect;

    // ── 3. Cache Reserve 조회 ───────────────
    const cacheKey = buildCacheKey(url);
    const cached   = await getCacheReserve(cacheKey, env);
    if (cached) {
      return new Response(cached.body, {
        status:  200,
        headers: buildCachedHeaders(cached.headers),
      });
    }

    // ── 4. Blogspot 원본 직접 Fetch ─────────
    const originResp = await proxyToOrigin(request, url, origin);
    if (!isHtml(originResp) || !originResp.ok) return originResp;

    // ── 5. HTML 파이프라인 ──────────────────
    const html    = await originResp.text();
    const pageCtx = extractPageContext(html, url);
    const result  = transformHtml(html, pageCtx, url);

    // ── 6. 비동기 후처리 ────────────────────
    const respHeaders = buildResponseHeaders();
    ctx.waitUntil(updateSlugKV(pageCtx, url, env));
    ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));

    return new Response(result, { status: 200, headers: respHeaders });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env));
  },
};

// ─────────────────────────────────────────────
// Blogspot 원본 자동 감지
// ─────────────────────────────────────────────
async function resolveOrigin(url, env) {
  // 1) KV 캐시 확인 (가장 빠른 경로, 이후 모든 요청은 여기서 끝남)
  try {
    const cached = await env.SLUG_KV.get(ORIGIN_KV_KEY);
    if (cached) return cached;
  } catch (_) {}

  const customHost = url.hostname;

  // 2) ghs.google.com에 현재 Host로 직접 요청
  //    워커를 거치지 않으므로 무한루프 없음
  //    Blogspot 커스텀 도메인은 ghs.google.com이 실제 서버
  try {
    const resp = await fetch('https://ghs.google.com/', {
      method:   'GET',
      redirect: 'manual',
      headers:  { host: customHost, 'user-agent': 'Mozilla/5.0' },
    });
    const location = resp.headers.get('location') || '';
    const m = location.match(/https?://([a-zA-Z0-9-]+.blogspot.com)/);
    if (m) {
      const origin = 'https://' + m[1];
      await env.SLUG_KV.put(ORIGIN_KV_KEY, origin);
      return origin;
    }
  } catch (_) {}

  // 3) fallback: ghs.google.com redirect follow 후 HTML에서 추출
  try {
    const resp = await fetch('https://ghs.google.com/', {
      method:   'GET',
      redirect: 'follow',
      headers:  { host: customHost, 'user-agent': 'Mozilla/5.0' },
    });
    const html = await resp.text();
    const m    = html.match(/https?://([a-zA-Z0-9-]+.blogspot.com)/);
    if (m) {
      const origin = 'https://' + m[1];
      await env.SLUG_KV.put(ORIGIN_KV_KEY, origin);
      return origin;
    }
  } catch (_) {}

  // 4) 최후 fallback: 도메인명으로 blogspot 서브도메인 추정
  try {
    const subdomain = customHost.replace(/^www./, '').split('.')[0];
    if (subdomain) {
      const guessed = 'https://' + subdomain + '.blogspot.com';
      const check   = await fetch(guessed + '/', { method: 'HEAD', redirect: 'manual' });
      if (check.status < 500) {
        await env.SLUG_KV.put(ORIGIN_KV_KEY, guessed);
        return guessed;
      }
    }
  } catch (_) {}

  return null;
}


// ─────────────────────────────────────────────
// 원본으로 프록시 (호스트만 교체 → 워커 재진입 없음)
// ─────────────────────────────────────────────
function proxyToOrigin(request, url, origin) {
  const targetUrl = origin + url.pathname + url.search;
  const headers   = new Headers(request.headers);
  headers.set('host', new URL(origin).host);
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');

  return fetch(targetUrl, {
    method:   request.method,
    headers,
    body:     ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow',
  });
}

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/'))  return true;
  if (url.searchParams.has('alt')) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─────────────────────────────────────────────
// 슬러그 canonical 리다이렉트
// ─────────────────────────────────────────────
async function checkSlugRedirect(path, url, env) {
  if (!isPostPath(path)) return null;
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
// HTML 변환 파이프라인
// ─────────────────────────────────────────────
function transformHtml(html, ctx, url) {
  let out = html;
  out = injectMetaDescription(out, ctx);
  out = injectCanonical(out, ctx, url);
  out = injectSchemaMarkup(out, ctx, url);
  out = injectSeoTags(out, ctx, url);
  out = injectPerformanceOptimizations(out);
  return out;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 추출
// ─────────────────────────────────────────────
function extractPageContext(html, url) {
  const ctx = {
    type:        detectPageType(url),
    title:       '',
    description: '',
    imageUrl:    '',
    author:      '',
    publishDate: '',
    updateDate:  '',
    tags:        [],
    postUrl:     url.toString(),
    siteName:    extractSiteName(html),
    logoUrl:     extractLogoUrl(html),
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
  if (p === '/' || p === '')                       return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p))     return 'post';
  if (/^\/p\//.test(p))                            return 'page';
  if (p.startsWith('/search/label/'))               return 'label';
  if (p.startsWith('/search'))                      return 'search';
  return 'other';
}

// ─────────────────────────────────────────────
// 메타 설명 (RankMath 방식, 160자)
// ─────────────────────────────────────────────
function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;
  const desc = escapeAttr(ctx.description.slice(0, 160));
  if (/<meta[^>]+name=["']description["'][^>]*>/i.test(html)) {
    return html
      .replace(/(<meta[^>]+name=["']description["'][^>]*content=["'])[^"']*(['"][^>]*>)/i, `$1${desc}$2`)
      .replace(/(<meta[^>]+content=["'])[^"']*(['"][^>]+name=["']description["'][^>]*>)/i, `$1${desc}$2`);
  }
  return html.replace(/(<head[^>]*>)/i, `$1\n<meta name="description" content="${desc}">`);
}

// ─────────────────────────────────────────────
// Canonical
// ─────────────────────────────────────────────
function injectCanonical(html, ctx, url) {
  if (/<link[^>]+rel=["']canonical["'][^>]*>/i.test(html)) return html;
  return html.replace(/(<head[^>]*>)/i, `$1\n<link rel="canonical" href="${escapeAttr(url.origin + url.pathname)}">`);
}

// ─────────────────────────────────────────────
// SEO 태그
// ─────────────────────────────────────────────
function injectSeoTags(html, ctx, url) {
  const tags = [];
  if (!/<meta[^>]+name=["']robots["'][^>]*>/i.test(html))
    tags.push('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">');
  if (!/<meta[^>]+property=["']og:title["'][^>]*>/i.test(html) && ctx.title)
    tags.push(`<meta property="og:title" content="${escapeAttr(ctx.title)}">`);
  if (!/<meta[^>]+property=["']og:description["'][^>]*>/i.test(html) && ctx.description)
    tags.push(`<meta property="og:description" content="${escapeAttr(ctx.description.slice(0, 200))}">`);
  if (!/<meta[^>]+property=["']og:url["'][^>]*>/i.test(html))
    tags.push(`<meta property="og:url" content="${escapeAttr(url.origin + url.pathname)}">`);
  if (!/<meta[^>]+property=["']og:type["'][^>]*>/i.test(html))
    tags.push(`<meta property="og:type" content="${ctx.type === 'post' ? 'article' : 'website'}">`);
  if (!/<meta[^>]+property=["']og:site_name["'][^>]*>/i.test(html) && ctx.siteName)
    tags.push(`<meta property="og:site_name" content="${escapeAttr(ctx.siteName)}">`);
  if (!/<meta[^>]+property=["']og:image["'][^>]*>/i.test(html) && ctx.imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeAttr(ctx.imageUrl)}">`);
    tags.push('<meta property="og:image:width" content="1200">');
    tags.push('<meta property="og:image:height" content="630">');
  }
  if (!/<meta[^>]+name=["']twitter:card["'][^>]*>/i.test(html))
    tags.push(`<meta name="twitter:card" content="${ctx.imageUrl ? 'summary_large_image' : 'summary'}">`);
  if (!/<meta[^>]+name=["']twitter:title["'][^>]*>/i.test(html) && ctx.title)
    tags.push(`<meta name="twitter:title" content="${escapeAttr(ctx.title)}">`);
  if (!/<meta[^>]+name=["']twitter:description["'][^>]*>/i.test(html) && ctx.description)
    tags.push(`<meta name="twitter:description" content="${escapeAttr(ctx.description.slice(0, 200))}">`);
  if (!/<meta[^>]+name=["']twitter:image["'][^>]*>/i.test(html) && ctx.imageUrl)
    tags.push(`<meta name="twitter:image" content="${escapeAttr(ctx.imageUrl)}">`);
  if (!tags.length) return html;
  return html.replace('</head>', tags.join('\n') + '\n</head>');
}

// ─────────────────────────────────────────────
// Schema 마크업 (RankMath 방식)
// ─────────────────────────────────────────────
function injectSchemaMarkup(html, ctx, url) {
  if (html.includes('"BreadcrumbList"')) return html;
  const schemas = [];
  if (ctx.type === 'home') {
    schemas.push(buildWebSiteSchema(ctx, url));
    schemas.push(buildOrganizationSchema(ctx, url));
  }
  schemas.push(buildBreadcrumbSchema(ctx, url));
  if (ctx.type === 'post')                          schemas.push(buildArticleSchema(ctx, url));
  if (ctx.type === 'page' || ctx.type === 'other')  schemas.push(buildWebPageSchema(ctx, url));
  const scriptTag = schemas.map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');
  return html.replace('</head>', scriptTag + '\n</head>');
}

function buildWebSiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': url.origin + '/#website', url: url.origin + '/', name: ctx.siteName || ctx.title,
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: url.origin + '/search?q={search_term_string}' }, 'query-input': 'required name=search_term_string' },
  };
}

function buildOrganizationSchema(ctx, url) {
  const s = { '@context': 'https://schema.org', '@type': 'Organization', '@id': url.origin + '/#organization', name: ctx.siteName || ctx.title, url: url.origin + '/' };
  if (ctx.logoUrl) s.logo = { '@type': 'ImageObject', '@id': url.origin + '/#logo', url: ctx.logoUrl, contentUrl: ctx.logoUrl };
  return s;
}

function buildBreadcrumbSchema(ctx, url) {
  const segs  = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  const items = [{ '@type': 'ListItem', position: 1, name: ctx.siteName || '홈', item: url.origin + '/' }];
  let acc     = url.origin;
  segs.forEach((seg, i) => { acc += '/' + seg; items.push({ '@type': 'ListItem', position: i + 2, name: decodeSegmentName(seg), item: acc }); });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}

function buildArticleSchema(ctx, url) {
  const s = {
    '@context': 'https://schema.org', '@type': ['Article', 'BlogPosting'],
    '@id': ctx.postUrl + '#article', url: ctx.postUrl, headline: ctx.title, description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' },
    author: { '@type': 'Person', name: ctx.author || ctx.siteName || 'Author' },
    publisher: { '@type': 'Organization', '@id': url.origin + '/#organization', name: ctx.siteName || '' },
    inLanguage: 'ko-KR',
  };
  if (ctx.imageUrl)    { s.image = { '@type': 'ImageObject', url: ctx.imageUrl }; s.thumbnailUrl = ctx.imageUrl; }
  if (ctx.publishDate) s.datePublished = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified  = ctx.updateDate;
  if (ctx.tags.length) s.keywords      = ctx.tags.join(', ');
  return s;
}

function buildWebPageSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebPage',
    '@id': ctx.postUrl + '#webpage', url: ctx.postUrl, name: ctx.title, description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' }, inLanguage: 'ko-KR',
    ...(ctx.publishDate ? { datePublished: ctx.publishDate } : {}),
    ...(ctx.updateDate  ? { dateModified:  ctx.updateDate  } : {}),
  };
}

// ─────────────────────────────────────────────
// 성능 최적화
// ─────────────────────────────────────────────
function injectPerformanceOptimizations(html) {
  if (html.includes('rel="dns-prefetch"')) return html;
  const perfTags = [
    '<link rel="dns-prefetch" href="//www.blogger.com">',
    '<link rel="dns-prefetch" href="//www.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
    '<link rel="dns-prefetch" href="//pagead2.googlesyndication.com">',
    '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  ].join('\n');
  let out = html.replace(/(<head[^>]*>)/i, `$1\n${perfTags}`);
  out = out.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');
  out = out.replace(/(<script(?![^>]*(defer|async|type=["']application\/ld\+json["']|type=["']text\/template["']))[^>]*src=["'][^"']+["'][^>]*)>/gi, '$1 defer>');
  return out;
}

// ─────────────────────────────────────────────
// Cache Reserve
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const sorted = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (sorted.toString() ? '?' + sorted : '');
}

async function getCacheReserve(key, env) {
  try {
    const meta = await env.CACHE_RESERVE_KV.get('meta:' + key, { type: 'json' });
    if (!meta) return null;
    if (Date.now() - meta.ts > CACHE_TTL * 1000) {
      env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
      env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
      return null;
    }
    const body = await env.CACHE_RESERVE_KV.get('body:' + key);
    if (!body) return null;
    return { body, headers: meta.headers };
  } catch (_) { return null; }
}

async function setCacheReserve(key, body, headers, env) {
  try {
    const opts = { expirationTtl: CACHE_TTL * 2 };
    await env.CACHE_RESERVE_KV.put('meta:' + key, JSON.stringify({ ts: Date.now(), headers: Object.fromEntries(headers.entries()) }), opts);
    await env.CACHE_RESERVE_KV.put('body:' + key, body, opts);
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 KV
// ─────────────────────────────────────────────
async function updateSlugKV(ctx, url, env) {
  if (!['post', 'page'].includes(ctx.type) || !ctx.title) return;
  const path = url.pathname, generated = generateSlug(ctx.title);
  try {
    const existing = await env.SLUG_KV.get('slug:' + path, { type: 'json' });
    const now      = Date.now();
    if (!existing) {
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ title: ctx.title, slug: generated, path, createdAt: now, checkedAt: now }));
    } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
      const newSlug = generateSlug(ctx.title);
      if (newSlug !== existing.slug) {
        const oldPath = path.replace(/[^/]+\.html$/, existing.slug + '.html');
        const newPath = path.replace(/[^/]+\.html$/, newSlug + '.html');
        if (oldPath !== newPath) await env.SLUG_KV.put('canonical:' + oldPath, newPath);
      }
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ ...existing, slug: newSlug, checkedAt: now }));
    }
  } catch (_) {}
}

async function runSlugAudit(env) {
  try {
    const list = await env.SLUG_KV.list({ prefix: 'slug:' });
    const now  = Date.now();
    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data || now - data.checkedAt < SLUG_CHECK_MS) continue;
        const newSlug = generateSlug(data.title);
        if (newSlug !== data.slug) {
          const oldPath = data.path.replace(/[^/]+\.html$/, data.slug + '.html');
          const newPath = data.path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (oldPath !== newPath) await env.SLUG_KV.put('canonical:' + oldPath, newPath);
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
  let slug = title.trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[_]+/g, '-')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/[^\p{L}\p{N}\-]/gu, '-')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (/[^\x00-\x7F]/.test(slug))
    slug = encodeURIComponent(slug).replace(/%20/g, '-').replace(/%2F/gi, '-');
  return slug || 'post';
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
  h.set('x-cache',      'HIT');
  h.set('cache-control', `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`);
  return h;
}

// ─────────────────────────────────────────────
// HTML 파싱 유틸
// ─────────────────────────────────────────────
function extractMeta(html, name) {
  const r = escapeRe(name);
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${r}["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+name=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i'))    ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`, 'i'))    ||
    []
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
  let text = bodyText.replace(title, '').trim();
  if (text.length > 160) {
    text = text.slice(0, 160);
    const last = text.lastIndexOf(' ');
    if (last > 100) text = text.slice(0, last);
    text += '…';
  }
  return text;
}

function extractFirstImage(html)  { return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || ''; }
function extractSiteName(html)    { return extractMeta(html, 'og:site_name') || extractTagContent(html, /<title[^>]*>([^<|]+)/i) || ''; }
function extractLogoUrl(html)     {
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
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function decodeSegmentName(seg) { try { return decodeURIComponent(seg.replace(/\.html$/, '').replace(/-/g, ' ')); } catch (_) { return seg; } }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(str)   { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
