/** Pure SEO utilities shared by Worker runtime and Node tests. */
const ORIGIN_POST_RE = /^\/\d{4}\/\d{2}\/[^/]+\.html$/;
const INTERNAL_HOST_RE = /(?:blogspot\.|workers\.dev|cloudflareworkers\.com|ghs\.google\.com)/i;

export function isTitleSlugPath(path) {
  return typeof path === 'string'
    && /^\/[\p{L}\p{N}][\p{L}\p{N}._~-]*(?:-[\p{L}\p{N}._~-]+)*$/u.test(path)
    && !ORIGIN_POST_RE.test(path)
    && !path.startsWith('/p/')
    && !path.startsWith('/search')
    && !path.includes('//');
}

export function normalizePublicBase(base) {
  if (!base) return '';
  try {
    const u = new URL(String(base).startsWith('http') ? String(base) : `https://${base}`);
    if (INTERNAL_HOST_RE.test(u.hostname)) return '';
    u.protocol = 'https:';
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

export function buildSeoWorkPlan(records, baseUrl) {
  const base = normalizePublicBase(baseUrl);
  const plan = {
    ok: !!base,
    baseUrl: base,
    canonical: [],
    skipped: [],
    warnings: [],
  };
  if (!base) plan.warnings.push('public-base-missing-or-internal');

  for (const rec of records || []) {
    const originPath = rec?.originPath || rec?.origin || '';
    const titlePath = rec?.titlePath || '';
    if (!originPath || !ORIGIN_POST_RE.test(originPath)) {
      plan.skipped.push({ originPath, reason: 'not-blogger-origin-post' });
      continue;
    }
    if (!isTitleSlugPath(titlePath)) {
      plan.skipped.push({ originPath, titlePath, reason: 'missing-or-invalid-title-slug' });
      continue;
    }
    plan.canonical.push({
      originPath,
      titlePath,
      canonicalUrl: base ? base + titlePath : titlePath,
      title: rec.title || '',
      checkedAt: rec.checkedAt || 0,
    });
  }
  return plan;
}
