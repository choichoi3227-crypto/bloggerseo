/**
 * BloggerSEO v10 — 사이트맵 + RSS 생성기 (사이트별 격리)
 * ─────────────────────────────────────────────────────────────────────
 * v10 변경:
 *   ✅ [버그 수정] 이 Worker 하나가 여러 개인 도메인(Blogspot 사이트)을
 *      동시에 서빙하는데, 사이트맵/RSS 생성이 host 구분 없이 전체
 *      slug:origin:* 키를 다 긁어와 단일 sitemap:index/rss:feed 키에
 *      몰아넣고 있었다. 이제 baseUrl의 호스트를 기준으로 그 사이트의
 *      슬러그만 스캔하고, 결과도 사이트별 키(sitemap:index:{host},
 *      rss:feed:{host})에 저장해 사이트 간 완전히 독립적으로 동작한다.
 *
 * v8 변경:
 *   ✅ 사이트맵/RSS: titlePath (SEO 슬러그) 없는 항목 완전 제외
 *      → 모든 URL이 항상 SEO 슬러그 기반으로 출력됨
 *   ✅ lastmod: data.updatedAt → data.checkedAt → today 순 우선
 *   ✅ RSS link도 반드시 titlePath 사용 (originPath fallback 제거)
 *   ✅ Blogger 서버 우회: Blogger Atom 피드를 직접 파싱해
 *      아직 슬러그 없는 포스트도 실시간으로 슬러그 생성 후 포함
 *
 * Cron triggers:
 *   - 매 30분 → RSS 생성 (등록된 모든 사이트 각각)
 *   - 매 정시 → 사이트맵 생성 + 슬러그 감사 (등록된 모든 사이트 각각)
 */

import { kvScan, kvGetJson, saveSitemap, saveRss, getSitemap, getRss, kvSet, kvGet, normalizeSiteKey } from './store.js';
import { wasmCore } from './wasm-loader.js';

// baseUrl(예: https://myblog.com)에서 이 사이트를 식별하는 host 키를 뽑는다.
// slug:origin:{site}:..., sitemap:index:{site} 등 모든 사이트별 키가
// 이 함수 하나로 일관되게 계산된다.
function siteKeyFromBase(baseUrl) {
  try { return normalizeSiteKey(new URL(baseUrl).hostname); }
  catch (_) { return normalizeSiteKey(baseUrl); }
}

const BLOGGER_GHS   = 'ghs.google.com';
const ATOM_FEED_MAX = 500; // Blogger Atom 피드 최대 항목 수

// ✅ [버그 수정] 이전에는 이 파일 전용의 별도 basicSlugify()를 써서,
// 아직 방문된 적 없는 글의 슬러그를 사이트맵/RSS가 미리 만들었다.
// 문제는 실제 페이지 렌더링(worker.js)은 wasmCore.generateSlug()를 쓰는데
// 두 함수의 허용 문자셋·길이 제한이 서로 달라(예: 일본어/한자 허용 여부,
// 80자 vs 인코딩 200바이트 기준 자르기) 같은 제목에서 서로 다른 슬러그가
// 나올 수 있었다. 그러면 사이트맵에 실린 URL과, 실제 그 글을 처음 방문
// 했을 때 워커가 확정하는 canonical URL이 달라져 리디렉션 체인·중복
// 콘텐츠가 발생한다. 이제 동일한 wasmCore.generateSlug()로 통일한다.

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

// ── 사이트맵 생성 (baseUrl의 호스트에 속한 슬러그만 사용) ──────────────
export async function generateSitemap(env, baseUrl) {
  try {
    const site = siteKeyFromBase(baseUrl);

    // 1. KV에서 "이 사이트" 슬러그 목록만 수집 (host prefix로 격리)
    const keys    = await kvScan(env, 'slug:origin:' + site + ':*', 2000);
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
          const originKey = 'slug:origin:' + site + ':' + post.originPath;
          const existing  = await kvGetJson(env, originKey).catch(() => null);
          if (existing?.titlePath) continue;
          if (!post.title) continue;

          // 슬러그 즉시 생성 (worker.js와 동일한 생성기 사용)
          const slug = await wasmCore.generateSlug(post.title);
          if (!slug || slug === 'post' || slug === 'untitled') continue;
          const titlePath = '/' + slug;

          if (seenTitlePaths.has(titlePath)) continue;
          seenTitlePaths.add(titlePath);

          // KV 저장 (background) — 반드시 이 사이트(site) 네임스페이스 안에 저장
          kvSet(env, originKey, JSON.stringify({
            originPath: post.originPath, titlePath, title: post.title,
            checkedAt: Date.now(),
          }), 86400).catch(() => {});
          kvSet(env, 'slug:alias:' + site + ':' + titlePath, post.originPath, 86400).catch(() => {});

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
    await saveSitemap(env, xml, site);
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
    const site = siteKeyFromBase(baseUrl);
    const keys = await kvScan(env, 'slug:origin:' + site + ':*', 200);
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
          const slug = await wasmCore.generateSlug(post.title);
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
    await saveRss(env, xml, site);
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

// ── 사이트맵/RSS 엔드포인트 핸들러 (요청 host 기준으로 사이트별 격리) ──
// [버그 수정] getSitemap(env)/getRss(env)를 인자 없이 호출하면 어떤
// 사이트가 요청했든 동일한 전역 캐시를 반환했다. 이제 실제 요청 host
// (hostOverride)로 계산한 base의 사이트 키를 넘겨 그 사이트 전용 캐시만
// 조회·저장한다.
export async function handleSitemapRequest(env, url, hostOverride) {
  const base   = resolveBaseForRequest(env, url, hostOverride);
  const site   = siteKeyFromBase(base);
  const cached = await getSitemap(env, site);
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
  const site   = siteKeyFromBase(base);
  const cached = await getRss(env, site);
  if (cached) {
    return new Response(cached, {
      headers: {
        'content-type' : 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=1800, stale-while-revalidate=900',
      },
    });
  }
  // 사이트별로 저장된 제목이 있으면 사용 (없으면 generateRss 기본값 'BloggerSEO')
  let siteTitle;
  try { siteTitle = await kvGet(env, 'state:site_title:' + site); } catch (_) { siteTitle = null; }
  const { xml } = await generateRss(env, base, siteTitle || undefined);
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
