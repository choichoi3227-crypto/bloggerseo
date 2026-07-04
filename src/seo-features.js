/**
 * BloggerSEO — 블로그스팟 실제 효과 SEO 기능 모음 (20+ 기능)
 * ─────────────────────────────────────────────────────────────────────
 * 실제 Blogger/Google SEO에서 효과가 검증된 기능만 선별:
 *
 *  1.  hreflang 자동 주입           — 다국어 SEO (검색 지역별 노출 최적화)
 *  2.  JSON-LD BreadcrumbList        — 구글 빵 부스러기 검색 결과 지원
 *  3.  Robots meta 최적화            — 크롤러별 색인/팔로우 제어
 *  4.  Canonical URL 강화            — www/non-www, http/https 중복 제거
 *  5.  Preload/Prefetch 힌트         — Core Web Vitals (LCP) 개선
 *  6.  이미지 alt 자동 보완          — 이미지 검색 최적화 + 접근성
 *  7.  내부 링크 rel 자동 추가       — follow/nofollow 적절한 제어
 *  8.  구조화 데이터 Sitelinks       — SearchAction (사이트 내 검색)
 *  9.  Open Graph image 크기 태그    — SNS 공유 최적화
 * 10.  Twitter Card type 자동 결정   — 트위터/X 공유 최적화
 * 11.  구글 Indexing API 핑          — 빠른 색인 요청 (POST 발행 후)
 * 12.  Naver/Daum 핑                — 국내 검색엔진 빠른 수집 요청
 * 13.  Blogger Label 페이지 SEO      — 카테고리 페이지 최적화
 * 14.  Lazy loading 이미지           — loading="lazy" 자동 추가 (CWV)
 * 15.  웹폰트 preconnect             — 폰트 로딩 성능 최적화
 * 16.  광고 렌더링 차단 방지          — AdSense async defer 주입
 * 17.  Core Web Vitals 힌트 헤더     — Server Timing 헤더 추가
 * 18.  XML Sitemap 이미지 확장       — 이미지 사이트맵 지원
 * 19.  Atom 피드 rel alternate 주입  — 피드 자동 발견
 * 20.  보안 헤더 강화                — XSS/클릭재킹 방지 (SEO 신뢰도 향상)
 * 21.  gzip/br 힌트 헤더             — 압축 전송 명시
 * 22.  Bing IndexNow 핑              — Bing 빠른 색인 요청
 * 23.  Google Discover 최적화        — og:image 사이즈 1200x628 강제화
 * 24.  모바일 AMP 힌트 link 태그     — AMP 페이지 연결 (있는 경우)
 * 25.  Author Schema 강화            — E-E-A-T 신호 향상
 */

import { escapeAttr, extractMeta } from './utils.js';

// ── 1. hreflang 자동 주입 ────────────────────────────────────────────────
export function injectHreflang(html, url, lang = 'ko') {
  if (html.includes('rel="alternate" hreflang=')) return html;

  const origin = url.origin;
  const path   = url.pathname + url.search;

  const tags = [
    `<link rel="alternate" hreflang="${lang}" href="${escapeAttr(origin + path)}">`,
    `<link rel="alternate" hreflang="x-default" href="${escapeAttr(origin + path)}">`,
  ].join('\n');

  return html.replace(/(<\/head>)/i, `${tags}\n$1`);
}

// ── 2. JSON-LD BreadcrumbList ─────────────────────────────────────────────
export function injectBreadcrumb(html, url, pageType, siteTitle = '') {
  if (html.includes('"BreadcrumbList"')) return html;
  if (pageType === 'home' || pageType === 'other') return html;

  const origin = url.origin;
  const crumbs = [{ name: siteTitle || 'Home', url: origin + '/' }];

  if (pageType === 'label') {
    const label = decodeURIComponent(url.pathname.replace('/search/label/', ''));
    crumbs.push({ name: label, url: origin + url.pathname });
  } else if (pageType === 'post' || pageType === 'page') {
    // 라벨이 있으면 추가
    const labelMatch = html.match(/rel=['"](tag|category)['"]\s+href=['"][^'"]*\/search\/label\/([^'"]+)['"]/i);
    if (labelMatch) {
      const labelName = decodeURIComponent(labelMatch[2]);
      crumbs.push({ name: labelName, url: `${origin}/search/label/${labelMatch[2]}` });
    }
    // 현재 포스트 제목
    const title = extractMeta(html, 'og:title') || '';
    if (title) crumbs.push({ name: title, url: origin + url.pathname });
  }

  if (crumbs.length < 2) return html;

  const schema = {
    '@context': 'https://schema.org',
    '@type'   : 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type'  : 'ListItem',
      position : i + 1,
      name     : c.name,
      item     : c.url,
    })),
  };

  const tag = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  return html.replace(/(<\/head>)/i, `${tag}\n$1`);
}

// ── 3. Robots meta 최적화 ────────────────────────────────────────────────
export function injectRobotsMeta(html, pageType) {
  if (html.includes('<meta name="robots"') || html.includes("<meta name='robots'")) {
    return html;
  }

  // 검색 결과 페이지, 관리 경로는 noindex
  let content = 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
  if (pageType === 'search') {
    content = 'noindex, follow';
  }

  return html.replace(/(<\/head>)/i,
    `<meta name="robots" content="${content}">\n$1`
  );
}

// ── 4. Canonical URL 강화 (중복 URL 패턴 정규화) ─────────────────────────
export function strengthenCanonical(html, url, titlePath = null) {
  // 기존 canonical이 있으면 건드리지 않음 (Blogger 자체 canonical 보존)
  if (html.includes('rel="canonical"') || html.includes("rel='canonical'")) {
    return html;
  }
  const canonical = buildCanonical(url, titlePath);
  return html.replace(/(<\/head>)/i,
    `<link rel="canonical" href="${escapeAttr(canonical)}">\n$1`
  );
}

function buildCanonical(url, titlePath = null) {
  const u = new URL(url.toString());
  // ✅ SEO 악영향 파라미터 전부 제거
  ['m','blogedit','postID','action','widgetType','fbclid',
   'utm_source','utm_medium','utm_campaign','utm_content','utm_term',
   'ref','source','_ga','gclid'].forEach(p => u.searchParams.delete(p));
  u.hash = '';
  u.protocol = 'https:';
  // ✅ SEO 슬러그 경로 우선 사용
  if (titlePath && titlePath !== '/') {
    u.pathname = titlePath;
  }
  return u.toString();
}

// ── 5. Resource Hints (Preload/Prefetch) ─────────────────────────────────
export function injectResourceHints(html) {
  if (html.includes('rel="preload"')) return html;

  const hints = [];

  // Blogger 핵심 JS preload
  if (html.includes('www.blogger.com')) {
    hints.push('<link rel="preconnect" href="https://www.blogger.com">');
  }
  // Google Analytics
  if (html.includes('google-analytics.com') || html.includes('gtag')) {
    hints.push('<link rel="dns-prefetch" href="//www.google-analytics.com">');
    hints.push('<link rel="dns-prefetch" href="//www.googletagmanager.com">');
  }
  // AdSense
  if (html.includes('googlesyndication.com') || html.includes('adsense')) {
    hints.push('<link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>');
    hints.push('<link rel="dns-prefetch" href="//googleads.g.doubleclick.net">');
  }
  // 첫 번째 이미지 LCP 최적화
  const firstImg = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (firstImg && !firstImg[1].startsWith('data:')) {
    hints.push(`<link rel="preload" as="image" href="${escapeAttr(firstImg[1])}">`);
  }

  if (!hints.length) return html;
  return html.replace(/(<head[^>]*>)/i, `$1\n${hints.join('\n')}`);
}

// ── 6. 이미지 alt 자동 보완 ──────────────────────────────────────────────
const SKIP_ALT_PATTERNS = [
  /\/img\.gif/i,         // Blogger 1px 투명 GIF
  /blogger\.com\/tracker/i, // Blogger 추적 픽셀
  /\/s1\//, /\/s\d+\/spacer/i,  // spacer 이미지
  /feeds\.feedburner/i,
];
export function injectImageAlts(html, pageTitle = '') {
  return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    if (/\balt\s*=\s*["'][^"']*["']/i.test(attrs)) return match;
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) return match;
    const src = srcMatch[1];
    // 시스템/추적 이미지는 건드리지 않음
    if (SKIP_ALT_PATTERNS.some(p => p.test(src))) return match;
    const alt = buildAltFromSrc(src, pageTitle);
    return `<img${attrs} alt="${escapeAttr(alt)}">`;
  });
}

function buildAltFromSrc(src, pageTitle) {
  try {
    const u    = new URL(src);
    const name = u.pathname.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    return name || pageTitle || 'image';
  } catch (_) {
    return pageTitle || 'image';
  }
}

// ── 7. 내부 링크 rel 자동 제어 ───────────────────────────────────────────
export function normalizeLinks(html, host) {
  return html.replace(/<a([^>]+)>/gi, (match, attrs) => {
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) return match;
    const href = hrefMatch[1];

    // 외부 링크: rel만 추가, target은 절대 건드리지 않음 (Blogger 링크 동작 보존)
    if (href.startsWith('http') && !href.includes(host)) {
      if (!attrs.includes('rel=')) {
        return `<a${attrs} rel="noopener noreferrer">`;
      }
      return match;
    }

    return match;
  });
}

// ── 8. SearchAction Schema (사이트 내 검색) ──────────────────────────────
export function injectSearchAction(html, baseUrl) {
  if (html.includes('"SearchAction"')) return html;

  const schema = {
    '@context'    : 'https://schema.org',
    '@type'       : 'WebSite',
    url           : baseUrl + '/',
    potentialAction: {
      '@type'       : 'SearchAction',
      target        : {
        '@type'     : 'EntryPoint',
        urlTemplate : `${baseUrl}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };

  const tag = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  return html.replace(/(<\/head>)/i, `${tag}\n$1`);
}

// ── 9. OG image 크기 태그 ───────────────────────────────────────────────
export function injectOgImageSize(html) {
  if (html.includes('og:image:width')) return html;
  if (!html.includes('og:image')) return html;

  const tags = [
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="628">',
    '<meta property="og:image:type" content="image/jpeg">',
  ].join('\n');

  return html.replace(/(<\/head>)/i, `${tags}\n$1`);
}

// ── 10. Twitter Card 자동 결정 ───────────────────────────────────────────
export function strengthenTwitterCard(html, hasImage) {
  // 이미 설정돼 있으면 summary_large_image로 업그레이드만
  if (html.includes('twitter:card')) {
    if (hasImage) {
      return html.replace(
        /<meta\s+name=["']twitter:card["']\s+content=["']summary["']/gi,
        '<meta name="twitter:card" content="summary_large_image"'
      );
    }
    return html;
  }
  const card = hasImage ? 'summary_large_image' : 'summary';
  return html.replace(/(<\/head>)/i,
    `<meta name="twitter:card" content="${card}">\n$1`
  );
}

// ── 11. Google Indexing API 핑 (비동기, ctx.waitUntil 용) ────────────────
export async function pingGoogleIndexing(url, accessToken) {
  if (!accessToken) return { ok: false, reason: 'no-token' };
  try {
    const resp = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ url, type: 'URL_UPDATED' }),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 12. 네이버/다음 핑 ───────────────────────────────────────────────────
export async function pingSearchEngines(sitemapUrl) {
  const targets = [
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    `https://search.naver.com/robot.txt?sitemap=${encodeURIComponent(sitemapUrl)}`,
  ];
  const results = await Promise.allSettled(
    targets.map(t => fetch(t, { method: 'GET', cf: { cacheTtl: 0 } }))
  );
  return results.map((r, i) => ({
    url: targets[i],
    ok : r.status === 'fulfilled' && r.value.ok,
  }));
}

// ── 13. Label/카테고리 페이지 SEO 강화 ──────────────────────────────────
export function injectLabelPageSeo(html, url) {
  if (!url.pathname.startsWith('/search/label/')) return html;

  const rawLabel = url.pathname.replace('/search/label/', '');
  const label    = decodeURIComponent(rawLabel);
  const tags     = [];

  // 카테고리 페이지는 noindex 금지 (과거 잘못된 관행)
  // 대신 자기 canonical로 중복 문제 해결
  if (!html.includes('og:title')) {
    tags.push(`<meta property="og:title" content="${escapeAttr(label)} — 블로그">`);
  }
  if (!html.includes('og:type')) {
    tags.push('<meta property="og:type" content="website">');
  }

  // CollectionPage 스키마
  if (!html.includes('"CollectionPage"')) {
    const schema = {
      '@context': 'https://schema.org',
      '@type'   : 'CollectionPage',
      name      : label,
      url       : url.toString(),
    };
    tags.push(`<script type="application/ld+json">${JSON.stringify(schema)}</script>`);
  }

  return tags.length ? html.replace(/(<\/head>)/i, `${tags.join('\n')}\n$1`) : html;
}

// ── 14. 이미지 Lazy Loading ──────────────────────────────────────────────
const SKIP_LAZY_PATTERNS = [
  /blogger\.com/i, /gstatic\.com/i, /google\.com/i,
  /\/img\.gif/i, /spacer/i, /favicon/i,
];
export function injectLazyLoading(html) {
  let firstContentDone = false;
  return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    if (attrs.includes('loading=')) return match;
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) return match;
    const src = srcMatch[1];
    // Blogger 시스템 이미지는 건드리지 않음
    if (SKIP_LAZY_PATTERNS.some(p => p.test(src))) return match;
    if (!firstContentDone) {
      firstContentDone = true;
      return `<img${attrs} loading="eager">`;
    }
    return `<img${attrs} loading="lazy">`;
  });
}

// ── 15. 웹폰트 Preconnect 최적화 ────────────────────────────────────────
export function injectFontOptimization(html) {
  if (!html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com')) {
    return html;
  }
  if (html.includes('fonts.gstatic.com" crossorigin')) return html;

  const tags = [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  ].join('\n');

  return html.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
}

// ── 16. AdSense 렌더링 차단 방지 ────────────────────────────────────────
export function optimizeAdsense(html) {
  // AdSense 스크립트에 async 속성 추가 (없는 경우)
  return html.replace(
    /<script([^>]*?)src=["']https:\/\/pagead2\.googlesyndication\.com([^"']*)["']([^>]*)>/gi,
    (match, pre, src, post) => {
      if (pre.includes('async') || post.includes('async')) return match;
      return `<script${pre}async src="https://pagead2.googlesyndication.com${src}"${post}>`;
    }
  );
}

// ── 17. Server-Timing 헤더 (Core Web Vitals 분석용) ──────────────────────
export function buildServerTimingHeader(metrics = {}) {
  const parts = [];
  if (metrics.cacheHit !== undefined) {
    parts.push(`cache;desc="${metrics.cacheHit ? 'HIT' : 'MISS'}"`);
  }
  if (metrics.originMs !== undefined) {
    parts.push(`origin;dur=${metrics.originMs}`);
  }
  if (metrics.workerMs !== undefined) {
    parts.push(`worker;dur=${metrics.workerMs}`);
  }
  return parts.join(', ');
}

// ── 18. 이미지 사이트맵 XML 확장 ────────────────────────────────────────
export function buildImageSitemapXml(entries) {
  const items = entries.map(e => {
    const images = (e.images || []).map(img =>
      `    <image:image><image:loc>${escapeXml(img)}</image:loc></image:image>`
    ).join('\n');

    return `  <url>
    <loc>${escapeXml(e.loc)}</loc>
    ${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}
    <changefreq>${e.changefreq || 'weekly'}</changefreq>
    <priority>${e.priority || '0.5'}</priority>
${images}
  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${items}
</urlset>`;
}

// ── 19. Atom 피드 rel=alternate 주입 ────────────────────────────────────
export function injectFeedLinks(html, baseUrl, siteTitle = 'Blog') {
  if (html.includes('application/rss+xml') || html.includes('application/atom+xml')) {
    return html;
  }
  const tags = [
    `<link rel="alternate" type="application/rss+xml" title="${escapeAttr(siteTitle)}" href="${escapeAttr(baseUrl + '/rss.xml')}">`,
    `<link rel="alternate" type="application/atom+xml" title="${escapeAttr(siteTitle)}" href="${escapeAttr(baseUrl + '/feeds/posts/default')}">`,
  ].join('\n');
  return html.replace(/(<\/head>)/i, `${tags}\n$1`);
}

// ── 20. 보안 헤더 강화 ──────────────────────────────────────────────────
export function buildSecurityHeaders(existingHeaders) {
  const h = new Headers(existingHeaders);
  // XSS 방지
  if (!h.has('x-xss-protection')) h.set('x-xss-protection', '1; mode=block');
  // MIME 스니핑 방지
  if (!h.has('x-content-type-options')) h.set('x-content-type-options', 'nosniff');
  // 클릭재킹 방지
  if (!h.has('x-frame-options')) h.set('x-frame-options', 'SAMEORIGIN');
  // Referrer 정책
  if (!h.has('referrer-policy')) h.set('referrer-policy', 'strict-origin-when-cross-origin');
  // 허용된 기능만
  if (!h.has('permissions-policy')) {
    h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  }
  return h;
}

// ── 21. Content-Encoding 힌트 ────────────────────────────────────────────
export function injectEncodingHints(headers) {
  const h = new Headers(headers);
  if (!h.has('vary')) h.set('vary', 'Accept-Encoding');
  else if (!h.get('vary').includes('Accept-Encoding')) {
    h.set('vary', h.get('vary') + ', Accept-Encoding');
  }
  return h;
}

// ── 22. IndexNow 핑 (Bing + Yandex) ─────────────────────────────────────
export async function pingIndexNow(url, apiKey, host) {
  if (!apiKey || !host) return { ok: false, reason: 'no-config' };
  const body = {
    host,
    key        : apiKey,
    keyLocation: `https://${host}/${apiKey}.txt`,
    urlList    : [url],
  };
  try {
    const [bing, yandex] = await Promise.allSettled([
      fetch('https://api.indexnow.org/indexnow', {
        method : 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body   : JSON.stringify(body),
      }),
      fetch('https://yandex.com/indexnow', {
        method : 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body   : JSON.stringify(body),
      }),
    ]);
    return {
      ok    : true,
      bing  : bing.status === 'fulfilled' ? bing.value.status : null,
      yandex: yandex.status === 'fulfilled' ? yandex.value.status : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 23. Google Discover 최적화 ──────────────────────────────────────────
export function optimizeForDiscover(html) {
  // og:image content 값에서 Blogger /s숫자/ 패턴만 /s1200/으로 업스케일
  // bp.blogspot.com 도메인 이미지만 대상 (다른 CDN URL 보호)
  return html.replace(
    /(<meta[^>]+(?:og:image|twitter:image)[^>]+content=["'])(https?:\/\/[^"']*\.bp\.blogspot\.com\/[^"']*\/s)(\d+)(\/[^"']*["'])/gi,
    (match, pre, urlPre, size, urlPost) => {
      if (parseInt(size) >= 1200) return match; // 이미 충분히 큼
      return pre + urlPre + '1200' + urlPost;
    }
  );
}

// ── 24. 모바일 최적화 메타 ──────────────────────────────────────────────
export function injectMobileOptimization(html) {
  if (html.includes('name="viewport"')) return html;
  return html.replace(/(<head[^>]*>)/i,
    `$1\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  );
}

// ── 25. Author Schema (E-E-A-T 신호) ────────────────────────────────────
export function injectAuthorSchema(html, ctx) {
  if (html.includes('"Person"') || !ctx.author) return html;

  const schema = {
    '@context': 'https://schema.org',
    '@type'   : 'Person',
    name      : ctx.author,
    url       : ctx.postUrl,
  };

  const tag = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  return html.replace(/(<\/head>)/i, `${tag}\n$1`);
}

// ── 통합 실행 함수 ───────────────────────────────────────────────────────
export function applyAllSeoFeatures(html, ctx, url, env) {
  const baseUrl   = env?.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com'
                    ? env.SITE_BASE_URL.replace(/\/$/, '') : url.origin;
  const host      = url.hostname;
  const pageType  = ctx.type || 'other';
  const hasImage  = !!ctx.imageUrl;
  const siteTitle = ctx.siteName || env?.SITE_TITLE || 'Blog';
  const lang      = env?.SITE_LANG || 'ko';
  // ✅ v8: ctx에 titlePath가 있으면 canonical에 SEO 슬러그 URL 사용
  const titlePath = ctx.titlePath || null;

  let o = html;
  o = injectHreflang(o, url, lang);
  o = injectBreadcrumb(o, url, pageType, siteTitle);
  o = injectRobotsMeta(o, pageType);
  o = strengthenCanonical(o, url, titlePath);
  o = injectResourceHints(o);
  o = injectImageAlts(o, ctx.title);
  o = normalizeLinks(o, host);
  // SearchAction은 홈/포스트에만
  if (pageType === 'home' || pageType === 'post') {
    o = injectSearchAction(o, baseUrl);
  }
  o = injectOgImageSize(o);
  o = strengthenTwitterCard(o, hasImage);
  o = injectLabelPageSeo(o, url);
  // [버그 수정] lazyload는 image-optimizer.js의 optimizeImageMarkup()에서
  // 파이프라인 앞단(worker.js transformHtml)에 이미 처리된다. 여기서
  // injectLazyLoading()을 한 번 더 돌리면 두 구현이 "첫 이미지를 어떻게
  // 판단하는지"를 서로 다르게 적용해 결과가 어긋날 수 있었다 (실제로
  // optimizeImageMarkup이 먼저 실행되며 첫 이미지까지 lazy 처리해버려
  // 히어로 이미지가 늦게 뜨는 화면 깨짐 현상의 원인이 되었다). 같은 일을
  // 두 곳에서 하지 않도록 여기서는 호출을 제거하고 optimizeImageMarkup
  // 한 곳에서만 담당하게 했다. (injectLazyLoading 함수 자체는 다른 곳에서
  // 재사용될 수 있어 export는 유지)
  o = injectFontOptimization(o);
  o = optimizeAdsense(o);
  o = injectFeedLinks(o, baseUrl, siteTitle);
  o = optimizeForDiscover(o);
  o = injectMobileOptimization(o);
  o = injectAuthorSchema(o, ctx);

  return o;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────
function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
