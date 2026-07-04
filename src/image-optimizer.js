export function isOptimizableImagePath(path) { return /\.(png|jpe?g|gif|webp)$/i.test(path); }
export function imageCfOptions(request, env) {
  const accept = request.headers.get('accept') || '';
  const format = accept.includes('image/avif') ? 'avif' : accept.includes('image/webp') ? 'webp' : undefined;
  return { image: { fit: 'scale-down', quality: Number(env.IMAGE_QUALITY) || 82, metadata: 'none', ...(format ? { format } : {}) }, cacheEverything: true, cacheTtl: Number(env.IMAGE_CACHE_TTL_SEC) || 2592000 };
}
export function optimizeImageMarkup(html) {
  return html.replace(/<img\b([^>]*?)>/gi, (m, attrs) => {
    let a = attrs;
    if (!/loading=/i.test(a)) a += ' loading="lazy"';
    if (!/decoding=/i.test(a)) a += ' decoding="async"';
    if (!/fetchpriority=/i.test(a)) a += ' fetchpriority="low"';
    return `<img${a}>`;
  });
}
