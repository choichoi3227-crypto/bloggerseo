/**
 * BloggerSEO v7 — 사이트맵 + RSS 생성기
 * ─────────────────────────────────────────────────────────────────────
 * Cron triggers:
 *   - 매 30분 (cron: "asterisk/30 asterisk asterisk asterisk asterisk") → RSS 생성
 *   - 매 정시 (cron: "0 asterisk asterisk asterisk asterisk")           → 사이트맵 생성 + 슬러그 감사
 *
 * 저장: Upstash Redis (saveSitemap / saveRss)
 * 제공: /sitemap.xml, /rss.xml, /atom.xml 엔드포인트
 */

import { kvScan, kvGetJson, saveSitemap, saveRss, getSitemap, getRss } from './store.js';

const BLOGGER_GHS = 'ghs.google.com';

// ── 사이트맵 생성 ────────────────────────────────────────────────────
export async function generateSitemap(env, baseUrl) {
  try {
    // 모든 슬러그 origin 키 수집
    const keys    = await kvScan(env, 'slug:origin:*', 2000);
    const entries = [];

    for (const k of keys) {
      const data = await kvGetJson(env, k);
      if (!data) continue;
      entries.push({
        loc     : baseUrl + (data.titlePath || k.replace('slug:origin:', '')),
        lastmod : data.checkedAt ? new Date(data.checkedAt).toISOString().split('T')[0] : '',
        priority: data.titlePath ? '0.8' : '0.5',
        changefreq: 'weekly',
      });
    }

    // 홈페이지 항상 포함
    entries.unshift({
      loc       : baseUrl + '/',
      lastmod   : new Date().toISOString().split('T')[0],
      priority  : '1.0',
      changefreq: 'daily',
    });

    const xml = buildSitemapXml(entries);
    await saveSitemap(env, xml);
    return { count: entries.length, xml };
  } catch (e) {
    return { count: 0, error: String(e?.message || e) };
  }
}

function buildSitemapXml(entries) {
  const items = entries.map(e => `  <url>
    <loc>${escapeXml(e.loc)}</loc>
    ${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}
    <changefreq>${e.changefreq || 'weekly'}</changefreq>
    <priority>${e.priority || '0.5'}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
          http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${items}
</urlset>`;
}

// ── RSS 생성 ──────────────────────────────────────────────────────────
export async function generateRss(env, baseUrl, siteTitle = 'BloggerSEO') {
  try {
    const keys    = await kvScan(env, 'slug:origin:*', 100);
    const entries = [];

    for (const k of keys) {
      const data = await kvGetJson(env, k);
      if (!data) continue;
      entries.push({
        title    : data.title || '',
        link     : baseUrl + (data.titlePath || ''),
        pubDate  : data.checkedAt ? new Date(data.checkedAt).toUTCString() : '',
        guid     : baseUrl + (data.titlePath || k.replace('slug:origin:', '')),
      });
    }

    // 최신순 정렬 (checkedAt 기준)
    entries.sort((a, b) => (b.pubDate > a.pubDate ? 1 : -1));

    const xml = buildRssXml(entries.slice(0, 50), baseUrl, siteTitle);
    await saveRss(env, xml);
    return { count: entries.length, xml };
  } catch (e) {
    return { count: 0, error: String(e?.message || e) };
  }
}

function buildRssXml(entries, baseUrl, siteTitle) {
  const items = entries.map(e => `    <item>
      <title>${escapeXml(e.title)}</title>
      <link>${escapeXml(e.link)}</link>
      <guid isPermaLink="true">${escapeXml(e.guid)}</guid>
      ${e.pubDate ? `<pubDate>${e.pubDate}</pubDate>` : ''}
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>${escapeXml(siteTitle)} - BloggerSEO 자동 생성 RSS</description>
    <language>ko-kr</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(baseUrl + '/rss.xml')}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

// ── 사이트맵/RSS 엔드포인트 핸들러 ─────────────────────────────────
export async function handleSitemapRequest(env, url) {
  const cached = await getSitemap(env);
  if (cached) {
    return new Response(cached, {
      headers: {
        'content-type'  : 'application/xml; charset=utf-8',
        'cache-control' : 'public, max-age=3600, stale-while-revalidate=1800',
        'x-sitemap-src' : 'cache',
      },
    });
  }
  // 캐시 미스 → 즉시 생성
  const { xml } = await generateSitemap(env, url.origin);
  return new Response(xml || emptySitemap(url.origin), {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export async function handleRssRequest(env, url) {
  const cached = await getRss(env);
  if (cached) {
    return new Response(cached, {
      headers: {
        'content-type' : 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=1800, stale-while-revalidate=900',
        'x-rss-src'    : 'cache',
      },
    });
  }
  const { xml } = await generateRss(env, url.origin);
  return new Response(xml || emptyRss(url.origin), {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
}

function emptySitemap(base) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url></urlset>`;
}
function emptyRss(base) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Blog</title><link>${base}</link><description></description></channel></rss>`;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
