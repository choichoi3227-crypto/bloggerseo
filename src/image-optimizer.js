export function isOptimizableImagePath(path) { return /\.(png|jpe?g|gif|webp)$/i.test(path); }

export function imageCfOptions(request, env) {
  const accept = request.headers.get('accept') || '';
  const format = accept.includes('image/avif') ? 'avif' : accept.includes('image/webp') ? 'webp' : undefined;
  return { 
    image: { 
      fit: 'scale-down', 
      quality: Number(env.IMAGE_QUALITY) || 82, 
      metadata: 'none', 
      ...(format ? { format } : {}) 
    }, 
    cacheEverything: true, 
    cacheTtl: Number(env.IMAGE_CACHE_TTL_SEC) || 2592000 
  };
}

const SKIP_EAGER_OVERRIDE = [/blogger\.com/i, /gstatic\.com/i, /\/img\.gif/i, /spacer/i, /favicon/i];

/**
 * Generates an optimized responsive srcset for Google-hosted images
 * utilizing Google's native CDN resizing & WebP auto-conversion (-rw).
 */
export function generateResponsiveSrcset(src) {
  if (!src) return null;
  const isGoogleImage = /bp\.blogspot\.com/i.test(src) || /googleusercontent\.com/i.test(src);
  if (!isGoogleImage) return null;

  // Skip typical small layout elements, icons, avatars, and trackers
  if (/\b(favicon|avatar|logo|icon|button|spacer|marker|spinner|gravatar)\b/i.test(src)) return null;

  let originalSize = 1600;
  const pathSizeMatch = src.match(/\/(s|w|h)(\d+)(-[a-zA-Z0-9_-]+)?\//);
  const paramSizeMatch = src.match(/=(s|w|h)(\d+)(-[a-zA-Z0-9_-]+)?$/);

  let hasPathSize = false;
  let hasParamSize = false;

  if (pathSizeMatch) {
    originalSize = parseInt(pathSizeMatch[2], 10);
    hasPathSize = true;
  } else if (paramSizeMatch) {
    originalSize = parseInt(paramSizeMatch[2], 10);
    hasParamSize = true;
  }

  // If original is very small (like a thumbnail or profile pic), don't generate massive srcset
  if (originalSize < 200) return null;

  // Responsive widths to generate
  const widths = [320, 480, 640, 800, 1020, 1200, 1600];
  const items = [];

  for (const w of widths) {
    if (w > originalSize * 1.5) break; // Don't upscale past reasonable limits
    let resizedSrc = src;
    if (hasPathSize) {
      resizedSrc = src.replace(/\/(s|w|h)\d+([a-zA-Z0-9_-]+)?\//, `/s${w}-rw/`);
    } else if (hasParamSize) {
      resizedSrc = src.replace(/=(s|w|h)\d+([a-zA-Z0-9_-]+)?$/, `=s${w}-rw`);
    } else {
      // Append size param
      resizedSrc = src + `=s${w}-rw`;
    }
    items.push(`${resizedSrc} ${w}w`);
  }

  if (items.length === 0) return null;
  return items.join(', ');
}

/**
 * Formats image tags to apply lazy loading, preloading, async decoding,
 * responsive source sets, and automated SEO alt attributes.
 */
export function optimizeImageMarkup(html, ctx = null) {
  let firstContentImageDone = false;
  let imgCount = 0;

  return html.replace(/<img\b([^>]*?)>/gi, (m, attrs) => {
    let a = attrs;
    const srcMatch = a.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    const src = srcMatch ? srcMatch[1] : '';
    
    const isSystemImage = src && SKIP_EAGER_OVERRIDE.some(p => p.test(src));
    const isFirstContentImage = !firstContentImageDone && !isSystemImage;
    if (isFirstContentImage) firstContentImageDone = true;

    if (!isSystemImage) {
      imgCount++;
    }

    // 1. Loading/priority optimization (LCP hero vs lazy content)
    if (isFirstContentImage) {
      a = a
        .replace(/\s+loading\s*=\s*["'][^"']*["']/i, '')
        .replace(/\s+fetchpriority\s*=\s*["'][^"']*["']/i, '');
      a += ' loading="eager" fetchpriority="high"';
    } else {
      if (!/loading=/i.test(a)) a += ' loading="lazy"';
      if (!/fetchpriority=/i.test(a)) a += ' fetchpriority="low"';
    }
    if (!/decoding=/i.test(a)) a += ' decoding="async"';

    // 2. Responsive srcset & sizes using Google CDN resizer + WebP
    if (!/srcset=/i.test(a)) {
      const srcset = generateResponsiveSrcset(src);
      if (srcset) {
        a += ` srcset="${srcset}"`;
        if (!/sizes=/i.test(a)) {
          a += ' sizes="(max-width: 768px) 100vw, 1020px"';
        }
      }
    }

    // 3. Accessibility & SEO alt tag auto-generation
    const altMatch = a.match(/\balt\s*=\s*["']([^"']*)["']/i);
    const hasAlt = !!altMatch;
    const altVal = hasAlt ? altMatch[1] : '';

    if (!hasAlt || altVal.trim() === '') {
      const pageTitle = ctx?.title || '블로그 이미지';
      const newAlt = `${pageTitle} 이미지 ${imgCount}`;
      if (hasAlt) {
        a = a.replace(/\balt\s*=\s*["']([^"']*)["']/i, `alt="${newAlt}"`);
      } else {
        a += ` alt="${newAlt}"`;
      }
    }

    return `<img${a}>`;
  });
}
