/**
 * BloggerSEO v8 — 사이트맵 + RSS 생성기
 * ─────────────────────────────────────────────────────────────────────
 * v8 변경:
 *   ✅ 사이트맵/RSS: titlePath (SEO 슬러그) 없는 항목 완전 제외
 *      → 모든 URL이 항상 SEO 슬러그 기반으로 출력됨
 *   ✅ lastmod: data.updatedAt → data.checkedAt → today 순 우선
 *   ✅ RSS link도 반드시 titlePath 사용 (originPath fallback 제거)
 *   ✅ Blogger 서버 우회: Blogger Atom 피드를 직접 파싱해
 *      아직 슬러그 없는 포스트도 실시간으로 슬러그 생성 후 포함
 *
 * Cron triggers:
 *   - 매 30분 → RSS 생성
 *   - 매 정시 → 사이트맵 생성 + 슬러그 감사
 */

import { kvScan, kvGetJson, saveSitemap, saveRss, getSitemap, getRss, kvSet, kvGet } from './store.js';

const BLOGGER_GHS   = 'ghs.google.com';
const ATOM_FEED_MAX = 500; // Blogger Atom 피드 최대 항목 수

// ── 유틸: slugify (WASM 없이 기본 처리) ─────────────────────────────
function basicSlugify(str) {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/[^\w\s가-힣ぁ-龯]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ── Blogger Atom 피드 직접 파싱 (서버 우회) ─────────────────────────
// Blogger /feeds/posts/default?max-results=N&alt=json 을 직접 파싱해
// 아직 KV에 슬러그가 없는 포스트도 슬러그를 즉시 생성·저장
async function fetchBloggerAtom(baseUrl, env, maxResults = 100) {
  // baseUrl 이 개인도메인이면 → 해당 도메인 Atom 피드 직접 요청
  // blogspot.com 주소는 아래 else 분기
  const posts = [];
  try {
    // blogspot.com 대신 개인도메인으로 Atom 피드 요청
    // (Blogger는 개인도메인의 /feeds/posts/default?alt=json 도 응답함)
    let feedUrl = `${baseUrl}/feeds/posts/default?max-results=${maxResults}&alt=json`;

    const resp = await fetch(feedUrl, {
      headers: { 'accept': 'application/json', 'user-agent': 'BloggerSEO/8.0' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const entries = data?.feed?.entry || [];

    for (const entry of entries) {
      // 링크 추출 (rel=alternate → 실제 포스트 URL)
      const links     = entry.link || [];
      const altLink   = links.find(l => l.rel === 'alternate');
      const postHref  = altLink?.href || '';
      if (!postHref) continue;

      // originPath 추출 (/2024/01/post-title.html)
      let originPath;
      try {
        const u = new URL(postHref);
        originPath = u.pathname;
      } catch (_) { continue; }

      const title     = entry.title?.['$t'] || '';
      const published = entry.published?.['$t'] || '';
      const updated   = entry.updated?.['$t']   || '';

      posts.push({ originPath, title, published, updated, postHref });
    }
  } catch (_) {}
  return posts;
}

// ── 사이트맵 생성 ────────────────────────────────────────────────────
export async function generateSitemap(env, baseUrl) {
  try {
    // 1. KV에서 슬러그 목록 수집
    const keys    = await kvScan(env, 'slug:origin:*', 2000);
    const entries = [];
    const seenTitlePaths = new Set();

    for (const k of keys) {
      const data = await kvGetJson(env, k);
      if (!data) continue;
      // ✅ titlePath 없는 항목은 사이트맵에서 완전 제외
      if (!data.titlePath || data.titlePath === '/') continue;
      // 중복 titlePath 제거
      if (seenTitlePaths.has(data.titlePath)) continue;
      seenTitlePaths.add(data.titlePath);

      const lastmod = (data.updatedAt || data.checkedAt)
        ? new Date(data.updatedAt || data.checkedAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      entries.push({
        loc       : baseUrl + data.titlePath,
        lastmod,
        priority  : '0.8',
        changefreq: 'weekly',
      });
    }

    // 2. Blogger Atom 피드에서 추가 포스트 보완 (아직 슬러그 없는 것 포함)
    if (baseUrl && !baseUrl.includes('example.com')) {
      try {
        const atomPosts = await fetchBloggerAtom(baseUrl, env, 200);
        for (const post of atomPosts) {
          // 이미 슬러그 있으면 스킵
          const originKey = 'slug:origin:' + post.originPath;
          const existing  = await kvGetJson(env, originKey).catch(() => null);
          if (existing?.titlePath) continue;
          if (!post.title) continue;

          // 슬러그 즉시 생성
          const slug = basicSlugify(post.title);
          if (!slug || slug === 'post' || slug === 'untitled') continue;
          const titlePath = '/' + slug;

          if (seenTitlePaths.has(titlePath)) continue;
          seenTitlePaths.add(titlePath);

          // KV 저장 (background)
          kvSet(env, originKey, JSON.stringify({
            originPath: post.originPath, titlePath, title: post.title,
            checkedAt: Date.now(),
          }), 86400).catch(() => {});
          kvSet(env, 'slug:alias:' + titlePath, post.originPath, 86400).catch(() => {});

          const lastmod = post.updated ? new Date(post.updated).toISOString().split('T')[0]
                        : new Date().toISOString().split('T')[0];
          entries.push({ loc: baseUrl + titlePath, lastmod, priority: '0.7', changefreq: 'weekly' });
        }
      } catch (_) {}
    }

    // 홈페이지 항상 맨 앞
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
    const keys    = await kvScan(env, 'slug:origin:*', 200);
    const entries = [];
    const seenTitlePaths = new Set();

    for (const k of keys) {
      const data = await kvGetJson(env, k);
      if (!data) continue;
      // ✅ titlePath 없으면 RSS에서도 제외 (SEO 슬러그 기반만)
      if (!data.titlePath || data.titlePath === '/') continue;
      if (!data.title) continue;
      if (seenTitlePaths.has(data.titlePath)) continue;
      seenTitlePaths.add(data.titlePath);

      const pubDate = (data.updatedAt || data.checkedAt)
        ? new Date(data.updatedAt || data.checkedAt).toUTCString()
        : new Date().toUTCString();

      entries.push({
        title   : data.title,
        link    : baseUrl + data.titlePath,  // ✅ 항상 titlePath
        pubDate,
        guid    : baseUrl + data.titlePath,
        desc    : data.description || data.title,
      });
    }

    // Blogger Atom 피드에서 RSS 보완
    if (baseUrl && !baseUrl.includes('example.com')) {
      try {
        const atomPosts = await fetchBloggerAtom(baseUrl, env, 50);
        for (const post of atomPosts) {
          if (!post.title) continue;
          const slug = basicSlugify(post.title);
          if (!slug) continue;
          const titlePath = '/' + slug;
          if (seenTitlePaths.has(titlePath)) continue;
          seenTitlePaths.add(titlePath);
          const pubDate = post.updated ? new Date(post.updated).toUTCString() : new Date().toUTCString();
          entries.push({ title: post.title, link: baseUrl + titlePath, pubDate, guid: baseUrl + titlePath, desc: post.title });
        }
      } catch (_) {}
    }

    // 최신순 정렬
    entries.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

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
      <description>${escapeXml(e.desc || '')}</description>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>${escapeXml(siteTitle)} RSS Feed</description>
    <language>ko-kr</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(baseUrl + '/rss.xml')}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

// ── 사이트맵/RSS 엔드포인트 핸들러 ─────────────────────────────────
export async function handleSitemapRequest(env, url, hostOverride) {
  const base   = resolveBaseForRequest(env, url, hostOverride);
  const cached = await getSitemap(env);
  if (cached) {
    return new Response(cached, {
      headers: {
        'content-type'  : 'application/xml; charset=utf-8',
        'cache-control' : 'public, max-age=3600, stale-while-revalidate=1800',
        'x-sitemap-src' : 'cache',
        'x-sitemap-base': base,
        'x-robots-tag'  : 'noindex',  // sitemap.xml 자체는 noindex
      },
    });
  }
  const { xml } = await generateSitemap(env, base);
  return new Response(xml || emptySitemap(base), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=1800',
      'x-robots-tag': 'noindex',
    },
  });
}

export async function handleRssRequest(env, url, hostOverride) {
  const base   = resolveBaseForRequest(env, url, hostOverride);
  const cached = await getRss(env);
  if (cached) {
    return new Response(cached, {
      headers: {
        'content-type' : 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=1800, stale-while-revalidate=900',
      },
    });
  }
  const { xml } = await generateRss(env, base);
  return new Response(xml || emptyRss(base), {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=1800, stale-while-revalidate=900',
    },
  });
}

function resolveBaseForRequest(env, url, hostOverride) {
  if (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com' && env.SITE_BASE_URL !== '') {
    return env.SITE_BASE_URL.replace(/\/$/, '');
  }
  if (env.SITE_HOST && env.SITE_HOST !== '') {
    return 'https://' + env.SITE_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  if (hostOverride && hostOverride !== 'localhost'
      && !hostOverride.endsWith('.workers.dev')
      && !hostOverride.endsWith('.blogspot.com')
      && !hostOverride.endsWith('.cloudflareworkers.com')
      && hostOverride.includes('.')) {
    return 'https://' + hostOverride;
  }
  return url.origin;
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
