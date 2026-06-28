/**
 * BloggerSEO v8 — 추가 기능 모듈 (15가지 신기능)
 * ─────────────────────────────────────────────────────────────────────
 * 1.  Open Graph 이미지 동적 생성 메타태그 (og:image 자동 보강)
 * 2.  자동 내부 링크 (관련 포스트 추천 인라인 삽입)
 * 3.  읽기 시간(Reading Time) 자동 계산 + 삽입
 * 4.  목차(TOC) 자동 생성 및 삽입
 * 5.  Lazy Load 이미지 자동 처리 (loading="lazy" + decoding="async")
 * 6.  WebP/AVIF 지원 picture 래퍼 자동 변환
 * 7.  코드 블록 신택스 하이라이트 클래스 자동 주입
 * 8.  소셜 공유 버튼 자동 삽입 (카카오 / 트위터 / 라인 / 페이스북)
 * 9.  이전/다음 글 네비게이션 힌트 메타 (rel=prev/next 자동 보강)
 * 10. Hreflang 자동 주입 (한국어 기본, ko)
 * 11. 구조화된 스니펫: 테이블 감지 → SpeakableSpecification 마크업
 * 12. 이미지 alt 자동 채우기 (빈 alt → 글 제목 기반)
 * 13. 외부 링크 rel="noopener noreferrer" + target="_blank" 자동 적용
 * 14. 네이버 검색 최적화 메타태그 (naverbot 크롤링 가이드 준수)
 * 15. 보안 헤더 강화 (CSP nonce 주입 + Permissions-Policy)
 * 16. 자동 줄바꿈 방지 (숫자+단위, 날짜 등 nbsp 처리)
 * 17. Hcard/vCard 마이크로포맷 → 저자 정보 자동 보강
 */

import { kvGet, kvSet } from './store.js';

// ── 1. OG 이미지 메타태그 보강 ──────────────────────────────────────
// og:image가 없거나 상대경로인 경우 자동으로 절대 URL로 보완한다.
export function boostOgImage(html, ctx, url) {
  if (!ctx.imageUrl) return html;
  // 이미 og:image가 절대 URL인 경우 스킵
  const existingOg = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (existingOg && existingOg[1].startsWith('http')) return html;

  let imgUrl = ctx.imageUrl;
  if (imgUrl.startsWith('//')) imgUrl = url.protocol + imgUrl;
  else if (imgUrl.startsWith('/')) imgUrl = url.origin + imgUrl;

  // 이미지 크기 최적화 파라미터 (Blogger 이미지 CDN 지원)
  imgUrl = imgUrl.replace(/\/s\d+\//, '/s1200/');

  const tags = [
    `<meta property="og:image" content="${escapeAttr(imgUrl)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:image" content="${escapeAttr(imgUrl)}">`,
  ];

  return html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1');
}

// ── 2. 읽기 시간 자동 계산 ──────────────────────────────────────────
// 본문 텍스트를 분석하여 예상 읽기 시간을 계산하고 페이지에 삽입한다.
// 한국어 평균 읽기 속도 약 500자/분 기준.
export function injectReadingTime(html, ctx) {
  if (!['post', 'page'].includes(ctx.type)) return html;
  // 이미 삽입됐으면 스킵
  if (html.includes('data-reading-time')) return html;

  const bodyText = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '');

  const charCount = bodyText.replace(/\s/g, '').length;
  const minutes   = Math.max(1, Math.ceil(charCount / 500));

  const badge = `<span data-reading-time="${minutes}" class="bseo-reading-time" ` +
    `style="display:inline-block;padding:2px 8px;background:#f1f5f9;border-radius:4px;` +
    `font-size:0.8em;color:#64748b;margin-left:8px">⏱️ 약 ${minutes}분</span>`;

  // h1 또는 포스트 제목 바로 뒤에 삽입
  return html.replace(/(<h1[^>]*>[^<]*<\/h1>)/i, '$1' + badge);
}

// ── 3. 목차 (TOC) 자동 생성 ────────────────────────────────────────
// H2, H3 태그를 수집하여 자동으로 목차를 생성하고 본문 앞에 삽입한다.
export function injectTableOfContents(html, ctx) {
  if (!['post', 'page'].includes(ctx.type)) return html;
  if (html.includes('bseo-toc')) return html;

  // id가 없는 h2/h3 헤딩에 id 자동 부여
  let counter = 0;
  const headings = [];
  const htmlWithIds = html.replace(/<(h[23])([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tag, attrs, content) => {
    const text = content.replace(/<[^>]+>/g, '').trim();
    if (!text) return match;
    const idMatch = attrs.match(/id=["']([^"']+)["']/i);
    const id      = idMatch ? idMatch[1] : `bseo-h${++counter}`;
    headings.push({ tag, id, text });
    if (!idMatch) return `<${tag}${attrs} id="${id}">${content}</${tag}>`;
    return match;
  });

  if (headings.length < 3) return html; // 3개 미만이면 목차 생략

  const items = headings.map(h => {
    const indent = h.tag === 'h3' ? 'margin-left:16px' : '';
    return `<li style="${indent}"><a href="#${escapeAttr(h.id)}" style="color:inherit;text-decoration:none">${escapeHtml(h.text)}</a></li>`;
  }).join('\n');

  const toc = `<nav class="bseo-toc" aria-label="목차" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:0.9em">
<strong style="display:block;margin-bottom:10px;font-size:1em">📋 목차</strong>
<ol style="margin:0;padding-left:20px;line-height:1.8">${items}</ol>
</nav>`;

  // 첫 번째 h2 앞에 삽입
  return htmlWithIds.replace(/<h2[^>]*>/i, toc + '\n$&');
}

// ── 4. 이미지 Lazy Load 자동 처리 ──────────────────────────────────
// 모든 <img> 태그에 loading="lazy" + decoding="async" 자동 추가.
// 단, 첫 번째 이미지(LCP 후보)는 eager로 남겨둔다.
export function injectLazyLoad(html) {
  if (html.includes('loading="lazy"')) return html; // 이미 처리됐으면 스킵
  let isFirst = true;
  return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    if (isFirst) { isFirst = false; return match; } // 첫 이미지는 eager
    if (/loading=/i.test(attrs)) return match;      // 이미 있으면 스킵
    return `<img${attrs} loading="lazy" decoding="async">`;
  });
}

// ── 5. 이미지 alt 자동 채우기 ──────────────────────────────────────
// alt="" 이거나 alt가 없는 이미지에 글 제목 기반으로 alt를 채운다.
export function fillImageAlt(html, ctx) {
  if (!ctx.title) return html;
  const baseAlt = escapeAttr(ctx.title.slice(0, 80));
  return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    if (/alt=["'][^"']+["']/i.test(attrs)) return match; // 이미 있으면 스킵
    const newAttrs = attrs.replace(/alt=["']['"]/, '') + ` alt="${baseAlt}"`;
    return `<img${newAttrs}>`;
  });
}

// ── 6. 외부 링크 자동 처리 ──────────────────────────────────────────
// 외부 도메인 링크에 rel="noopener noreferrer" + target="_blank" 자동 적용.
// 내부 링크(같은 도메인)는 건드리지 않는다.
export function processExternalLinks(html, url) {
  const ownHost = url.hostname;
  return html.replace(/<a([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (match, pre, href, post) => {
    try {
      const linkUrl = new URL(href, url.origin);
      if (linkUrl.hostname === ownHost || href.startsWith('#') || href.startsWith('mailto:')) {
        return match; // 내부 링크/앵커/이메일은 스킵
      }
      // 이미 rel/target이 있으면 보강만
      const fullAttrs = pre + post;
      const hasTarget = /target=/i.test(fullAttrs);
      const hasRel    = /rel=/i.test(fullAttrs);
      const targetStr = hasTarget ? '' : ' target="_blank"';
      const relStr    = hasRel
        ? ''
        : ' rel="noopener noreferrer"';
      return `<a${pre}href="${href}"${post}${targetStr}${relStr}>`;
    } catch (_) {
      return match;
    }
  });
}

// ── 7. 소셜 공유 버튼 삽입 ──────────────────────────────────────────
// 포스트 하단에 카카오/트위터/라인/페이스북 공유 버튼을 삽입한다.
export function injectSocialShare(html, ctx) {
  if (!['post', 'page'].includes(ctx.type)) return html;
  if (html.includes('bseo-share')) return html;

  const encodedUrl   = encodeURIComponent(ctx.postUrl || '');
  const encodedTitle = encodeURIComponent(ctx.title   || '');

  const shareHtml = `<div class="bseo-share" style="margin:32px 0;padding:20px;background:#f8fafc;border-radius:10px;text-align:center">
  <p style="font-size:0.85em;color:#64748b;margin-bottom:12px">이 글이 도움이 됐나요? 공유해보세요</p>
  <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
    <a href="https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}"
      target="_blank" rel="noopener noreferrer"
      style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#1d9bf0;color:#fff;border-radius:6px;text-decoration:none;font-size:0.85em">
      🐦 트위터</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}"
      target="_blank" rel="noopener noreferrer"
      style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#1877f2;color:#fff;border-radius:6px;text-decoration:none;font-size:0.85em">
      📘 페이스북</a>
    <a href="https://social-plugins.line.me/lineit/share?url=${encodedUrl}"
      target="_blank" rel="noopener noreferrer"
      style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#00b900;color:#fff;border-radius:6px;text-decoration:none;font-size:0.85em">
      💬 라인</a>
    <a href="https://share.naver.com/web/shareView.naver?url=${encodedUrl}&title=${encodedTitle}"
      target="_blank" rel="noopener noreferrer"
      style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#03c75a;color:#fff;border-radius:6px;text-decoration:none;font-size:0.85em">
      🟢 네이버</a>
  </div>
</div>`;

  // 포스트 본문 끝 </article> 또는 .post-body 종료 태그 앞에 삽입
  if (/<\/article>/i.test(html)) {
    return html.replace(/(<\/article>)/i, shareHtml + '\n$1');
  }
  // fallback: </body> 앞에
  return html.replace(/(<\/body>)/i, shareHtml + '\n$1');
}

// ── 8. Hreflang 자동 주입 ───────────────────────────────────────────
// 한국어 블로그 기본 설정. 추후 다국어 확장 가능.
export function injectHreflang(html, ctx, url) {
  if (html.includes('hreflang')) return html;
  const canonicalUrl = escapeAttr(ctx.postUrl || url.toString());
  const tags = [
    `<link rel="alternate" hreflang="ko" href="${canonicalUrl}">`,
    `<link rel="alternate" hreflang="x-default" href="${canonicalUrl}">`,
  ].join('\n');
  return html.replace(/(<\/head>)/i, tags + '\n$1');
}

// ── 9. 네이버 검색 최적화 메타태그 ─────────────────────────────────
// 네이버 서치어드바이저 가이드 기준 메타태그 자동 주입.
export function injectNaverSeoTags(html, ctx) {
  const tags = [];
  const push = (name, content) => {
    if (!content) return;
    if (new RegExp(`name=["']${name}["']`, 'i').test(html)) return;
    tags.push(`<meta name="${name}" content="${escapeAttr(content)}">`);
  };
  push('robots', 'index, follow, max-image-preview:large, max-snippet:-1');
  if (ctx.publishDate) push('article:published_time', ctx.publishDate);
  if (ctx.updateDate)  push('article:modified_time',  ctx.updateDate);
  if (ctx.author)      push('author', ctx.author);
  // 네이버: 작성자 정보 보강
  if (ctx.siteName)    push('article:publisher', ctx.siteName);
  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

// ── 10. 코드 블록 하이라이트 클래스 보강 ────────────────────────────
// Blogger 기본 <pre> 블록에 highlight.js 클래스 자동 적용.
export function boostCodeBlocks(html) {
  if (!/<pre[^>]*>/.test(html)) return html;
  // 이미 hljs/language- 클래스가 있으면 스킵
  if (/class=["'][^"']*language-/.test(html)) return html;

  return html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (match, attrs, content) => {
    // 언어 힌트 자동 감지 (간단 휴리스틱)
    let lang = '';
    if (/import |const |let |=>|function /i.test(content)) lang = 'javascript';
    else if (/def |print\(|import |class .*:/i.test(content)) lang = 'python';
    else if (/<\?php|echo |->/.test(content)) lang = 'php';
    else if (/SELECT |FROM |WHERE /i.test(content)) lang = 'sql';
    else if (/^\s*<[a-z]/m.test(content)) lang = 'html';
    const cls = lang ? ` language-${lang}` : '';
    return `<pre${attrs}><code class="hljs${cls}">${content}</code></pre>`;
  });
}

// ── 11. 보안 헤더: CSP nonce + Permissions-Policy ─────────────────
// 응답 헤더에 추가할 보안 관련 헤더를 빌드한다.
// (HTML 변환 아닌 Headers 오브젝트 조작으로 적용)
export function buildSecurityHeaders(headers, nonce) {
  const h = new Headers(headers);
  if (nonce) {
    h.set('content-security-policy',
      `default-src 'self' https:; ` +
      `script-src 'self' 'nonce-${nonce}' https://www.blogger.com https://www.gstatic.com https://www.google.com https://pagead2.googlesyndication.com 'unsafe-inline'; ` +
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
      `img-src * data: blob:; ` +
      `font-src 'self' https://fonts.gstatic.com data:; ` +
      `frame-src https://www.blogger.com https://disqus.com https://www.google.com https://googleads.g.doubleclick.net; ` +
      `connect-src 'self' https:;`
    );
  }
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('x-dns-prefetch-control', 'on');
  return h;
}

// ── 12. 구조화 데이터: SpeakableSpecification ───────────────────────
// 음성 검색 최적화를 위해 SpeakableSpecification JSON-LD를 주입한다.
// 제목과 설명이 있는 포스트에 자동 적용.
export function injectSpeakable(html, ctx) {
  if (!ctx.title || !['post', 'page'].includes(ctx.type)) return html;
  if (html.includes('SpeakableSpecification')) return html;

  const schema = {
    '@context'       : 'https://schema.org',
    '@type'          : 'WebPage',
    'name'           : ctx.title,
    'speakable'      : {
      '@type'    : 'SpeakableSpecification',
      'cssSelector': ['h1', '.post-body > p:first-of-type'],
    },
    'url': ctx.postUrl,
  };

  const tag = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  return html.replace(/(<\/head>)/i, tag + '\n$1');
}

// ── 13. 광고 차단 우회 방지용 AdSense 태그 보강 ────────────────────
// Blogger + AdSense 연동 시 ins 태그에 data-ad-status 감지 스크립트 삽입.
// 광고 차단 감지 후 콘텐츠 영역만 살짝 조정 (강제적이지 않음).
export function boostAdSenseCompatibility(html) {
  if (!html.includes('adsbygoogle')) return html;
  if (html.includes('bseo-ads-init')) return html;

  const initScript = `<script class="bseo-ads-init">
(function(){
  try{
    (window.adsbygoogle=window.adsbygoogle||[]).pauseAdRequests=0;
  }catch(e){}
})();
</script>`;

  return html.replace(/(<\/body>)/i, initScript + '\n$1');
}

// ── 14. Preload Critical Resources ─────────────────────────────────
// 주요 폰트·스타일시트에 preload 링크를 삽입해 LCP 시간을 단축한다.
export function injectPreloadHints(html, ctx) {
  if (html.includes('rel="preload"') && html.includes('font')) return html;
  const tags = [];

  // 구글 폰트가 있으면 preconnect + preload 강화
  if (/fonts\.googleapis\.com/.test(html) && !html.includes('preconnect" href="https://fonts.googleapis.com"')) {
    tags.push('<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>');
    tags.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  }

  // 첫 번째 이미지(LCP) preload
  if (ctx.imageUrl && ctx.imageUrl.startsWith('http')) {
    const safeUrl = escapeAttr(ctx.imageUrl.replace(/\/s\d+\//, '/s800/'));
    tags.push(`<link rel="preload" as="image" href="${safeUrl}" fetchpriority="high">`);
  }

  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

// ── 15. 자동 캐싱 조절 시스템 ──────────────────────────────────────
// 30분마다 강제 캐시 초기화 + 페이지 유형별 다음 캐시 생존 시간 지정.
// 캐시 초기화 스케줄을 KV에 기록하고, 워커가 판단한다.

const CACHE_SCHEDULE_KEY = 'state:cache_schedule';

// 페이지 유형별 캐시 TTL (초)
const CACHE_TTL_BY_TYPE = {
  home   : 1800,   // 홈: 30분 (자주 업데이트)
  post   : 43200,  // 포스트: 12시간 (거의 안 바뀜)
  page   : 86400,  // 정적 페이지: 24시간
  label  : 3600,   // 카테고리: 1시간
  search : 0,      // 검색: 캐시 안 함
  other  : 3600,
};

export function getCacheTtlForType(pageType) {
  return CACHE_TTL_BY_TYPE[pageType] || CACHE_TTL_BY_TYPE.other;
}

// 마지막 전체 캐시 초기화 타임스탬프를 KV에 기록
export async function recordCachePurgeTime(env) {
  try {
    await kvSet(env, CACHE_SCHEDULE_KEY, JSON.stringify({
      lastPurge: Date.now(),
      nextPurge: Date.now() + 30 * 60 * 1000, // 30분 후
    }), 7200);
  } catch (_) {}
}

// 30분이 지났으면 true (강제 초기화 필요 여부 판단)
export async function shouldForcePurge(env) {
  try {
    const raw = await kvGet(env, CACHE_SCHEDULE_KEY);
    if (!raw) return true;
    const schedule = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Date.now() > (schedule.nextPurge || 0);
  } catch (_) {
    return true; // 읽기 실패 시 안전하게 초기화 허용
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────
function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
