/**
 * Blogspot SEO & Performance Optimization Worker
 * ------------------------------------------------
 * - 제목 기반 슬러그 (다국어 인코딩)
 * - 자동 Schema 마크업 (RankMath 방식, AI 없음)
 * - 자동 메타설명 (RankMath 방식, AI 없음)
 * - 사이트 속도 극대화 (목표: 1ms~15ms)
 * - 30분 단위 캐시 초기화
 * - KV: SLUG_KV, CACHE_RESERVE_KV
 * - Cache Reserve 자체 로직
 * - 6개월마다 슬러그 검사/갱신
 * - ERR_TOO_MANY_REDIRECTS 방지
 * - 문자 깨짐 방지
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CACHE_TTL          = 30 * 60;          // 30분 (초)
const SLUG_CHECK_MS      = 6 * 30 * 24 * 3600 * 1000; // 6개월 (ms)
const BLOGGER_FEED_JSON  = '?alt=json&max-results=500';
const INTERNAL_HEADER    = 'x-worker-internal'; // 무한 리다이렉트 방지 마커
const CHARSET            = 'utf-8';

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // 무한 리다이렉트 방지: 워커가 생성한 내부 요청은 그냥 통과
    if (request.headers.get(INTERNAL_HEADER) === '1') {
      return fetch(request);
    }

    const url    = new URL(request.url);
    const path   = url.pathname;

    // ── 1. 라우트 분기 ───────────────────────
    // Feed/API/Static 자산은 바로 원본으로 패스스루
    if (isPassthrough(path, url)) {
      return fetchOrigin(request, env);
    }

    // 슬러그 강제 리다이렉트 경로 체크
    const slugRedirect = await checkSlugRedirect(path, url, env);
    if (slugRedirect) return slugRedirect;

    // ── 2. Cache Reserve 조회 ────────────────
    const cacheKey = buildCacheKey(url);
    const cached   = await getCacheReserve(cacheKey, env);
    if (cached) {
      return new Response(cached.body, {
        status:  200,
        headers: buildCachedHeaders(cached.headers),
      });
    }

    // ── 3. 원본 Fetch ────────────────────────
    const originResp = await fetchOrigin(request, env);
    if (!originResp.ok || !isHtml(originResp)) {
      return originResp;
    }

    // ── 4. HTML 파이프라인 ───────────────────
    const html    = await originResp.text();
    const pageCtx = extractPageContext(html, url);
    const result  = transformHtml(html, pageCtx, url);

    // ── 5. 슬러그 KV 업데이트 (비동기, 응답 차단 없음) ──
    ctx.waitUntil(updateSlugKV(pageCtx, url, env));

    // ── 6. Cache Reserve 저장 (비동기) ──────
    const respHeaders = buildResponseHeaders(originResp);
    ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));

    return new Response(result, {
      status:  200,
      headers: respHeaders,
    });
  },

  // ── 스케줄드 트리거: 슬러그 검사 (cron: 0 0 1 */6 *) ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env));
  },
};

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/'))      return true;
  if (path.startsWith('/search'))      return true;
  if (path.startsWith('/favicon'))     return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm)$/i.test(path)) return true;
  if (url.searchParams.has('alt'))     return true; // JSON feed
  return false;
}

function isHtml(resp) {
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('text/html');
}

// ─────────────────────────────────────────────
// 슬러그 리다이렉트 체크
// ─────────────────────────────────────────────
async function checkSlugRedirect(path, url, env) {
  // /p/slug, /YYYY/MM/slug.html 형식만
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
// 원본 Fetch (패스스루용)
// ─────────────────────────────────────────────
function fetchOrigin(request, env) {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_HEADER, '1');
  return fetch(new Request(request, { headers }));
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인
// ─────────────────────────────────────────────
function transformHtml(html, ctx, url) {
  // 순서 중요: 메타 → 스키마 → 성능 최적화
  let out = html;
  out = injectMetaDescription(out, ctx);
  out = injectCanonical(out, ctx, url);
  out = injectSchemaMarkup(out, ctx, url);
  out = injectPerformanceOptimizations(out);
  out = injectSeoTags(out, ctx, url);
  return out;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 추출 (RankMath 방식)
// ─────────────────────────────────────────────
function extractPageContext(html, url) {
  const ctx = {
    type:        detectPageType(html, url),
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

  // 제목 추출
  ctx.title = extractMeta(html, 'og:title')
    || extractTagContent(html, /<title[^>]*>([^<]+)<\/title>/i)
    || '';

  // 본문 첫 단락 → 메타설명 (RankMath: 160자)
  const bodyText = extractBodyText(html);
  ctx.description = extractMeta(html, 'description')
    || extractMeta(html, 'og:description')
    || buildMetaDescription(bodyText, ctx.title);

  // OG 이미지
  ctx.imageUrl = extractMeta(html, 'og:image')
    || extractFirstImage(html)
    || '';

  // 날짜/작성자
  ctx.publishDate = extractMeta(html, 'article:published_time')
    || extractJsonLdDate(html, 'datePublished')
    || extractTagContent(html, /class="published"[^>]*>([^<]+)</i)
    || '';

  ctx.updateDate = extractMeta(html, 'article:modified_time')
    || extractJsonLdDate(html, 'dateModified')
    || ctx.publishDate;

  ctx.author = extractMeta(html, 'article:author')
    || extractTagContent(html, /class="fn"[^>]*>([^<]+)</i)
    || extractTagContent(html, /class="author[^"]*"[^>]*>([^<]+)</i)
    || '';

  // 태그/라벨
  ctx.tags = extractLabels(html);

  return ctx;
}

function detectPageType(html, url) {
  const path = new URL(url).pathname;
  if (path === '/' || path === '')                         return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path))         return 'post';
  if (/^\/p\//.test(path))                                 return 'page';
  if (path.startsWith('/search/label/'))                   return 'label';
  if (path.startsWith('/search'))                          return 'search';
  return 'other';
}

// ─────────────────────────────────────────────
// 메타 설명 주입 (RankMath: 본문 첫 단락 기반, 160자)
// ─────────────────────────────────────────────
function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;

  const desc = escapeAttr(ctx.description.slice(0, 160));

  // 이미 있는 description 교체
  if (/<meta[^>]+name=["']description["'][^>]*>/i.test(html)) {
    return html.replace(
      /(<meta[^>]+name=["']description["'][^>]*content=["'])[^"']*(['"][^>]*>)/i,
      `$1${desc}$2`
    );
  }
  if (/<meta[^>]+content=["'][^"']*["'][^>]+name=["']description["'][^>]*>/i.test(html)) {
    return html.replace(
      /(<meta[^>]+content=["'])[^"']*(['"][^>]+name=["']description["'][^>]*>)/i,
      `$1${desc}$2`
    );
  }

  // 없으면 <head> 바로 뒤에 삽입
  return html.replace(
    /(<head[^>]*>)/i,
    `$1\n<meta name="description" content="${desc}">`
  );
}

// ─────────────────────────────────────────────
// Canonical URL 주입
// ─────────────────────────────────────────────
function injectCanonical(html, ctx, url) {
  if (/<link[^>]+rel=["']canonical["'][^>]*>/i.test(html)) return html;

  const canonical = escapeAttr(url.origin + url.pathname);
  return html.replace(
    /(<head[^>]*>)/i,
    `$1\n<link rel="canonical" href="${canonical}">`
  );
}

// ─────────────────────────────────────────────
// SEO 태그 (OG, Twitter Card, 색인 지시)
// ─────────────────────────────────────────────
function injectSeoTags(html, ctx, url) {
  const tags = [];

  // robots
  if (!/<meta[^>]+name=["']robots["'][^>]*>/i.test(html)) {
    tags.push('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">');
  }

  // OG
  if (!/<meta[^>]+property=["']og:title["'][^>]*>/i.test(html) && ctx.title) {
    tags.push(`<meta property="og:title" content="${escapeAttr(ctx.title)}">`);
  }
  if (!/<meta[^>]+property=["']og:description["'][^>]*>/i.test(html) && ctx.description) {
    tags.push(`<meta property="og:description" content="${escapeAttr(ctx.description.slice(0, 200))}">`);
  }
  if (!/<meta[^>]+property=["']og:url["'][^>]*>/i.test(html)) {
    tags.push(`<meta property="og:url" content="${escapeAttr(url.origin + url.pathname)}">`);
  }
  if (!/<meta[^>]+property=["']og:type["'][^>]*>/i.test(html)) {
    const ogType = ctx.type === 'post' ? 'article' : 'website';
    tags.push(`<meta property="og:type" content="${ogType}">`);
  }
  if (!/<meta[^>]+property=["']og:site_name["'][^>]*>/i.test(html) && ctx.siteName) {
    tags.push(`<meta property="og:site_name" content="${escapeAttr(ctx.siteName)}">`);
  }
  if (!/<meta[^>]+property=["']og:image["'][^>]*>/i.test(html) && ctx.imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeAttr(ctx.imageUrl)}">`);
    tags.push('<meta property="og:image:width" content="1200">');
    tags.push('<meta property="og:image:height" content="630">');
  }

  // Twitter Card
  if (!/<meta[^>]+name=["']twitter:card["'][^>]*>/i.test(html)) {
    tags.push(`<meta name="twitter:card" content="${ctx.imageUrl ? 'summary_large_image' : 'summary'}">`);
  }
  if (!/<meta[^>]+name=["']twitter:title["'][^>]*>/i.test(html) && ctx.title) {
    tags.push(`<meta name="twitter:title" content="${escapeAttr(ctx.title)}">`);
  }
  if (!/<meta[^>]+name=["']twitter:description["'][^>]*>/i.test(html) && ctx.description) {
    tags.push(`<meta name="twitter:description" content="${escapeAttr(ctx.description.slice(0, 200))}">`);
  }
  if (!/<meta[^>]+name=["']twitter:image["'][^>]*>/i.test(html) && ctx.imageUrl) {
    tags.push(`<meta name="twitter:image" content="${escapeAttr(ctx.imageUrl)}">`);
  }

  if (tags.length === 0) return html;

  return html.replace('</head>', tags.join('\n') + '\n</head>');
}

// ─────────────────────────────────────────────
// Schema 마크업 (RankMath 방식, JSON-LD)
// ─────────────────────────────────────────────
function injectSchemaMarkup(html, ctx, url) {
  // 이미 워커가 삽입한 스키마가 있으면 스킵
  if (html.includes('"@context":"https://schema.org"') && html.includes('"BreadcrumbList"')) {
    return html;
  }

  const schemas = [];

  // WebSite (홈만)
  if (ctx.type === 'home') {
    schemas.push(buildWebSiteSchema(ctx, url));
    schemas.push(buildOrganizationSchema(ctx, url));
  }

  // BreadcrumbList (모든 페이지)
  schemas.push(buildBreadcrumbSchema(ctx, url));

  // Article (포스트)
  if (ctx.type === 'post') {
    schemas.push(buildArticleSchema(ctx, url));
  }

  // WebPage (기타)
  if (ctx.type === 'page' || ctx.type === 'other') {
    schemas.push(buildWebPageSchema(ctx, url));
  }

  const scriptTag = schemas
    .map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
    .join('\n');

  return html.replace('</head>', scriptTag + '\n</head>');
}

function buildWebSiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': url.origin + '/#website',
    url: url.origin + '/',
    name: ctx.siteName || ctx.title,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: url.origin + '/search?q={search_term_string}' },
      'query-input': 'required name=search_term_string',
    },
  };
}

function buildOrganizationSchema(ctx, url) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': url.origin + '/#organization',
    name: ctx.siteName || ctx.title,
    url: url.origin + '/',
  };
  if (ctx.logoUrl) {
    schema.logo = {
      '@type': 'ImageObject',
      '@id': url.origin + '/#logo',
      url: ctx.logoUrl,
      contentUrl: ctx.logoUrl,
      caption: ctx.siteName || ctx.title,
    };
  }
  return schema;
}

function buildBreadcrumbSchema(ctx, url) {
  const segments = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  const items    = [{ '@type': 'ListItem', position: 1, name: ctx.siteName || '홈', item: url.origin + '/' }];

  let accumulated = url.origin;
  segments.forEach((seg, i) => {
    accumulated += '/' + seg;
    items.push({
      '@type': 'ListItem',
      position: i + 2,
      name: decodeSegmentName(seg),
      item: accumulated,
    });
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  };
}

function buildArticleSchema(ctx, url) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': ['Article', 'BlogPosting'],
    '@id': ctx.postUrl + '#article',
    url: ctx.postUrl,
    headline: ctx.title,
    description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' },
    author: {
      '@type': 'Person',
      name: ctx.author || ctx.siteName || 'Author',
    },
    publisher: {
      '@type': 'Organization',
      '@id': url.origin + '/#organization',
      name: ctx.siteName || '',
    },
    inLanguage: 'ko-KR',
  };

  if (ctx.imageUrl) {
    schema.image = {
      '@type': 'ImageObject',
      url: ctx.imageUrl,
      '@id': ctx.postUrl + '#primaryimage',
    };
    schema.thumbnailUrl = ctx.imageUrl;
  }
  if (ctx.publishDate) schema.datePublished = ctx.publishDate;
  if (ctx.updateDate)  schema.dateModified  = ctx.updateDate;
  if (ctx.tags.length) schema.keywords      = ctx.tags.join(', ');

  return schema;
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

// ─────────────────────────────────────────────
// 성능 최적화 (속도 극대화)
// ─────────────────────────────────────────────
function injectPerformanceOptimizations(html) {
  const perfTags = [
    // DNS prefetch
    '<link rel="dns-prefetch" href="//www.blogger.com">',
    '<link rel="dns-prefetch" href="//www.google.com">',
    '<link rel="dns-prefetch" href="//www.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
    '<link rel="dns-prefetch" href="//pagead2.googlesyndication.com">',
    // Preconnect (크리티컬)
    '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  ].join('\n');

  // 이미 삽입되어 있으면 스킵
  if (html.includes('dns-prefetch')) return html;

  // <head> 바로 뒤에 삽입 (최상단)
  let out = html.replace(/(<head[^>]*>)/, `$1\n${perfTags}`);

  // 이미지 lazy-load 강제 (네이티브)
  out = out.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');

  // 콘텐츠 외 스크립트 defer 처리 (Blogger 위젯 스크립트)
  out = out.replace(
    /(<script(?![^>]*(defer|async|type=["']application\/ld\+json["']|type=["']text\/template["']))[^>]*src=["'][^"']+["'][^>]*)>/gi,
    '$1 defer>'
  );

  return out;
}

// ─────────────────────────────────────────────
// Cache Reserve 로직 (자체 구현)
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  // 쿼리 파라미터 정규화 (순서 통일)
  const sorted = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (sorted.toString() ? '?' + sorted : '');
}

async function getCacheReserve(key, env) {
  try {
    const meta = await env.CACHE_RESERVE_KV.get('meta:' + key, { type: 'json' });
    if (!meta) return null;

    // 30분 초과 시 만료
    if (Date.now() - meta.ts > CACHE_TTL * 1000) {
      // 비동기 삭제 (응답 차단 안 함)
      env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
      env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
      return null;
    }

    const body = await env.CACHE_RESERVE_KV.get('body:' + key);
    if (!body) return null;

    return { body, headers: meta.headers };
  } catch (_) {
    return null;
  }
}

async function setCacheReserve(key, body, headers, env) {
  try {
    const meta = {
      ts: Date.now(),
      headers: Object.fromEntries(headers.entries()),
    };
    const opts = { expirationTtl: CACHE_TTL * 2 }; // KV 자체 TTL은 캐시 TTL의 2배
    await env.CACHE_RESERVE_KV.put('meta:' + key, JSON.stringify(meta), opts);
    await env.CACHE_RESERVE_KV.put('body:' + key, body, opts);
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 KV 업데이트
// ─────────────────────────────────────────────
async function updateSlugKV(ctx, url, env) {
  if (ctx.type !== 'post' && ctx.type !== 'page') return;
  if (!ctx.title) return;

  const path      = new URL(url).pathname;
  const generated = generateSlug(ctx.title);

  try {
    const existing = await env.SLUG_KV.get('slug:' + path, { type: 'json' });
    const now      = Date.now();

    if (!existing) {
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({
        title:     ctx.title,
        slug:      generated,
        path,
        createdAt: now,
        checkedAt: now,
      }));
    } else {
      // 6개월 경과 시 슬러그 재검사
      if (now - existing.checkedAt > SLUG_CHECK_MS) {
        const newSlug = generateSlug(ctx.title);
        if (newSlug !== existing.slug) {
          // 구 경로 → 신 경로 리다이렉트 매핑
          const oldPath = path.replace(/[^/]+\.html$/, existing.slug + '.html');
          const newPath = path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (oldPath !== newPath) {
            await env.SLUG_KV.put('canonical:' + oldPath, newPath);
          }
        }
        await env.SLUG_KV.put('slug:' + path, JSON.stringify({
          ...existing,
          slug:      newSlug,
          checkedAt: now,
        }));
      }
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 감사 (스케줄드 트리거)
// ─────────────────────────────────────────────
async function runSlugAudit(env) {
  try {
    const list = await env.SLUG_KV.list({ prefix: 'slug:' });
    const now  = Date.now();

    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data) continue;

        if (now - data.checkedAt < SLUG_CHECK_MS) continue;

        const newSlug = generateSlug(data.title);
        if (newSlug !== data.slug) {
          const oldPath = data.path.replace(/[^/]+\.html$/, data.slug + '.html');
          const newPath = data.path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (oldPath !== newPath) {
            await env.SLUG_KV.put('canonical:' + oldPath, newPath);
          }
          await env.SLUG_KV.put(key.name, JSON.stringify({
            ...data,
            slug:      newSlug,
            checkedAt: now,
          }));
        } else {
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, checkedAt: now }));
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 생성 (다국어 인코딩)
// ─────────────────────────────────────────────
function generateSlug(title) {
  if (!title) return 'untitled';

  let slug = title.trim();

  // 한글, CJK, 아랍어, 태국어 등 비ASCII: 퍼센트 인코딩 후 하이픈 분리
  slug = slug
    .toLowerCase()
    .replace(/\s+/g, '-')          // 공백 → 하이픈
    .replace(/[_]+/g, '-')         // 언더스코어 → 하이픈
    // 라틴 특수문자 → 기본 ASCII
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    // ASCII 허용 문자 외 제거 (한글 등 유니코드는 유지 후 인코딩)
    .replace(/[^\p{L}\p{N}\-]/gu, '-')
    .replace(/-{2,}/g, '-')        // 연속 하이픈 정리
    .replace(/^-+|-+$/g, '');      // 앞뒤 하이픈 제거

  // 한글/CJK 등 비ASCII가 포함된 경우 encodeURIComponent 방식
  if (/[^\x00-\x7F]/.test(slug)) {
    slug = encodeURIComponent(slug).replace(/%20/g, '-').replace(/%2F/gi, '-');
  }

  return slug || 'post';
}

// ─────────────────────────────────────────────
// 응답 헤더 빌드
// ─────────────────────────────────────────────
function buildResponseHeaders(originResp) {
  const headers = new Headers();
  headers.set('content-type',              'text/html; charset=utf-8');
  headers.set('cache-control',             `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}, stale-while-revalidate=60`);
  headers.set('x-content-type-options',   'nosniff');
  headers.set('x-frame-options',           'SAMEORIGIN');
  headers.set('referrer-policy',           'strict-origin-when-cross-origin');
  headers.set('vary',                      'Accept-Encoding');

  // 원본 ETag/Last-Modified 유지
  const etag = originResp.headers.get('etag');
  const lm   = originResp.headers.get('last-modified');
  if (etag) headers.set('etag', etag);
  if (lm)   headers.set('last-modified', lm);

  return headers;
}

function buildCachedHeaders(saved) {
  const headers = new Headers(saved || {});
  headers.set('x-cache', 'HIT');
  headers.set('cache-control', `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`);
  return headers;
}

// ─────────────────────────────────────────────
// HTML 파싱 유틸
// ─────────────────────────────────────────────
function extractMeta(html, name) {
  // property= 방식
  const mP = html.match(new RegExp(`<meta[^>]+property=["']${escapeRe(name)}["'][^>]+content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRe(name)}["']`, 'i'));
  if (mP) return mP[1];

  // name= 방식
  const mN = html.match(new RegExp(`<meta[^>]+name=["']${escapeRe(name)}["'][^>]+content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRe(name)}["']`, 'i'));
  if (mN) return mN[1];

  return '';
}

function extractTagContent(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : '';
}

function extractBodyText(html) {
  // 스크립트/스타일 제거 후 텍스트 추출
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildMetaDescription(bodyText, title) {
  // RankMath 방식: 본문 첫 의미 있는 문장, 160자
  let text = bodyText.replace(title, '').trim();
  // 첫 140~160자 (단어 경계)
  if (text.length > 160) {
    text = text.slice(0, 160);
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace > 100) text = text.slice(0, lastSpace);
    text += '…';
  }
  return text;
}

function extractFirstImage(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function extractSiteName(html) {
  return extractMeta(html, 'og:site_name')
    || extractTagContent(html, /<a[^>]+id=["']Header1_headerimg["'][^>]*>([^<]+)/i)
    || extractTagContent(html, /<title[^>]*>([^<|]+)/i)
    || '';
}

function extractLogoUrl(html) {
  const m = html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i)
    || html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function extractLabels(html) {
  const labels = [];
  const re = /class="label[^"]*"[^>]*>([^<]+)</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = m[1].trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function extractJsonLdDate(html, key) {
  const m = html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i'));
  return m ? m[1] : '';
}

function decodeSegmentName(seg) {
  try { return decodeURIComponent(seg.replace(/\.html$/, '').replace(/-/g, ' ')); }
  catch (_) { return seg; }
}

// ─────────────────────────────────────────────
// 문자 이스케이프 유틸
// ─────────────────────────────────────────────
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
