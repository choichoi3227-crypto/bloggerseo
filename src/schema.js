/**
 * BloggerSEO v6 — 자동 스키마 마크업 엔진
 * ─────────────────────────────────────────────────────────────────────
 * 생성 스키마:
 *   필수: Article, FAQ
 *   선택: Breadcrumb, Product
 *
 * AI 활용:
 *   - FAQ 자동 추출: Claude API (Anthropic) 호출
 *   - Product 감지: 가격/리뷰 패턴 파싱
 *   - 결과 캐시: Redis (4시간, store.js schemaPut/schemaGet)
 *
 * 구글·네이버·빙 최적화:
 *   - Article: datePublished, dateModified, author, image 완전 보강
 *   - FAQ: Q&A 쌍 최대 10개, AI로 본문 분석 추출
 *   - Breadcrumb: URL 경로 자동 분석
 *   - Product: 가격/리뷰 패턴 자동 감지
 */

import { schemaGet, schemaPut } from './store.js';

// ── 해시 (캐시 키) ────────────────────────────────────────────────────
function hashContent(url, title) {
  let h = 0x811c9dc5;
  const s = url + title;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

// ── 메인 진입점 ──────────────────────────────────────────────────────
export async function buildSchemas(html, ctx, url, env) {
  const cacheHash = hashContent(url.toString(), ctx.title || '');
  const cached    = await schemaGet(env, cacheHash);
  if (cached) return cached;

  const schemas = [];

  // 1. WebSite (항상)
  schemas.push(buildWebSiteSchema(ctx, url));

  // 2. Article (post/page)
  if (['post', 'page'].includes(ctx.type)) {
    schemas.push(buildArticleSchema(ctx, url));
  } else {
    schemas.push(buildWebPageSchema(ctx, url));
  }

  // 3. FAQ (AI 추출 or 정적 파싱)
  const faqs = await extractFaqs(html, ctx, env);
  if (faqs.length > 0) {
    schemas.push(buildFaqSchema(faqs));
  }

  // 4. Breadcrumb (경로 분석)
  const breadcrumbs = buildBreadcrumbList(url, ctx);
  if (breadcrumbs.length > 1) {
    schemas.push(buildBreadcrumbSchema(breadcrumbs));
  }

  // 5. Product (가격/리뷰 패턴 감지)
  const product = extractProductData(html, ctx);
  if (product) {
    schemas.push(buildProductSchema(product, ctx, url));
  }

  // 캐시 저장 (4시간)
  await schemaPut(env, cacheHash, schemas, 14400);
  return schemas;
}

// ── Article 스키마 ────────────────────────────────────────────────────
function buildArticleSchema(ctx, url) {
  const s = {
    '@context'        : 'https://schema.org',
    '@type'           : 'Article',
    '@id'             : ctx.postUrl + '#article',
    mainEntityOfPage  : { '@type': 'WebPage', '@id': ctx.postUrl },
    headline          : ctx.title,
    description       : ctx.description,
    inLanguage        : 'ko-KR',
    author            : {
      '@type': 'Person',
      name   : ctx.author || ctx.siteName || '',
    },
    publisher: {
      '@type': 'Organization',
      name   : ctx.siteName || '',
      logo   : ctx.logoUrl ? { '@type': 'ImageObject', url: ctx.logoUrl } : undefined,
    },
  };
  if (ctx.imageUrl)    s.image          = { '@type': 'ImageObject', url: ctx.imageUrl, width: 1200, height: 630 };
  if (ctx.publishDate) s.datePublished  = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified   = ctx.updateDate;
  if (ctx.tags?.length) s.keywords      = ctx.tags.join(', ');
  // 네이버 블로그 최적화: articleSection
  if (ctx.tags?.[0])  s.articleSection  = ctx.tags[0];
  // 구조화 데이터 완전성 향상
  s.url = ctx.postUrl;
  return s;
}

// ── WebPage 스키마 ────────────────────────────────────────────────────
function buildWebPageSchema(ctx, url) {
  return {
    '@context'   : 'https://schema.org',
    '@type'      : 'WebPage',
    '@id'        : ctx.postUrl + '#webpage',
    url          : ctx.postUrl,
    name         : ctx.title,
    description  : ctx.description,
    isPartOf     : { '@id': url.origin + '/#website' },
    inLanguage   : 'ko-KR',
    ...(ctx.publishDate ? { datePublished: ctx.publishDate } : {}),
    ...(ctx.updateDate  ? { dateModified : ctx.updateDate  } : {}),
  };
}

// ── WebSite 스키마 ────────────────────────────────────────────────────
function buildWebSiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org',
    '@type'   : 'WebSite',
    '@id'     : url.origin + '/#website',
    url       : url.origin + '/',
    name      : ctx.siteName || ctx.title,
    inLanguage: 'ko-KR',
    potentialAction: {
      '@type'       : 'SearchAction',
      target        : { '@type': 'EntryPoint', urlTemplate: url.origin + '/search?q={search_term_string}' },
      'query-input' : 'required name=search_term_string',
    },
    ...(ctx.logoUrl ? {
      publisher: {
        '@type': 'Organization',
        name   : ctx.siteName,
        logo   : { '@type': 'ImageObject', url: ctx.logoUrl },
      },
    } : {}),
  };
}

// ── FAQ 스키마 ────────────────────────────────────────────────────────
function buildFaqSchema(faqs) {
  return {
    '@context'  : 'https://schema.org',
    '@type'     : 'FAQPage',
    mainEntity  : faqs.map(({ q, a }) => ({
      '@type'        : 'Question',
      name           : q,
      acceptedAnswer : { '@type': 'Answer', text: a },
    })),
  };
}

// ── Breadcrumb 스키마 ────────────────────────────────────────────────
function buildBreadcrumbSchema(crumbs) {
  return {
    '@context'   : 'https://schema.org',
    '@type'      : 'BreadcrumbList',
    itemListElement: crumbs.map(({ name, url }, i) => ({
      '@type'  : 'ListItem',
      position : i + 1,
      name,
      item     : url,
    })),
  };
}

function buildBreadcrumbList(url, ctx) {
  const crumbs = [{ name: ctx.siteName || '홈', url: url.origin + '/' }];
  const parts  = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return crumbs;

  // /search/label/태그
  if (url.pathname.startsWith('/search/label/')) {
    const label = decodeURIComponent(parts[2] || '');
    crumbs.push({ name: label, url: url.origin + '/search/label/' + encodeURIComponent(label) });
  } else if (parts.length >= 3 && /^\d{4}$/.test(parts[0])) {
    // /2024/06/slug.html
    crumbs.push({ name: parts[0] + '년', url: url.origin + '/' + parts[0] });
    if (ctx.title) crumbs.push({ name: ctx.title, url: ctx.postUrl });
  } else if (ctx.title) {
    crumbs.push({ name: ctx.title, url: ctx.postUrl });
  }
  return crumbs;
}

// ── Product 스키마 ────────────────────────────────────────────────────
const PRICE_PATTERNS = [
  /(?:가격|price|원|₩)\s*:?\s*([\d,]+)\s*(?:원|won|KRW)?/gi,
  /(\d{1,3}(?:,\d{3})+)\s*원/g,
];
const REVIEW_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*\/\s*5(?:\s*점)?/g,
  /평점\s*:?\s*(\d+(?:\.\d+)?)/gi,
  /rating\s*:?\s*(\d+(?:\.\d+)?)/gi,
];

function extractProductData(html, ctx) {
  const bodyText = html.replace(/<[^>]+>/g, ' ');

  // 가격 감지
  let price = null;
  for (const re of PRICE_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(bodyText);
    if (m) { price = m[1].replace(/,/g, ''); break; }
  }
  if (!price) return null;

  // 평점 감지
  let rating = null;
  for (const re of REVIEW_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(bodyText);
    if (m && parseFloat(m[1]) <= 5) { rating = parseFloat(m[1]); break; }
  }

  return { price, rating, currency: 'KRW' };
}

function buildProductSchema(product, ctx, url) {
  const s = {
    '@context'  : 'https://schema.org',
    '@type'     : 'Product',
    name        : ctx.title,
    description : ctx.description,
    url         : ctx.postUrl,
    offers      : {
      '@type'       : 'Offer',
      price         : product.price,
      priceCurrency : product.currency,
      availability  : 'https://schema.org/InStock',
      url           : ctx.postUrl,
    },
  };
  if (ctx.imageUrl) s.image = ctx.imageUrl;
  if (product.rating) {
    s.aggregateRating = {
      '@type'      : 'AggregateRating',
      ratingValue  : product.rating,
      bestRating   : 5,
      worstRating  : 1,
      ratingCount  : 1,
    };
  }
  return s;
}

// ── FAQ 추출 (AI + 정적 파싱 혼합) ──────────────────────────────────
async function extractFaqs(html, ctx, env) {
  // 1. 정적 파싱: <details><summary>Q</summary>A</details> 패턴
  const staticFaqs = extractStaticFaqs(html);
  if (staticFaqs.length >= 2) return staticFaqs.slice(0, 10);

  // 2. AI 추출 (Anthropic API) — 포스트 페이지만
  if (['post', 'page'].includes(ctx.type) && env.AI_FAQ_ENABLED === 'true') {
    try {
      const faqs = await extractFaqsWithAI(html, ctx, env);
      if (faqs.length > 0) return faqs.slice(0, 10);
    } catch (_) {}
  }

  // 3. 헤딩+단락 파싱으로 폴백
  return extractHeadingFaqs(html).slice(0, 6);
}

function extractStaticFaqs(html) {
  const faqs = [];
  // <details><summary>질문</summary>답변</details>
  const re1 = /<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const q = m[1].replace(/<[^>]+>/g, '').trim();
    const a = m[2].replace(/<[^>]+>/g, '').trim();
    if (q && a && q.length < 200 && a.length < 1000) faqs.push({ q, a });
  }
  // Q: ... A: ... 패턴
  const re2 = /(?:Q:|질문[:\.]?)\s*([^\n]+)\n+(?:A:|답[:\.]?)\s*([^\n]+)/gi;
  while ((m = re2.exec(html.replace(/<[^>]+>/g, '\n'))) !== null) {
    const q = m[1].trim(), a = m[2].trim();
    if (q && a) faqs.push({ q, a });
  }
  return faqs;
}

function extractHeadingFaqs(html) {
  const faqs = [];
  const bodyText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // h2/h3 + 다음 단락
  const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>\s*(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  let m;
  while ((m = re.exec(bodyText)) !== null) {
    const q = m[1].replace(/<[^>]+>/g, '').trim();
    const a = (m[2] || '').replace(/<[^>]+>/g, '').trim();
    if (q && a && q.length < 150 && q.length > 5 && a.length > 10) {
      faqs.push({ q: q.endsWith('?') || q.endsWith('？') ? q : q + '란?', a });
    }
  }
  return faqs;
}

// Cloudflare AI Workers AI API를 통한 FAQ 추출
async function extractFaqsWithAI(html, ctx, env) {
  // Cloudflare Workers AI 사용 (env.AI 바인딩)
  if (!env.AI) return [];

  const bodyText = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 3000); // 3000자로 제한

  const prompt = `다음 블로그 포스트 본문에서 FAQ(자주 묻는 질문과 답변) 쌍을 최대 5개 추출하세요.
반드시 JSON 배열 형식으로만 응답하세요: [{"q":"질문","a":"답변"},...]
질문은 의문문으로 끝나야 하며, 답변은 본문에서 찾은 내용이어야 합니다.
포스트 제목: ${ctx.title}
본문: ${bodyText}`;

  try {
    const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
    });
    const text = result?.response || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item.q && item.a && typeof item.q === 'string');
  } catch (_) { return []; }
}

// ── 스키마를 HTML에 주입 ──────────────────────────────────────────────
export function injectSchemaMarkup(html, schemas) {
  if (!schemas || schemas.length === 0) return html;
  // 기존 스키마 중복 방지
  if (html.includes('"@context":"https://schema.org"') ||
      html.includes('"@context": "https://schema.org"')) return html;

  const ld = `<script type="application/ld+json">${JSON.stringify(schemas, null, 0)}<\/script>`;
  return html.replace(/(<\/head>)/i, ld + '\n$1');
}

// ── 구글·네이버·빙 최적화 메타태그 ─────────────────────────────────
export function injectSearchEngineTags(html, ctx, env) {
  const tags = [];
  const ev   = env || {};

  // 구글 서치콘솔 인증
  if (ev.GOOGLE_SITE_VERIFY && !html.includes('google-site-verification')) {
    tags.push(`<meta name="google-site-verification" content="${ev.GOOGLE_SITE_VERIFY}">`);
  }
  // 네이버 서치어드바이저
  if (ev.NAVER_SITE_VERIFY && !html.includes('naver-site-verification')) {
    tags.push(`<meta name="naver-site-verification" content="${ev.NAVER_SITE_VERIFY}">`);
  }
  // 빙 웹마스터
  if (ev.BING_SITE_VERIFY && !html.includes('msvalidate.01')) {
    tags.push(`<meta name="msvalidate.01" content="${ev.BING_SITE_VERIFY}">`);
  }

  // 네이버 SEO 특화 태그
  if (!html.includes('og:locale')) {
    tags.push('<meta property="og:locale" content="ko_KR">');
  }

  // 빙 IndexNow (힌트만 삽입, 실제 핑은 Cron에서)
  if (!html.includes('x-robots-tag')) {
    tags.push('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">');
  }

  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}
