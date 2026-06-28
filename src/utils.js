/**
 * BloggerSEO v7 — 공용 유틸리티
 */

// ── FNV-1a 32bit ────────────────────────────────────────────────────
export function fnv1a32Hex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= str.length; h = Math.imul(h, 0x01000193);
  return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

// ── HTML 파싱 유틸 ───────────────────────────────────────────────────
export function extractMeta(html, name) {
  const r = escapeRe(name);
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${r}["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+name=["']${r}["'][^>]+content=["']([^"']+)["']`,    'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`,    'i')) || []
  )[1] || '';
}

export function extractTagContent(html, re) {
  return (html.match(re) || ['', ''])[1].trim();
}

export function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function buildMetaDescription(bodyText, title) {
  let t = title ? bodyText.replace(title, '').trim() : bodyText;
  if (t.length > 160) {
    t = t.slice(0, 160);
    const l = t.lastIndexOf(' ');
    if (l > 100) t = t.slice(0, l);
    t += '…';
  }
  return t;
}

export function extractFirstImage(html) {
  return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || '';
}

export function extractSiteName(html) {
  return extractMeta(html, 'og:site_name') ||
    extractTagContent(html, /<title[^>]*>([^<|]+)/i) || '';
}

export function extractLogoUrl(html) {
  return (
    html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) || []
  )[1] || '';
}

export function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const l = m[1].trim();
    if (l && !labels.includes(l)) labels.push(l);
  }
  return labels;
}

export function extractJsonLdDate(html, key) {
  return (html.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || '';
}

export function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 안전 변환 래퍼 ───────────────────────────────────────────────────
export function safeTransform(html, fn) {
  try {
    const out = fn(html);
    return (typeof out === 'string' && out.length > 0) ? out : html;
  } catch (_) { return html; }
}

// ── 지연 유틸 ────────────────────────────────────────────────────────
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 재시도 유틸 ──────────────────────────────────────────────────────
export async function retryAsync(fn, maxRetries = 2, baseDelayMs = 60) {
  let lastErr, lastResp;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fn();
      if (resp && ![502, 503, 504].includes(resp.status)) return resp;
      lastResp = resp;
      if (attempt === maxRetries) return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) throw e;
    }
    await sleep(baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs);
  }
  if (lastResp) return lastResp;
  throw lastErr;
}
