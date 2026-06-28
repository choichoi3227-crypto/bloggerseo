/**
 * BloggerSEO Worker v7
 * ─────────────────────────────────────────────────────────────────────
 * 신규/변경 기능:
 *   1. 자동 스키마 마크업 (필수: Article/FAQ, 선택: Breadcrumb/Product) + AI FAQ 추출
 *   2. 자체 Argo Smart Routing (지역별 레이턴시 기반 최적 경로)
 *   3. 자체 Regional Tiered Cache (KR→JP→US→EU 계층)
 *   4. 모바일·데스크탑 환경 최적화 (Priority Routing 연동)
 *   5. 자체 Priority Routing (봇/모바일/데스크탑 티어)
 *   6. 구글·네이버·빙 상위노출 극대화
 *   7. 자체 실시간 상태 저장 엔진 (DO Redis 1순위, KV/Upstash 백업, D1 미사용)
 *   8. 자체 Cache Reserve (4시간 TTL, SWR 지원)
 *   9. 100% 자체 제작 서버리스 Redis (Durable Objects, 64-way 샤딩 → 사실상 무제한 확장)
 *  10. Cron: 사이트맵(1h) + RSS(30m)
 *  11. 자체 로드밸런서 (inFlight 기반, Retry-After)
 *  12. 관리 패널 (/panel) — Redis 클러스터 관리 탭 포함
 */

import { wasmCore }           from './src/wasm-loader.js';
import {
  cnameGet, cnameSet,
  checkRateLimit, recordMetric, getMetrics,
  slugOriginGet, slugAliasGet, upsertSlug, purgeAllSlugs,
  isIpBlocked, blockIp, unblockIp, listBlockedIps,
  recordAnalytics, getAnalytics,
  doRedisAvailable, doRedisClusterStats, doRedisFlushAll,
} from './src/store.js';
import {
  cacheReserveGet, cacheReservePut, cacheReserveGetStaleFallback,
  cacheReservePurge, cacheReserveStats,
  cacheReserveInvalidate, isCacheable,
} from './src/cache-reserve.js';
import {
  argoSelectRoute, argoRecordLatency, argoBuildFetchOptions,
  regionalCacheRecord, regionalCacheStats,
  priorityRoute, buildDeviceHints, buildCacheControl,
  lbAcquire, lbRelease, lbLoad, lbWorkerId, lbHeartbeat, lbClusterLoad,
  getPageTypeTtl,
} from './src/routing.js';
import { buildSchemas, injectSchemaMarkup, injectSearchEngineTags } from './src/schema.js';
import { handleSitemapRequest, handleRssRequest, generateSitemap, generateRss } from './src/sitemap.js';
import {
  fnv1a32Hex, extractMeta, extractTagContent, extractBodyText,
  buildMetaDescription, extractFirstImage, extractSiteName, extractLogoUrl,
  extractLabels, extractJsonLdDate, escapeAttr, escapeRe, safeTransform, retryAsync,
} from './src/utils.js';

// wrangler.toml의 durable_objects.bindings가 이 클래스를 찾으려면
// main 파일(worker.js)에서 named export로 노출되어 있어야 한다.
// 클래스 이름은 Cloudflare 대시보드에서 먼저 만든 네임스페이스(class_name)와 맞춰
// MyDurableObject로 되어 있다 — 역할은 자체 제작 Redis 샤드(구 RedisShard)와 동일.
export { MyDurableObject } from './src/redis-do.js';

// 신규 모듈 import
import { applyAllSeoFeatures, pingIndexNow, pingSearchEngines,
         buildServerTimingHeader, buildSecurityHeaders, buildImageSitemapXml } from './src/seo-features.js';
import { Cluster, Deployment, Service, Namespace, EventBus } from './src/k8s.js';
import { ContainerLifecycle, ContainerRegistry, ImageBuilder, createVolume } from './src/container.js';

const GHS_TARGET = 'ghs.google.com';
const DOH_URL    = 'https://1.1.1.1/dns-query';

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  // ── HTTP 요청 핸들러 ──────────────────────────────────────────────
  async fetch(request, env, ctx) {
    ctx.waitUntil(wasmCore.warmup().catch(() => {}));
    // 로드밸런서 heartbeat (비동기)
    ctx.waitUntil(lbHeartbeat(env).catch(() => {}));
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return errResp(502, 'Worker exception: ' + String(e?.message ?? e));
    }
  },

  // ── 스케줄드 (Cron) ────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    // */30 * * * *  → RSS 생성
    // 0 * * * *     → 사이트맵 + 슬러그 감사 + 캐시 만료 정리
    if (cron.startsWith('*/30')) {
      ctx.waitUntil(runRssGeneration(env).catch(() => {}));
    } else {
      ctx.waitUntil(Promise.all([
        runSitemapGeneration(env).catch(() => {}),
        runSlugAudit(env).catch(() => {}),
        cacheReservePurge(env).catch(() => {}),
      ]));
    }
  },
};

// ─────────────────────────────────────────────
// 핵심 fetch 핸들러
// ─────────────────────────────────────────────
async function handleFetch(request, env, ctx) {
  const url    = new URL(request.url);
  const host   = url.hostname;
  const path   = url.pathname;
  const t0     = Date.now();

  // ── IP 차단 체크 ──────────────────────────────────────────────────
  const clientIp = request.headers.get('cf-connecting-ip') ||
                   request.headers.get('x-forwarded-for') || '';
  if (clientIp && await isIpBlocked(env, clientIp)) {
    recordMetric(403, Date.now() - t0);
    return errResp(403, 'Forbidden');
  }

  // ── 관리 패널 ────────────────────────────────────────────────────
  if (path === '/panel' || path.startsWith('/panel/')) {
    return handlePanel(request, url, env, ctx);
  }

  // ── 디버그/관리 API ──────────────────────────────────────────────
  if (path === '/__debug')       return debugInfo(url, env);
  if (path === '/__metrics')     return new Response(JSON.stringify(getMetrics(), null, 2), jsonHeaders());
  if (path === '/__purge_all')   return purgeAll(env);
  if (path === '/__lb_status')   return lbStatus(env);
  if (path === '/__cache_stats') return cacheStats(env);

  // ── 사이트맵 / RSS 직접 서빙 (실제 요청 host=개인도메인 사용) ───
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path)) return handleSitemapRequest(env, url, host);
  if (path === '/rss.xml' || path === '/atom.xml') return handleRssRequest(env, url, host);

  // ── Priority Routing (티어 결정) ─────────────────────────────────
  const pRoute  = priorityRoute(request);
  const isBot   = pRoute.tier === 1;

  // ── Argo Smart Routing (지역 선택) ──────────────────────────────
  const argoCtx = argoSelectRoute(request);

  // ── CNAME 워밍 ──────────────────────────────────────────────────
  ctx.waitUntil(warmCname(host).catch(() => {}));

  // ── Rate Limit (봇은 제외) ───────────────────────────────────────
  if (!isBot) {
    const rlLimit = Number(env.RATE_LIMIT_PER_MIN) || 600;
    const rl      = checkRateLimit(host, rlLimit);
    if (!rl.allowed) {
      recordMetric(429, Date.now() - t0);
      return errResp(429, 'Too Many Requests');
    }
  }

  // ── 정적 자산 / Passthrough ──────────────────────────────────────
  if (isPassthrough(path, url)) {
    const resp = await proxyPass(url, request);
    recordMetric(resp.status, Date.now() - t0);
    return resp;
  }

  // ── 캐시 우회 조건 ───────────────────────────────────────────────
  if (shouldBypassCache(request, url, path)) {
    const resp = await proxyPass(url, request);
    recordMetric(resp.status, Date.now() - t0);
    return resp;
  }

  // ── Cache Reserve 조회 (L0 Cache API → L2 영속 스토리지) ──────────
  // 쿠키 유무와 무관하게 캐시를 적용한다 (v7.1: 캐시 히트율 극대화).
  if (isCacheable(request, null)) {
    const cached = await cacheReserveGet(env, request);
    if (cached) {
      ctx.waitUntil(regionalCacheRecord(env, argoCtx.region, true).catch(() => {}));
      recordMetric(200, Date.now() - t0);
      if (!isBot) {
        ctx.waitUntil(recordAnalytics(env, {
          type: 'cache_hit', path, region: argoCtx.region, label: pRoute.label, tier: cached.tier,
        }).catch(() => {}));
      }
      // L2에서 히트했다면 L0(엣지 캐시)도 채워서, 같은 노드의 다음 요청은
      // L2 호출 없이 즉시 응답되게 한다 (응답 지연 없이 백그라운드 처리).
      if (cached.warmL0) ctx.waitUntil(cached.warmL0().catch(() => {}));
      // SWR: 백그라운드 재검증 (만료 윈도우 진입 시)
      if (cached.isSwr) {
        ctx.waitUntil(backgroundRevalidate(request, env, url, argoCtx, pRoute).catch(() => {}));
      }
      return cached.response;
    }
    ctx.waitUntil(regionalCacheRecord(env, argoCtx.region, false).catch(() => {}));
  }

  // ── 슬러그 라우팅 ────────────────────────────────────────────────
  let slugRoute = { type: 'passthrough' };
  let originPathForKV = path;
  try {
    slugRoute = await resolveSlugRoute(path, env);
    if (slugRoute.type === 'redirect') {
      return Response.redirect(new URL(slugRoute.titlePath, url).toString(), 301);
    }
    if (slugRoute.type === 'alias') {
      originPathForKV = slugRoute.originPath;
    }
  } catch (_) {}

  // ── Load Balancer ────────────────────────────────────────────────
  if (!lbAcquire()) {
    recordMetric(503, Date.now() - t0);
    return new Response('Service busy — please retry', {
      status : 503,
      headers: { 'Retry-After': '2', 'cache-control': 'no-store' },
    });
  }

  // ── Origin Fetch (Argo 경로 사용) ───────────────────────────────
  let fetchUrl = new URL(url.toString());
  if (slugRoute.type === 'alias') fetchUrl.pathname = slugRoute.originPath;

  let originResp;
  const fetchT0 = Date.now();
  try {
    originResp = await retryAsync(() => bloggerFetch(fetchUrl, request.headers, argoCtx));
  } catch (e) {
    lbRelease();
    // ── 장애 격리: Origin(Blogger) 자체가 응답을 못 줄 때, 만료된 캐시라도
    // 있으면 그걸 서빙해서 사이트를 살린다. 캐시도 없으면 502를 반환한다.
    if (isCacheable(request, null)) {
      const stale = await cacheReserveGetStaleFallback(env, request).catch(() => null);
      if (stale) {
        recordMetric(200, Date.now() - t0);
        return stale;
      }
    }
    recordMetric(502, Date.now() - t0);
    return errResp(502, 'Fetch failed: ' + String(e?.message ?? e));
  }
  lbRelease();
  argoRecordLatency(argoCtx.region, Date.now() - fetchT0);

  // 3xx 그대로
  if (originResp.status >= 300 && originResp.status < 400) {
    recordMetric(originResp.status, Date.now() - t0);
    return stripInternalHeaders(originResp);
  }
  if (originResp.status >= 500) {
    // ── 장애 격리: Origin이 5xx를 반환해도 stale 캐시가 있으면 그걸 서빙
    if (isCacheable(request, null)) {
      const stale = await cacheReserveGetStaleFallback(env, request).catch(() => null);
      if (stale) {
        recordMetric(200, Date.now() - t0);
        return stale;
      }
    }
    recordMetric(originResp.status, Date.now() - t0);
    return errResp(originResp.status, 'Origin error ' + originResp.status);
  }
  if (!isHtml(originResp) || !originResp.ok) {
    recordMetric(originResp.status, Date.now() - t0);
    return stripInternalHeaders(originResp);
  }

  // ── HTML 변환 파이프라인 ────────────────────────────────────────
  let html;
  try { html = await originResp.text(); }
  catch (e) { return errResp(502, 'Body read failed'); }

  let pageCtx = null;
  let result  = html;
  try {
    pageCtx = await extractPageContext(html, url);
    result  = await transformHtml(html, pageCtx, url, env, pRoute);
    if (!result || typeof result !== 'string') result = html;
  } catch (_) { result = html; pageCtx = null; }

  // ── ETag / 304 ───────────────────────────────────────────────────
  // 구글봇 등 크롤러도 ETag/If-None-Match 조건부 요청을 지원한다.
  // (Google 공식: 크롤링 인프라가 ETag/Last-Modified 캐싱을 지원하며,
  //  이를 활용하면 크롤링 효율이 올라간다 — SEO 랭킹 직접 요인은 아니지만
  //  크롤 예산을 아껴주는 효과가 있어 손해는 없고 이득만 있다.)
  let etag = '';
  try {
    etag = `"${fnv1a32Hex(result)}"`;
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      recordMetric(304, Date.now() - t0);
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
    }
  } catch (_) { etag = ''; }

  // ── 비동기 후처리 ───────────────────────────────────────────────
  if (pageCtx) {
    ctx.waitUntil(updateSlugKV(pageCtx, originPathForKV, env).catch(() => {}));
  }

  // Cache Reserve 저장 (성공 응답만, 봇 트래픽으로 캐시를 오염시키지 않기
  // 위해 쓰기는 사람 방문자 기준으로만 — 단, 읽기는 모두에게 적용됨)
  if (!isBot && pageCtx) {
    const respForCache = new Response(result, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    ctx.waitUntil(
      cacheReservePut(env, request, respForCache, { region: argoCtx.region }).catch(() => {})
    );
  }

  ctx.waitUntil(recordAnalytics(env, {
    type: 'page_view', path, region: argoCtx.region, label: pRoute.label,
    latencyMs: Date.now() - t0,
  }).catch(() => {}));

  recordMetric(200, Date.now() - t0);
  // 페이지 타입별 TTL 적용 (포스트 1h, 페이지 4h, 홈 30분, 라벨 1h)
  const pageType     = pageCtx?.type || detectPageType(url);
  const pageTtl      = getPageTypeTtl(pageType);
  const effectiveRoute = { ...pRoute, maxAge: pageTtl };
  const cacheControl = buildCacheControl(effectiveRoute, isBot);
  return new Response(result, { status: 200, headers: buildResponseHeaders(etag, cacheControl) });
}

// ── 백그라운드 재검증 (SWR) ─────────────────────────────────────────
async function backgroundRevalidate(request, env, url, argoCtx, pRoute) {
  try {
    const freshResp = await retryAsync(() => bloggerFetch(url, request.headers, argoCtx), 1);
    if (!freshResp.ok || !isHtml(freshResp)) return;
    const html    = await freshResp.text();
    const pageCtx = await extractPageContext(html, url);
    const result  = await transformHtml(html, pageCtx, url, env, pRoute);
    const respForCache = new Response(result, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    await cacheReservePut(env, request, respForCache, { region: argoCtx.region });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인 (SEO 주입 포함)
// ─────────────────────────────────────────────
async function transformHtml(html, ctx, url, env, pRoute) {
  let o = html;
  o = safeTransform(o, stripMobileParam);
  o = safeTransform(o, enforceHttps);
  o = safeTransform(o, h => injectMetaDescription(h, ctx));
  o = safeTransform(o, h => injectCanonical(h, ctx, url));
  o = safeTransform(o, h => injectSeoTags(h, ctx));
  o = safeTransform(o, h => injectSearchEngineTags(h, ctx, env));
  o = safeTransform(o, injectPerformanceOptimizations);
  o = safeTransform(o, h => injectDeviceOptimizations(h, pRoute));

  // ── 추가 SEO 기능 20+ (목차/읽기시간 제외) ──────────────────────
  try {
    o = safeTransform(o, h => applyAllSeoFeatures(h, ctx, url, env));
  } catch (_) {}

  // 스키마 마크업 (비동기, AI FAQ 포함)
  try {
    const schemas = await buildSchemas(o, ctx, url, env);
    o = injectSchemaMarkup(o, schemas);
  } catch (_) {}

  return o;
}

// ─────────────────────────────────────────────
// 슬러그 라우팅
// ─────────────────────────────────────────────
function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

function isReservedFlatPath(p) {
  if (p === '/' || p === '') return true;
  if (p.startsWith('/feeds/') || p.startsWith('/b/') || p.startsWith('/admin')) return true;
  // /search, /search/label/* 등 Blogger 네이티브 경로 — 슬러그 라우팅에서 제외해 리디렉션 루프 차단
  if (p.startsWith('/search') || p === '/ncr') return true;
  // 다중 세그먼트 경로(예: /search/label/여행)는 isReservedFlatPath 외에
  // resolveSlugRoute의 /^\/[^/]+$/ 체크에도 걸리지 않으므로 이중 안전장치
  if (p.startsWith('/p/')) return true;
  if (p === '/__debug' || p === '/__metrics' || p === '/__purge_all' ||
      p === '/__lb_status' || p === '/__cache_stats') return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(p)) return true;
  if (p === '/atom.xml' || p === '/rss.xml') return true;
  if (p === '/panel' || p.startsWith('/panel/')) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json|html?)$/i.test(p)) return true;
  return false;
}

// [v6.4 수정] URL.pathname은 한글 등 비ASCII 문자를 항상 퍼센트 인코딩된
// 형태(%EC%A0%9C...)로 반환한다. 반면 슬러그 저장(upsertSlug)은 디코딩된
// 한글 그대로("/제주도-여행-코스")를 키로 사용한다. 이 불일치 때문에
// 슬러그가 KV/Redis에 정상 저장되어도 라우팅 조회에서 항상 찾지 못해
// 404로 떨어지는 문제가 있었다. 조회 전에 반드시 디코딩해서 키를 맞춘다.
function decodePathSafe(path) {
  try { return decodeURIComponent(path); }
  catch (_) { return path; } // 잘못된 인코딩이면 원본 그대로 (안전장치)
}

async function resolveSlugRoute(rawPath, env) {
  const path = decodePathSafe(rawPath);

  // 다중 세그먼트(예: /search/label/여행, /p/about 등) — 슬러그 라우팅 완전 제외
  // 이걸 빠뜨리면 /search/label/* 가 여기서 잡혀 리디렉션→다시 resolveSlug→무한루프
  if (path.indexOf('/', 1) !== -1) {
    // /YYYY/MM/post.html 형태는 포스트 경로로 허용
    if (!isPostPath(path)) return { type: 'passthrough' };
  }

  if (isPostPath(path)) {
    const rec = await slugOriginGet(env, path);
    if (rec?.titlePath && rec.titlePath !== path) {
      return { type: 'redirect', titlePath: rec.titlePath };
    }
    return { type: 'passthrough' };
  }
  if (/^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    const originPath = await slugAliasGet(env, path);
    if (originPath && originPath !== path) {
      return { type: 'alias', originPath };
    }
  }
  return { type: 'passthrough' };
}

async function updateSlugKV(pageCtx, originPath, env) {
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;
  if (!isPostPath(originPath)) return;
  const titleSlug = await wasmCore.generateSlug(pageCtx.title);
  if (!titleSlug || titleSlug === 'post' || titleSlug === 'untitled') return;
  await upsertSlug(env, originPath, pageCtx.title, titleSlug);
}

// ─────────────────────────────────────────────
// Cron 작업
// ─────────────────────────────────────────────
async function runSitemapGeneration(env) {
  // 실제 개인도메인 우선 사용 — SITE_BASE_URL 미설정 시 example.com 대신
  // SITE_HOST 또는 PRIMARY_HOST 환경변수로도 지정 가능
  const base = resolveSiteBase(env);
  await generateSitemap(env, base);
}

async function runRssGeneration(env) {
  const base  = resolveSiteBase(env);
  const title = env.SITE_TITLE || 'BloggerSEO';
  await generateRss(env, base, title);
}

// 사이트 베이스 URL 결정 (우선순위: SITE_BASE_URL > SITE_HOST > 빈 문자열로 상대경로)
// Cron 작업에서는 요청 객체가 없으므로 환경변수에서만 가져온다.
// 실제 요청 처리 시에는 url.origin을 직접 사용하므로 Cron에서만 이 함수가 의미 있다.
function resolveSiteBase(env) {
  if (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com') {
    return env.SITE_BASE_URL.replace(/\/$/, '');
  }
  if (env.SITE_HOST) {
    const host = env.SITE_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return 'https://' + host;
  }
  // 폴백: 빈 base (사이트맵 loc이 상대경로가 됨 — 개인도메인 설정 미흡 시 경고)
  return '';
}

async function runSlugAudit(env) {
  const { kvScan, kvGetJson } = await import('./src/store.js');
  const keys = await kvScan(env, 'slug:origin:*', 1000);
  for (const key of keys) {
    try {
      const data = await kvGetJson(env, key);
      if (!data?.title) continue;
      const newSlug = await wasmCore.generateSlug(data.title);
      if (!newSlug || newSlug === 'post') continue;
      const newTitlePath  = '/' + newSlug;
      const originPath    = key.replace(/^slug:origin:/, '');
      if (newTitlePath !== data.titlePath) {
        await upsertSlug(env, originPath, data.title, newSlug);
      }
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// CNAME 검증
// ─────────────────────────────────────────────
async function warmCname(host) {
  const cached = cnameGet(host);
  if (cached !== null) return cached;
  const ok = await checkCnameGhs(host).catch(() => false);
  cnameSet(host, ok);
  return ok;
}

async function checkCnameGhs(host) {
  let current = host;
  const seen  = new Set();
  for (let i = 0; i < 10; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    let cname;
    try { cname = await dnsCname(current); } catch (_) { break; }
    if (!cname) break;
    const n = cname.replace(/\.$/, '').toLowerCase();
    if (n === GHS_TARGET) return true;
    current = n;
  }
  return false;
}

async function dnsCname(host) {
  const resp = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`, {
    headers: { accept: 'application/dns-json' },
    cf     : { cacheTtl: 300, cacheEverything: true },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const rec  = (data?.Answer || []).find(r => r.type === 5);
  return rec ? String(rec.data) : null;
}

// ─────────────────────────────────────────────
// Origin Fetch (Argo 경로 통합)
// ─────────────────────────────────────────────
async function bloggerFetch(url, reqHeaders, argoCtx) {
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs        = params.toString() ? '?' + params.toString() : '';
  const targetUrl = url.origin + url.pathname + qs;

  const headers = new Headers();
  for (const [k, v] of reqHeaders.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'host' || kl.startsWith('cf-') || kl === 'x-forwarded-for' || kl === 'x-real-ip') continue;
    headers.set(k, v);
  }
  headers.set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  // Argo 라우팅 힌트 헤더
  if (argoCtx?.region) headers.set('x-argo-region', argoCtx.region);

  const cfOpts = argoCtx ? argoBuildFetchOptions(argoCtx).cf : { resolveOverride: GHS_TARGET, http3: true };

  return fetch(targetUrl, {
    method  : 'GET',
    headers,
    redirect: 'manual',
    cf      : { ...cfOpts, cacheTtl: 0, cacheEverything: false },
  });
}

async function proxyPass(url, request) {
  try {
    const resp = await retryAsync(() => bloggerFetch(url, request.headers, null), 1);
    return stripInternalHeaders(resp, isPassthrough(url.pathname, url));
  } catch (e) {
    return errResp(502, 'Proxy failed: ' + String(e?.message ?? e));
  }
}

// ─────────────────────────────────────────────
// 관리 패널
// ─────────────────────────────────────────────
async function handlePanel(request, url, env, ctx) {
  // 인증 체크
  const auth   = request.headers.get('x-panel-secret') || url.searchParams.get('secret') || '';
  const secret = env.PANEL_SECRET || 'change-me-in-dashboard';
  if (auth !== secret) {
    return new Response(panelLoginHtml(), {
      status : 401,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const subPath = url.pathname.replace(/^\/panel\/?/, '') || 'dashboard';

  // API 엔드포인트
  if (subPath === 'api/metrics')         return new Response(JSON.stringify(getMetrics()), jsonHeaders());
  if (subPath === 'api/cache_stats')     return new Response(JSON.stringify(await cacheReserveStats(env)), jsonHeaders());
  if (subPath === 'api/lb_status')       return new Response(JSON.stringify(await lbClusterLoad(env)), jsonHeaders());
  if (subPath === 'api/regional_cache')  return new Response(JSON.stringify(await regionalCacheStats(env)), jsonHeaders());
  if (subPath === 'api/analytics')       return new Response(JSON.stringify(await getAnalytics(env, 200)), jsonHeaders());
  if (subPath === 'api/blocked_ips')     return new Response(JSON.stringify(await listBlockedIps(env)), jsonHeaders());
  if (subPath === 'api/redis_stats')     return new Response(JSON.stringify(await doRedisClusterStats(env)), jsonHeaders());
  if (subPath === 'api/redis_flush' && request.method === 'POST') {
    const result = await doRedisFlushAll(env);
    return new Response(JSON.stringify(result), jsonHeaders());
  }
  if (subPath === 'api/purge_cache')     {
    const result = await cacheReservePurge(env);
    return new Response(JSON.stringify(result), jsonHeaders());
  }
  if (subPath.startsWith('api/block_ip/')) {
    const ip = subPath.replace('api/block_ip/', '');
    await blockIp(env, ip, 86400);
    return new Response(JSON.stringify({ blocked: ip }), jsonHeaders());
  }
  if (subPath.startsWith('api/unblock_ip/')) {
    const ip = subPath.replace('api/unblock_ip/', '');
    await unblockIp(env, ip);
    return new Response(JSON.stringify({ unblocked: ip }), jsonHeaders());
  }
  if (subPath === 'api/generate_sitemap') {
    // 패널 요청 시 실제 블로그 도메인 사용 (SITE_BASE_URL 환경변수 또는 Referer 기반)
    const base   = (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com')
                    ? env.SITE_BASE_URL.replace(/\/$/, '')
                    : (env.SITE_HOST ? 'https://' + env.SITE_HOST : url.origin.replace('/panel', ''));
    const result = await generateSitemap(env, base);
    return new Response(JSON.stringify({ count: result.count, base }), jsonHeaders());
  }
  if (subPath === 'api/generate_rss') {
    const base   = (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com')
                    ? env.SITE_BASE_URL.replace(/\/$/, '')
                    : (env.SITE_HOST ? 'https://' + env.SITE_HOST : url.origin.replace('/panel', ''));
    const result = await generateRss(env, base, env.SITE_TITLE || 'Blog');
    return new Response(JSON.stringify({ count: result.count, base }), jsonHeaders());
  }

  // 관리 패널 HTML
  return new Response(panelHtml(secret), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ─────────────────────────────────────────────
// 유틸 핸들러
// ─────────────────────────────────────────────
async function debugInfo(url, env) {
  const host = url.hostname;
  const cnameOk = cnameGet(host);
  const info = {
    host, version: 'v7',
    workerId   : lbWorkerId(),
    load       : lbLoad(),
    cnameOk,
    features   : ['argo-routing','tiered-cache','priority-routing','cache-reserve-4h',
                  'schema-markup','faq-ai','sitemap-cron','rss-cron','load-balancer','panel',
                  'redis-do' + (doRedisAvailable(env) ? ':active' : ':unavailable')],
  };
  return new Response(JSON.stringify(info, null, 2), { status: 200, ...jsonHeaders() });
}

async function lbStatus(env) {
  const status = await lbClusterLoad(env);
  return new Response(JSON.stringify({ ...status, currentWorker: { id: lbWorkerId(), load: lbLoad() } }, null, 2), jsonHeaders());
}

async function cacheStats(env) {
  const stats = await cacheReserveStats(env);
  return new Response(JSON.stringify(stats, null, 2), jsonHeaders());
}

async function purgeAll(env) {
  const [slugs, cache] = await Promise.all([
    purgeAllSlugs(env),
    cacheReservePurge(env),
  ]);
  return new Response(JSON.stringify({ slugs, cache }), jsonHeaders());
}

// ─────────────────────────────────────────────
// HTML 변환 함수들
// ─────────────────────────────────────────────
function stripMobileParam(html) {
  return html
    .replace(/((?:href|src|action)=["'][^"']*)\\?m=\\d+&/gi, '$1?')
    .replace(/((?:href|src|action)=["'][^"']*)&m=\\d+/gi, '$1')
    .replace(/((?:href|src|action)=["'][^"']*)\\?m=\\d+/gi, '$1');
}

function enforceHttps(html) {
  return html.replace(/((?:src|href)=["'])http:\/\//gi, '$1https://');
}

function injectPerformanceOptimizations(html) {
  if (html.includes('rel="dns-prefetch"')) return html;
  const tags = [
    '<link rel="dns-prefetch" href="//www.blogger.com">',
    '<link rel="dns-prefetch" href="//www.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
    '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  ].join('\n');
  return html.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
}

function injectDeviceOptimizations(html, pRoute) {
  const hints = buildDeviceHints(pRoute);
  if (!hints) return html;
  if (html.includes('mobile-web-app-capable')) return html;
  return html.replace(/(<head[^>]*>)/i, `$1\n${hints}`);
}

function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;
  const esc = escapeAttr(ctx.description);
  if (/<meta[^>]+name=["']description["']/i.test(html)) {
    return html.replace(/(<meta[^>]+name=["']description["'][^>]+content=["'])[^"']*["']/i, `$1${esc}"`);
  }
  return html.replace(/(<\/head>)/i, `<meta name="description" content="${esc}">\n$1`);
}

function injectCanonical(html, ctx, url) {
  if (/<link[^>]+rel=["']canonical["']/i.test(html)) return html;
  return html.replace(/(<\/head>)/i, `<link rel="canonical" href="${escapeAttr(ctx.postUrl || url.toString())}">\n$1`);
}

function injectSeoTags(html, ctx) {
  if (!ctx.title) return html;
  const tags = [];
  const og = (p, c) => { if (c && !new RegExp(`property=["']${escapeRe(p)}["']`).test(html)) tags.push(`<meta property="${p}" content="${escapeAttr(c)}">`); };
  const tw = (n, c) => { if (c && !new RegExp(`name=["']${escapeRe(n)}["']`).test(html)) tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`); };
  og('og:title',       ctx.title);
  og('og:description', ctx.description);
  og('og:url',         ctx.postUrl);
  og('og:type',        ctx.type === 'post' ? 'article' : 'website');
  og('og:site_name',   ctx.siteName);
  og('og:locale',      'ko_KR');
  if (ctx.imageUrl)    og('og:image', ctx.imageUrl);
  tw('twitter:card',        ctx.imageUrl ? 'summary_large_image' : 'summary');
  tw('twitter:title',       ctx.title);
  tw('twitter:description', ctx.description);
  if (ctx.imageUrl) tw('twitter:image', ctx.imageUrl);
  // 네이버 SEO 특화
  if (ctx.author) tw('dable:item_id', ctx.postUrl);
  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 추출
// ─────────────────────────────────────────────
async function extractPageContext(html, url) {
  const ctx = {
    type       : detectPageType(url),
    title      : '',
    description: '',
    imageUrl   : '',
    author     : '',
    publishDate: '',
    updateDate : '',
    tags       : [],
    postUrl    : url.toString(),
    siteName   : extractSiteName(html),
    logoUrl    : extractLogoUrl(html),
  };
  ctx.title       = extractMeta(html, 'og:title') || extractTagContent(html, /<title[^>]*>([^<]+)<\/title>/i) || '';
  const bodyText  = extractBodyText(html);
  ctx.description = extractMeta(html, 'description') || extractMeta(html, 'og:description') || buildMetaDescription(bodyText, ctx.title);
  ctx.imageUrl    = extractMeta(html, 'og:image')    || extractFirstImage(html)              || '';
  ctx.publishDate = extractMeta(html, 'article:published_time') || extractJsonLdDate(html, 'datePublished') || '';
  ctx.updateDate  = extractMeta(html, 'article:modified_time')  || extractJsonLdDate(html, 'dateModified')  || ctx.publishDate;
  ctx.author      = extractMeta(html, 'article:author') || extractTagContent(html, /class="fn"[^>]*>([^<]+)</i) || '';
  ctx.tags        = extractLabels(html);
  return ctx;
}

function detectPageType(url) {
  const p = url.pathname;
  if (p === '/' || p === '') return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p)) return 'post';
  if (/^\/p\//.test(p)) return 'page';
  if (p.startsWith('/search/label/')) return 'label';
  if (p.startsWith('/search')) return 'search';
  if (/^\/[^/]+$/.test(p) && !isReservedFlatPath(p)) return 'post';
  return 'other';
}

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/')) return true;
  if (url.searchParams.has('alt')) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) { return (resp.headers.get('content-type') || '').includes('text/html'); }

function shouldBypassCache(request, url, path) {
  if (!['GET', 'HEAD'].includes(request.method)) return true;
  if (request.headers.get('cache-control') === 'no-cache') return true;
  if (path.startsWith('/b/') || path.startsWith('/admin') || path === '/ncr') return true;
  if (url.searchParams.has('blogedit') || url.searchParams.has('postID') ||
      url.searchParams.has('action') || url.searchParams.has('widgetType')) return true;
  if (path.startsWith('/search') && url.searchParams.has('q')) return true;
  return false;
}

// ─────────────────────────────────────────────
// 응답 유틸
// ─────────────────────────────────────────────
function stripInternalHeaders(resp, isStaticAsset) {
  try {
    const h = new Headers(resp.headers);
    ['cf-cache-status','cf-ray','nel','report-to','server'].forEach(k => h.delete(k));
    h.set('x-powered-by', 'BloggerSEO-v7');
    if (isStaticAsset && resp.ok) {
      const cc = h.get('cache-control') || '';
      if (!cc || /no-store|no-cache|max-age=0/i.test(cc)) {
        h.set('cache-control', 'public, max-age=86400, stale-while-revalidate=3600');
      }
      const vary = h.get('vary') || '';
      if (!/accept-encoding/i.test(vary)) h.set('vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  } catch (_) { return resp; }
}

function errResp(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-error'      : String(message).slice(0, 500),
    },
  });
}

function jsonHeaders() {
  return { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
}

function buildResponseHeaders(etag, cacheControl = 'no-store') {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  h.set('cache-control',          cacheControl);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding, Cookie');
  h.set('x-powered-by',           'BloggerSEO-v7');
  if (etag) h.set('etag', etag);
  return h;
}

// ─────────────────────────────────────────────
// 관리 패널 HTML (단일 파일 SPA)
// ─────────────────────────────────────────────
function panelLoginHtml() {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BloggerSEO Panel — 로그인</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:#0f172a;color:#e2e8f0;display:flex;align-items:center;
  justify-content:center;min-height:100vh}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;
  padding:40px;width:360px;text-align:center}
h1{font-size:22px;font-weight:700;margin-bottom:8px;color:#f8fafc}
p{color:#94a3b8;font-size:14px;margin-bottom:24px}
input{width:100%;padding:12px 16px;border:1px solid #475569;border-radius:8px;
  background:#0f172a;color:#f8fafc;font-size:14px;margin-bottom:12px}
button{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;
  border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#2563eb}
</style></head><body>
<div class="card">
  <h1>🛡️ BloggerSEO Panel</h1>
  <p>관리 패널에 접근하려면 시크릿 키를 입력하세요</p>
  <input type="password" id="sec" placeholder="Panel Secret Key" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">로그인</button>
</div>
<script>
function login(){
  const s=document.getElementById('sec').value;
  if(s)window.location.href='/panel?secret='+encodeURIComponent(s);
}
</script></body></html>`;
}

function panelHtml(secret) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BloggerSEO v7 — 관리 패널</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#0f172a;color:#e2e8f0;min-height:100vh}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:#1e293b;
  border-right:1px solid #334155;padding:20px 0;z-index:10}
.logo{padding:0 20px 20px;font-size:18px;font-weight:800;color:#3b82f6;
  border-bottom:1px solid #334155;margin-bottom:16px}
.nav-item{padding:10px 20px;cursor:pointer;color:#94a3b8;font-size:14px;
  transition:all .15s;display:flex;align-items:center;gap:10px}
.nav-item:hover,.nav-item.active{background:#334155;color:#f8fafc}
.main{margin-left:220px;padding:28px}
h2{font-size:22px;font-weight:700;margin-bottom:20px;color:#f8fafc}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:28px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px}
.card-title{font-size:12px;font-weight:600;text-transform:uppercase;
  letter-spacing:.05em;color:#64748b;margin-bottom:8px}
.card-value{font-size:28px;font-weight:800;color:#f8fafc}
.card-sub{font-size:12px;color:#64748b;margin-top:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;
  font-size:11px;font-weight:600}
.badge-green{background:#064e3b;color:#34d399}
.badge-yellow{background:#451a03;color:#fb923c}
.badge-red{background:#450a0a;color:#f87171}
.table-wrap{background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{background:#334155;padding:10px 14px;text-align:left;font-size:12px;
  font-weight:600;color:#94a3b8;text-transform:uppercase}
td{padding:10px 14px;border-top:1px solid #1e293b;font-size:13px;color:#cbd5e1}
tr:hover td{background:#334155}
.btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;
  font-weight:600;cursor:pointer;transition:all .15s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
.btn-danger{background:#ef4444;color:#fff}
.btn-danger:hover{background:#dc2626}
.btn-sm{padding:5px 10px;font-size:12px}
.section{margin-bottom:32px}
.flex{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.tag{background:#1e3a5f;color:#60a5fa;padding:4px 10px;border-radius:6px;font-size:12px}
#toast{position:fixed;bottom:24px;right:24px;background:#22c55e;color:#fff;
  padding:12px 20px;border-radius:10px;font-weight:600;font-size:14px;
  opacity:0;transition:opacity .3s;z-index:999}
.chart-bar{background:#334155;border-radius:4px;height:8px;overflow:hidden;margin-top:6px}
.chart-fill{background:#3b82f6;height:100%;transition:width .5s}
.ip-input{background:#0f172a;border:1px solid #475569;border-radius:8px;
  color:#f8fafc;padding:8px 12px;font-size:13px;width:200px}
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo">🚀 BloggerSEO v7</div>
  <div class="nav-item active" onclick="showSection('dashboard')">📊 대시보드</div>
  <div class="nav-item" onclick="showSection('cache')">💾 캐시 관리</div>
  <div class="nav-item" onclick="showSection('redis')">🧬 Redis 관리</div>
  <div class="nav-item" onclick="showSection('routing')">🌐 라우팅 상태</div>
  <div class="nav-item" onclick="showSection('lb')">⚖️ 로드밸런서</div>
  <div class="nav-item" onclick="showSection('analytics')">📈 캐시 애널리틱스</div>
  <div class="nav-item" onclick="showSection('security')">🛡️ 보안/IP 관리</div>
  <div class="nav-item" onclick="showSection('sitemap')">🗺️ 사이트맵/RSS</div>
</div>
<div class="main">
  <!-- 대시보드 -->
  <div id="s-dashboard">
    <h2>📊 대시보드</h2>
    <div class="grid" id="metric-cards">
      <div class="card"><div class="card-title">총 요청</div><div class="card-value" id="m-count">-</div></div>
      <div class="card"><div class="card-title">에러율</div><div class="card-value" id="m-errrate">-</div></div>
      <div class="card"><div class="card-title">평균 레이턴시</div><div class="card-value" id="m-latency">-</div></div>
      <div class="card"><div class="card-title">워커 부하</div><div class="card-value" id="m-load">-</div></div>
    </div>
    <div class="section">
      <div class="card">
        <div class="card-title">상태 코드 분포</div>
        <div id="status-dist" style="margin-top:12px"></div>
      </div>
    </div>
    <div class="flex">
      <button class="btn btn-primary" onclick="loadDashboard()">🔄 새로고침</button>
    </div>
  </div>

  <!-- 캐시 관리 -->
  <div id="s-cache" style="display:none">
    <h2>💾 Cache Reserve 관리</h2>
    <div class="grid">
      <div class="card"><div class="card-title">전체 캐시 항목</div><div class="card-value" id="c-total">-</div></div>
      <div class="card"><div class="card-title">활성 캐시</div><div class="card-value" id="c-alive">-</div><div class="card-sub">TTL: 4시간</div></div>
      <div class="card"><div class="card-title">만료된 캐시</div><div class="card-value" id="c-stale">-</div></div>
    </div>
    <div class="flex">
      <button class="btn btn-primary" onclick="loadCacheStats()">🔄 새로고침</button>
      <button class="btn btn-danger" onclick="purgeCache()">🗑️ 캐시 전체 삭제</button>
    </div>
  </div>

  <!-- Redis 관리 (100% 자체 제작, Durable Objects 기반) -->
  <div id="s-redis" style="display:none">
    <h2>🧬 자체 제작 서버리스 Redis 관리</h2>
    <div class="grid">
      <div class="card"><div class="card-title">상태</div><div class="card-value" id="r-available">-</div></div>
      <div class="card"><div class="card-title">샤드 수</div><div class="card-value" id="r-shardcount">-</div></div>
      <div class="card"><div class="card-title">총 키 개수</div><div class="card-value" id="r-totalkeys">-</div></div>
      <div class="card"><div class="card-title">총 용량(추정)</div><div class="card-value" id="r-totalbytes">-</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">참고</div>
      <div style="margin-top:8px;color:#94a3b8;font-size:13px;line-height:1.7">
        Durable Objects(SQLite storage backend)로 100% 자체 구현한 Redis 호환 엔진입니다.
        샤드(독립 DO 인스턴스)를 늘릴수록 총 용량이 선형으로 늘어나는 구조이며,
        wrangler.toml의 <code>REDIS_SHARD_COUNT</code> 값으로 조절합니다.
        KV/Upstash는 이 엔진이 죽었을 때만 사용되는 백업 계층입니다.
      </div>
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>샤드</th><th>키 개수</th><th>용량(bytes, 추정)</th></tr></thead>
      <tbody id="redis-shard-table"></tbody></table>
    </div>
    <div class="flex" style="margin-top:16px">
      <button class="btn btn-primary" onclick="loadRedis()">🔄 새로고침</button>
      <button class="btn btn-danger" onclick="flushRedis()">🗑️ Redis 전체 비우기 (FLUSHALL)</button>
    </div>
  </div>

  <!-- 라우팅 상태 -->
  <div id="s-routing" style="display:none">
    <h2>🌐 지역별 캐시 현황 (Regional Tiered Cache)</h2>
    <div id="regional-stats" class="grid"></div>
    <div class="flex"><button class="btn btn-primary" onclick="loadRegional()">🔄 새로고침</button></div>
  </div>

  <!-- 로드밸런서 -->
  <div id="s-lb" style="display:none">
    <h2>⚖️ 로드밸런서 상태</h2>
    <div class="grid">
      <div class="card"><div class="card-title">활성 인스턴스</div><div class="card-value" id="lb-instances">-</div></div>
      <div class="card"><div class="card-title">평균 부하</div><div class="card-value" id="lb-avgload">-</div></div>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <table><thead><tr><th>워커 ID</th><th>InFlight</th><th>최대</th><th>부하</th><th>최종 업데이트</th></tr></thead>
      <tbody id="lb-table"></tbody></table>
    </div>
    <div class="flex" style="margin-top:16px"><button class="btn btn-primary" onclick="loadLb()">🔄 새로고침</button></div>
  </div>

  <!-- 애널리틱스 -->
  <div id="s-analytics" style="display:none">
    <h2>📈 캐시 애널리틱스</h2>
    <div class="grid">
      <div class="card"><div class="card-title">캐시 HIT</div><div class="card-value" id="a-hits">-</div></div>
      <div class="card"><div class="card-title">페이지뷰</div><div class="card-value" id="a-views">-</div></div>
      <div class="card"><div class="card-title">가장 많은 지역</div><div class="card-value" id="a-region">-</div></div>
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>시각</th><th>유형</th><th>경로</th><th>지역</th><th>디바이스</th><th>레이턴시</th></tr></thead>
      <tbody id="a-table"></tbody></table>
    </div>
    <div class="flex" style="margin-top:16px"><button class="btn btn-primary" onclick="loadAnalytics()">🔄 새로고침</button></div>
  </div>

  <!-- 보안 -->
  <div id="s-security" style="display:none">
    <h2>🛡️ IP 차단 관리</h2>
    <div class="flex" style="margin-bottom:20px">
      <input class="ip-input" id="block-ip-input" placeholder="차단할 IP 주소">
      <button class="btn btn-danger" onclick="blockIp()">차단</button>
    </div>
    <div class="table-wrap">
      <table><thead><tr><th>차단 IP</th><th>작업</th></tr></thead>
      <tbody id="ip-table"></tbody></table>
    </div>
    <div class="flex" style="margin-top:16px"><button class="btn btn-primary" onclick="loadIps()">🔄 새로고침</button></div>
  </div>

  <!-- 사이트맵/RSS -->
  <div id="s-sitemap" style="display:none">
    <h2>🗺️ 사이트맵 / RSS 관리</h2>
    <div class="grid">
      <div class="card">
        <div class="card-title">사이트맵 XML</div>
        <div class="card-sub" style="margin-top:8px">/sitemap.xml</div>
        <div class="flex" style="margin-top:12px">
          <button class="btn btn-primary btn-sm" onclick="genSitemap()">즉시 생성</button>
          <a href="/sitemap.xml" target="_blank" class="btn btn-sm" style="background:#334155;color:#f8fafc;text-decoration:none">보기</a>
        </div>
      </div>
      <div class="card">
        <div class="card-title">RSS 피드</div>
        <div class="card-sub" style="margin-top:8px">/rss.xml</div>
        <div class="flex" style="margin-top:12px">
          <button class="btn btn-primary btn-sm" onclick="genRss()">즉시 생성</button>
          <a href="/rss.xml" target="_blank" class="btn btn-sm" style="background:#334155;color:#f8fafc;text-decoration:none">보기</a>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-title">Cron 스케줄</div>
      <div style="margin-top:10px;color:#94a3b8;font-size:13px;line-height:1.8">
        🕐 사이트맵: <span class="tag">매 1시간</span><br>
        📡 RSS: <span class="tag">매 30분</span><br>
        🔍 슬러그 감사: <span class="tag">매 1시간</span><br>
        🗑️ 만료 캐시 정리: <span class="tag">매 1시간</span>
      </div>
    </div>
  </div>
</div>

<div id="toast">✅ 완료</div>

<script>
const SECRET = '${secret}';
const api = (path) => fetch('/panel/'+path+'?secret='+encodeURIComponent(SECRET)).then(r=>r.json());
const apiPost = (path) => fetch('/panel/'+path+'?secret='+encodeURIComponent(SECRET), {method:'POST'}).then(r=>r.json());

function toast(msg='완료'){
  const t=document.getElementById('toast');
  t.textContent='✅ '+msg; t.style.opacity='1';
  setTimeout(()=>t.style.opacity='0',2500);
}

function showSection(name){
  document.querySelectorAll('[id^="s-"]').forEach(el=>el.style.display='none');
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  document.getElementById('s-'+name).style.display='';
  event.target.classList.add('active');
  if(name==='dashboard') loadDashboard();
  else if(name==='cache') loadCacheStats();
  else if(name==='redis') loadRedis();
  else if(name==='routing') loadRegional();
  else if(name==='lb') loadLb();
  else if(name==='analytics') loadAnalytics();
  else if(name==='security') loadIps();
}

async function loadDashboard(){
  const [m,lb]=await Promise.all([api('api/metrics'),api('api/lb_status')]);
  document.getElementById('m-count').textContent=(m.count||0).toLocaleString();
  document.getElementById('m-errrate').textContent=((m.errorRate||0)*100).toFixed(2)+'%';
  document.getElementById('m-latency').textContent=(m.avgLatencyMs||0)+'ms';
  document.getElementById('m-load').textContent=Math.round((lb.avgLoad||0)*100)+'%';
  const dist=document.getElementById('status-dist');
  if(m.statusCounts){
    dist.innerHTML=Object.entries(m.statusCounts).map(([k,v])=>
      \`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="width:40px;font-size:13px;color:#94a3b8">\${k}</span>
        <div class="chart-bar" style="flex:1"><div class="chart-fill" style="width:\${Math.min(100,v/m.count*100)}%"></div></div>
        <span style="font-size:13px;color:#f8fafc;width:60px;text-align:right">\${v.toLocaleString()}</span>
      </div>\`).join('');
  }
}

async function loadCacheStats(){
  const c=await api('api/cache_stats');
  document.getElementById('c-total').textContent=(c.total||0).toLocaleString();
  document.getElementById('c-alive').textContent=(c.alive||0).toLocaleString();
  document.getElementById('c-stale').textContent=(c.stale||0).toLocaleString();
}

async function loadRedis(){
  const r=await api('api/redis_stats');
  document.getElementById('r-available').innerHTML = r.available
    ? '<span class="badge badge-green">활성</span>'
    : '<span class="badge badge-red">미연동</span>';
  document.getElementById('r-shardcount').textContent=r.shardCount||0;
  document.getElementById('r-totalkeys').textContent=(r.totalKeys||0).toLocaleString();
  const kb=(r.totalBytesApprox||0)/1024;
  document.getElementById('r-totalbytes').textContent = kb>1024 ? (kb/1024).toFixed(2)+' MB' : kb.toFixed(1)+' KB';
  const tb=document.getElementById('redis-shard-table');
  tb.innerHTML=(r.shards||[]).filter(s=>s.keys>0).map(s=>\`<tr>
    <td>#\${s.shard}</td><td>\${(s.keys||0).toLocaleString()}</td><td>\${(s.bytesApprox||0).toLocaleString()}</td>
  </tr>\`).join('')||\`<tr><td colspan="3" style="color:#64748b;text-align:center">저장된 키 없음</td></tr>\`;
}

async function flushRedis(){
  if(!confirm('자체 제작 Redis(DO)의 모든 키를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
  await apiPost('api/redis_flush');
  toast('Redis 전체 비우기 완료');
  loadRedis();
}

async function loadRegional(){
  const r=await api('api/regional_cache');
  const grid=document.getElementById('regional-stats');
  grid.innerHTML=Object.entries(r).map(([reg,d])=>\`
    <div class="card">
      <div class="card-title">\${reg}</div>
      <div class="card-value">\${((d.ratio||0)*100).toFixed(1)}%</div>
      <div class="card-sub">HIT: \${d.hits||0} / MISS: \${d.misses||0}</div>
      <div class="chart-bar"><div class="chart-fill" style="width:\${(d.ratio||0)*100}%"></div></div>
    </div>\`).join('');
}

async function loadLb(){
  const d=await api('api/lb_status');
  document.getElementById('lb-instances').textContent=d.instances||0;
  document.getElementById('lb-avgload').textContent=Math.round((d.avgLoad||0)*100)+'%';
  const tb=document.getElementById('lb-table');
  tb.innerHTML=(d.workers||[]).map(w=>\`<tr>
    <td><code>\${w.workerId}</code></td>
    <td>\${w.inFlight}</td><td>\${w.maxFlight}</td>
    <td><span class="badge \${w.load>0.8?'badge-red':w.load>0.5?'badge-yellow':'badge-green'}">\${Math.round(w.load*100)}%</span></td>
    <td style="font-size:11px">\${new Date(w.ts).toLocaleTimeString('ko-KR')}</td>
  </tr>\`).join('');
}

async function loadAnalytics(){
  const data=await api('api/analytics');
  const hits=data.filter(d=>d.type==='cache_hit').length;
  const views=data.filter(d=>d.type==='page_view').length;
  document.getElementById('a-hits').textContent=hits;
  document.getElementById('a-views').textContent=views;
  const regions={};
  data.forEach(d=>{if(d.region)regions[d.region]=(regions[d.region]||0)+1});
  const topR=Object.entries(regions).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('a-region').textContent=topR?topR[0]+' ('+topR[1]+')':'-';
  const tb=document.getElementById('a-table');
  tb.innerHTML=data.slice(0,50).map(d=>\`<tr>
    <td style="font-size:11px">\${new Date(d.ts).toLocaleTimeString('ko-KR')}</td>
    <td><span class="badge \${d.type==='cache_hit'?'badge-green':'badge-yellow'}">\${d.type}</span></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">\${d.path||'-'}</td>
    <td>\${d.region||'-'}</td>
    <td><span class="tag">\${d.label||'-'}</span></td>
    <td>\${d.latencyMs?d.latencyMs+'ms':'-'}</td>
  </tr>\`).join('');
}

async function loadIps(){
  const ips=await api('api/blocked_ips');
  const tb=document.getElementById('ip-table');
  tb.innerHTML=(ips||[]).map(k=>{
    const ip=k.replace('state:block:','');
    return \`<tr><td><code>\${ip}</code></td>
      <td><button class="btn btn-sm btn-primary" onclick="unblockIp('\${ip}')">해제</button></td></tr>\`;
  }).join('')||\`<tr><td colspan="2" style="color:#64748b;text-align:center">차단된 IP 없음</td></tr>\`;
}

async function blockIp(){
  const ip=document.getElementById('block-ip-input').value.trim();
  if(!ip) return;
  await api('api/block_ip/'+encodeURIComponent(ip));
  toast(ip+' 차단 완료');
  document.getElementById('block-ip-input').value='';
  loadIps();
}

async function unblockIp(ip){
  await api('api/unblock_ip/'+encodeURIComponent(ip));
  toast(ip+' 차단 해제');
  loadIps();
}

async function purgeCache(){
  if(!confirm('캐시를 전체 삭제하시겠습니까?')) return;
  await api('api/purge_cache');
  toast('캐시 삭제 완료');
  loadCacheStats();
}

async function genSitemap(){
  const r=await api('api/generate_sitemap');
  toast('사이트맵 생성 완료 ('+r.count+'개 URL)');
}

async function genRss(){
  const r=await api('api/generate_rss');
  toast('RSS 생성 완료 ('+r.count+'개 항목)');
}

// 초기 로드
loadDashboard();
</script>
</body>
</html>`;
}
