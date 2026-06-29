/**
 * BloggerSEO SEO worker engine
 * ─────────────────────────────────────────────────────────────────────
 * A deterministic control loop that keeps Blogger output closer to a
 * WordPress-style SEO surface: canonical title slugs, clean feeds, fresh
 * search-engine pings, and route-aware public URLs. All operations are
 * best-effort and safe for Cloudflare Workers cron/background execution.
 */

import { kvScan, kvGetJson } from './store.js';
import { generateSitemap, generateRss } from './sitemap.js';

export { isTitleSlugPath, normalizePublicBase, buildSeoWorkPlan } from './seo-utils.js';
import { normalizePublicBase, buildSeoWorkPlan } from './seo-utils.js';

export async function collectSlugRecords(env, limit = 2000) {
  const keys = await kvScan(env, 'slug:origin:*', limit);
  const out = [];
  for (const key of keys) {
    const data = await kvGetJson(env, key);
    if (!data) continue;
    out.push({ ...data, originPath: key.replace(/^slug:origin:/, '') });
  }
  return out;
}

export async function runSeoWorkerTick(env, options = {}) {
  const startedAt = Date.now();
  const baseUrl = normalizePublicBase(options.baseUrl || env?.SITE_BASE_URL || env?.SITE_HOST || '');
  const records = options.records || await collectSlugRecords(env, options.limit || 2000);
  const plan = buildSeoWorkPlan(records, baseUrl);

  const result = {
    ok: plan.ok,
    startedAt,
    finishedAt: 0,
    durationMs: 0,
    canonicalCount: plan.canonical.length,
    skippedCount: plan.skipped.length,
    warnings: plan.warnings,
    generated: { sitemap: false, rss: false },
  };

  if (plan.ok) {
    await generateSitemap(env, plan.baseUrl).then(() => { result.generated.sitemap = true; }).catch(e => {
      result.warnings.push(`sitemap:${e?.message || e}`);
    });
    await generateRss(env, plan.baseUrl, options.siteTitle || env?.SITE_TITLE || 'BloggerSEO').then(() => {
      result.generated.rss = true;
    }).catch(e => {
      result.warnings.push(`rss:${e?.message || e}`);
    });
  }

  result.finishedAt = Date.now();
  result.durationMs = result.finishedAt - startedAt;
  return result;
}
