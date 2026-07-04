export function isOptimizableImagePath(path) { return /\.(png|jpe?g|gif|webp)$/i.test(path); }
export function imageCfOptions(request, env) {
  const accept = request.headers.get('accept') || '';
  const format = accept.includes('image/avif') ? 'avif' : accept.includes('image/webp') ? 'webp' : undefined;
  return { image: { fit: 'scale-down', quality: Number(env.IMAGE_QUALITY) || 82, metadata: 'none', ...(format ? { format } : {}) }, cacheEverything: true, cacheTtl: Number(env.IMAGE_CACHE_TTL_SEC) || 2592000 };
}
// [버그 수정] 이전에는 첫 번째 이미지(LCP 후보)에도 무조건 loading="lazy" +
// fetchpriority="low"를 강제로 붙였다. 이 때문에 방문자가 페이지에 들어왔을 때
// 정작 가장 먼저 보여야 할 히어로/썸네일 이미지가 브라우저에 의해 로딩이
// 지연되어, 화면이 빈 회색 박스로 한참 남아있다가 뒤늦게 채워지는(또는
// 스크롤 전까지 아예 안 뜨는) "화면 깨짐" 현상의 핵심 원인이었다.
// 게다가 이 결과가 그대로 Cache Reserve에 저장되어, 캐시가 만료되기
// 전까지 모든 방문자가 계속 이 깨진 렌더링을 보게 되는 문제로 이어졌다.
//
// → 첫 번째 이미지는 LCP 후보로 간주해 eager + fetchpriority="high"로 두고,
//   두 번째 이미지부터만 lazy 처리한다. seo-features.js의 injectLazyLoading과
//   동일한 "첫 이미지는 즉시 로드" 규칙을 따르도록 통일했다.
const SKIP_EAGER_OVERRIDE = [/blogger\.com/i, /gstatic\.com/i, /\/img\.gif/i, /spacer/i, /favicon/i];

export function optimizeImageMarkup(html) {
  let firstContentImageDone = false;
  return html.replace(/<img\b([^>]*?)>/gi, (m, attrs) => {
    let a = attrs;
    const srcMatch = a.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    const src = srcMatch ? srcMatch[1] : '';
    const isSystemImage = src && SKIP_EAGER_OVERRIDE.some(p => p.test(src));
    const isFirstContentImage = !firstContentImageDone && !isSystemImage;
    if (isFirstContentImage) firstContentImageDone = true;

    if (isFirstContentImage) {
      // ✅ [화면 깨짐 재수정] 위 주석의 v1 수정은 "loading=/fetchpriority=가
      // 이미 있으면 건드리지 않는다"는 전제를 깔고 있었는데, 최근 Blogger
      // 기본 테마는 <img>에 loading="lazy"를 이미 박아서 내려준다. 그러면
      // 이 히어로 이미지가 여전히 lazy로 남아 처음 화면 진입 시 빈 박스로
      // 있다가 늦게 채워지는 문제가 그대로 재발했다. 첫 콘텐츠 이미지는
      // 원본에 어떤 값이 있었든 항상 eager/high로 강제 덮어쓴다.
      a = a
        .replace(/\s+loading\s*=\s*["'][^"']*["']/i, '')
        .replace(/\s+fetchpriority\s*=\s*["'][^"']*["']/i, '');
      a += ' loading="eager" fetchpriority="high"';
    } else {
      if (!/loading=/i.test(a)) a += ' loading="lazy"';
      if (!/fetchpriority=/i.test(a)) a += ' fetchpriority="low"';
    }
    if (!/decoding=/i.test(a)) a += ' decoding="async"';
    return `<img${a}>`;
  });
}
