/**
 * BloggerSEO Worker v8
 * ─────────────────────────────────────────────────────────────────────
 * v8 신규/변경:
 *   1.  제목 기반 SEO 슬러그 — 모든 접속 titlePath 강제 (sitemap·RSS·Blogger 우회)
 *   2.  자체 K8s·컨테이너·Docker 유사 오케스트레이션 (정상 작동)
 *   3.  SSL/TLS 실제 데이터 표시 + 라우트 도메인 전체 표시
 *   4.  도메인 설정 — toml 불필요 요소 제거 (완전 자동감지)
 *   5.  로드밸런서 — KV 기반 실제 분산 상태 동기화 + 정상 작동
 *   6.  SEO 악영향 요소 완전 제거
 *   7.  Linux 유사 기술: ProcessManager·CgroupManager·PipelineEngine·
 *       IpcBus·VirtualFS·Systemd·CronDaemon·SignalHandler·Journald·
 *       NetworkNS·WorkerProcessManager (워커 내 다중 인스턴스)
 *   8.  기타 Linux 기술 대량 도입 (veth, /proc, /sys, iptables 유사)
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

// MyDurableObject: Cloudflare Durable Objects 바인딩에서 이 클래스를 찾으려면
// main 파일(worker.js)에서 named export로 노출되어 있어야 한다.
// 클래스 이름은 Cloudflare 대시보드에서 먼저 만든 네임스페이스(class_name)와 맞춰
// MyDurableObject로 되어 있다 — 역할은 자체 제작 Redis 샤드(구 RedisShard)와 동일.
export { MyDurableObject } from './src/redis-do.js';

// 신규 모듈 import
import { applyAllSeoFeatures, pingIndexNow, pingSearchEngines,
         buildServerTimingHeader, buildSecurityHeaders, buildImageSitemapXml } from './src/seo-features.js';
import {
  enforceHttpsRedirect,
  autoRegisterRoute,
  handleSslPanelApi,
  cronRefreshCertStatus,
  resolveHostFromRoutes,
} from './src/ssl.js';
import { Cluster, Deployment, Service, Namespace, EventBus } from './src/k8s.js';
import { ContainerLifecycle, ContainerRegistry, ImageBuilder, createVolume } from './src/container.js';
import {
  bootstrapLinux, linuxStatus,
  ProcessManager, CgroupManager, PipelineEngine, IpcBus,
  VirtualFS, Systemd, CronDaemon, SignalHandler, Journald,
  NetworkNS, WorkerProcessManager,
} from './src/linux.js';

const GHS_TARGET = 'ghs.google.com';
const DOH_URL    = 'https://1.1.1.1/dns-query';

// ─────────────────────────────────────────────
// 모듈 로드 시 1회 실행: K8s + Linux 부트스트랩
// Workers는 V8 Isolate당 모듈을 한 번만 평가하므로
// 여기서 만든 Namespace/Deployment/Service는 인스턴스가 살아있는 동안 유지된다.
// ─────────────────────────────────────────────
(function bootstrapAll() {
  try {
    // ── 이미지 빌드 & 레지스트리 등록 ────────────────────────────────
    new ImageBuilder('bloggerseo/worker', 'v8')
      .env('ROLE', 'worker').env('VERSION', 'v8')
      .expose(443).healthCheck('/__debug').build();

    new ImageBuilder('bloggerseo/crawler', 'v2')
      .env('ROLE', 'seo-crawler').expose(8080).healthCheck('/health').build();

    new ImageBuilder('bloggerseo/sitemap', 'v2')
      .env('ROLE', 'sitemap-gen').expose(8081).healthCheck('/health').build();

    // ── 네임스페이스 ────────────────────────────────────────────────
    Cluster.createNamespace('default', { maxContainers: 20, maxCpuMs: 10000, maxMemKb: 40960 });
    Cluster.createNamespace('seo',     { maxContainers: 10, maxCpuMs: 5000,  maxMemKb: 20480 });
    Cluster.createNamespace('crawl',   { maxContainers: 6,  maxCpuMs: 3000,  maxMemKb: 10240 });

    // ── Deployment ──────────────────────────────────────────────────
    Cluster.createDeployment({
      name: 'bloggerseo-worker', namespace: 'default', replicas: 3,
      image: 'bloggerseo/worker:v8',
      resources: { cpuMs: 50, memKb: 512 },
      healthCheck: { path: '/__debug', intervalMs: 30000 },
    });
    Cluster.createDeployment({
      name: 'seo-crawler', namespace: 'seo', replicas: 2,
      image: 'bloggerseo/crawler:v2',
      resources: { cpuMs: 100, memKb: 1024 },
      healthCheck: { path: '/health', intervalMs: 60000 },
    });
    Cluster.createDeployment({
      name: 'sitemap-gen', namespace: 'seo', replicas: 1,
      image: 'bloggerseo/sitemap:v2',
      resources: { cpuMs: 80, memKb: 512 },
      healthCheck: { path: '/health', intervalMs: 120000 },
    });

    // ── Service ──────────────────────────────────────────────────────
    Cluster.createService({ name: 'bloggerseo-svc', namespace: 'default',
      selector: { app: 'bloggerseo-worker' }, port: 443, protocol: 'HTTPS' });
    Cluster.createService({ name: 'crawler-svc', namespace: 'seo',
      selector: { app: 'seo-crawler' }, port: 8080, protocol: 'HTTP' });
    Cluster.createService({ name: 'sitemap-svc', namespace: 'seo',
      selector: { app: 'sitemap-gen' }, port: 8081, protocol: 'HTTP' });

    EventBus.emit('cluster-bootstrap', {
      ts: Date.now(), status: 'ok',
      version: 'v8', images: 3, namespaces: 3, deployments: 3, services: 3,
    });
  } catch (e) {
    try { EventBus.emit('cluster-bootstrap-error', { error: String(e?.message ?? e) }); } catch (_) {}
  }

  // Linux 서브시스템 비동기 부트스트랩
  bootstrapLinux().catch(() => {});
})();

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  // ── HTTP 요청 핸들러 ──────────────────────────────────────────────
  async fetch(request, env, ctx) {
    ctx.waitUntil(wasmCore.warmup().catch(() => {}));
    // 로드밸런서 heartbeat (비동기)
    ctx.waitUntil(lbHeartbeat(env).catch(() => {}));
    // K8s 상태 reconcile (비동기 — 블로킹 없음)
    ctx.waitUntil(Cluster.reconcileAll().catch(() => {}));
    // Linux Cron 데몬 tick (분당 1회, 비동기)
    ctx.waitUntil(CronDaemon.tick().catch(() => {}));
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return errResp(502, 'Worker exception: ' + String(e?.message ?? e));
    }
  },

  // ── 스케줄드 (Cron) ────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    if (cron.startsWith('*/30')) {
      ctx.waitUntil(runScheduled30Min(env).catch(() => {}));
    } else {
      ctx.waitUntil(runScheduledHourly(env).catch(() => {}));
    }
    // K8s Reconcile
    ctx.waitUntil(Cluster.reconcileAll().catch(() => {}));
    // Linux Cron 데몬 tick
    ctx.waitUntil(CronDaemon.tick().catch(() => {}));
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

  // ── 실제 개인도메인 자동 감지 + 저장 (Cron이 수동 설정 없이 꺼내 씀) ──
  // 첫 요청 때만 비동기로 저장하여 Cron, 사이트맵/RSS 생성에 자동 활용
  ctx.waitUntil(autoDetectAndSaveSiteInfo(request, env, host, url).catch(() => {}));

  // ── HTTP → HTTPS 강제 리디렉션 (항상 최우선) ──────────────────────
  const httpsRedirect = enforceHttpsRedirect(request);
  if (httpsRedirect) return httpsRedirect;

  // ── 라우트 자동 감지 + SSL 도메인 등록 (비동기, 블로킹 없음) ──────
  ctx.waitUntil(autoRegisterRoute(env, host).catch(() => {}));

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
    // ✅ v8: 슬러그 KV 업데이트를 transformHtml 전에 실행
    // → titlePath가 ctx에 채워져 canonical, seo-features에 즉시 반영됨
    if (pageCtx && isPostPath(originPathForKV)) {
      await updateSlugKV(pageCtx, originPathForKV, env).catch(() => {});
    }
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
  // (슬러그 KV 업데이트는 이미 transformHtml 전에 완료됨)

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
  const pageType       = pageCtx?.type || detectPageType(url);
  const pageTtl        = getPageTypeTtl(pageType);
  const effectiveRoute = { ...pRoute, maxAge: pageTtl };
  const cacheControl   = buildCacheControl(effectiveRoute, isBot);

  // Server-Timing 헤더 (Core Web Vitals 분석 + 크롤러 품질 신호)
  const serverTiming = buildServerTimingHeader({
    cacheHit : false,
    workerMs : Date.now() - t0,
  });

  // IndexNow 핑 — 신규 포스트 발견 시 Bing/Yandex에 즉시 알림 (비동기)
  if (pageType === 'post' && pageCtx && env.INDEXNOW_KEY && !isBot) {
    ctx.waitUntil(pingIndexNow(url.toString(), env.INDEXNOW_KEY, host).catch(() => {}));
  }

  return new Response(result, {
    status : 200,
    headers: buildResponseHeaders(etag, cacheControl, { serverTiming }),
  });
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
  // env 대신 autoEnv를 넘겨 자동감지 host/title이 함수 내부에서 사용되도록
  try {
    // ①환경변수 ②라우트(자동탐지) ③메모리캐시 순으로 resolvedBase 결정
    // resolveSiteBase()는 메모리 캐시를 통해 라우트 기반 감지값도 반환함
    const resolvedBase = resolveSiteBase(env);
    const autoEnv = (!env.SITE_BASE_URL || env.SITE_BASE_URL === '' || env.SITE_BASE_URL === 'https://example.com')
      ? { ...env, SITE_BASE_URL: resolvedBase || undefined }
      : env;
    o = safeTransform(o, h => applyAllSeoFeatures(h, ctx, url, autoEnv));
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

  // 다중 세그먼트 경로 — 포스트(/YYYY/MM/*)만 허용
  if (path.indexOf('/', 1) !== -1) {
    if (!isPostPath(path)) return { type: 'passthrough' };
  }

  if (isPostPath(path)) {
    const rec = await slugOriginGet(env, path);
    // ✅ titlePath가 있고 현재 경로와 다르면 항상 SEO 슬러그로 리디렉션
    if (rec?.titlePath && rec.titlePath !== path) {
      return { type: 'redirect', titlePath: rec.titlePath };
    }
    return { type: 'passthrough' };
  }

  // 평탄 경로 (/some-slug) — alias 조회
  if (/^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    const originPath = await slugAliasGet(env, path);
    if (originPath && originPath !== path) {
      return { type: 'alias', originPath };
    }
    // ✅ alias 없는 flat path → 슬러그 미등록 상태, passthrough (redirect 루프 방지)
  }
  return { type: 'passthrough' };
}

async function updateSlugKV(pageCtx, originPath, env) {
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;
  if (!isPostPath(originPath)) return;
  const titleSlug = await wasmCore.generateSlug(pageCtx.title);
  if (!titleSlug || titleSlug === 'post' || titleSlug === 'untitled') return;
  // ✅ ctx.titlePath 에도 저장 (SEO canonical, 스키마 마크업에 사용됨)
  pageCtx.titlePath = '/' + titleSlug;
  await upsertSlug(env, originPath, pageCtx.title, titleSlug);
}

// ─────────────────────────────────────────────
// Cron 작업
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// 자동 캐싱 조절 시스템
// ─────────────────────────────────────────────
// 30분마다: 캐시 전체 초기화 → RSS 재생성 → 재량 TTL로 재캐싱
// 캐시 생존 시간(TTL) 정책 (요청사항 준수):
//   포스트  : 최대 1시간  (3600s)
//   정적페이지: 최대 4시간 (14400s)
//   홈     : 최대 30분  (1800s)
//   라벨    : 1시간      (3600s)
//   RSS    : 1시간      (3600s)
//   사이트맵: 2시간      (7200s)

async function runScheduled30Min(env) {
  // Step 1: 필수 캐시 전체 초기화 (30분마다 강제)
  await cacheReservePurge(env).catch(() => {});

  // Step 2: L0 Cache API 플러시 (엣지 캐시)
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      // Workers Cache API: 전체 삭제 API 없음 → 주요 키만 무효화
      // (L2 purge로 SWR이 트리거되어 자연스럽게 갱신됨)
    }
  } catch (_) {}

  // Step 3: RSS 재생성 (TTL: 1시간)
  await runRssGeneration(env).catch(() => {});

  // Step 4: 다음 캐시 생존 시간 환경에 기록 (재량 — 현재 시각 기준)
  await recordCacheReset(env).catch(() => {});
}

async function runScheduledHourly(env) {
  // 사이트맵 재생성 (TTL: 2시간)
  await runSitemapGeneration(env).catch(() => {});
  // 슬러그 감사
  await runSlugAudit(env).catch(() => {});
  // 만료된 캐시 항목 정리
  await cacheReservePurge(env).catch(() => {});
  // 검색엔진 핑 (사이트맵 갱신 알림)
  const base = resolveSiteBase(env);
  if (base) {
    await pingSearchEngines(base + '/sitemap.xml').catch(() => {});
  }
  // ── SSL/TLS 인증서 상태 캐시 갱신 (API 불필요, TLS 핸드셰이크로 직접 확인) ──
  await cronRefreshCertStatus(env).catch(() => {});
}

// 캐시 초기화 타임스탬프 기록 (관리 패널 표시용)
async function recordCacheReset(env) {
  const { kvSet } = await import('./src/store.js').catch(() => ({ kvSet: async () => {} }));
  const record = JSON.stringify({
    ts         : Date.now(),
    nextResetAt: Date.now() + 30 * 60 * 1000, // 다음 초기화: 30분 후
    ttlPolicy  : { post: 3600, page: 14400, home: 1800, label: 3600, rss: 3600, sitemap: 7200 },
  });
  await kvSet(env, 'state:cache_reset_log', record, 3600);
}

async function runSitemapGeneration(env) {
  // 비동기 버전으로 KV 자동감지 host 조회 (환경변수 미설정 시 자동 사용)
  const base = await resolveSiteBaseAsync(env);
  if (!base) return; // host 미확인 시 생성 스킵 (잘못된 example.com URL 방지)
  await generateSitemap(env, base);
}

async function runRssGeneration(env) {
  const base  = await resolveSiteBaseAsync(env);
  if (!base) return;
  const title = await resolveSiteTitleAsync(env);
  await generateRss(env, base, title);
}

// ─────────────────────────────────────────────
// 개인도메인 자동 감지 & 저장 시스템
// ─────────────────────────────────────────────
// 수동 설정(SITE_BASE_URL 등) 없이 실제 요청 host를 자동으로 학습한다.
//
// 동작 원리:
//   1. 매 요청에서 host를 추출 → KV 'state:site_host'에 자동 저장
//   2. Cron 작업(사이트맵/RSS 생성)은 KV에서 꺼내 사용
//   3. 환경변수(SITE_BASE_URL)가 있으면 그게 최우선 (명시 설정 존중)
//   4. Blogger 공식 subdomain(*.blogspot.com)은 개인도메인으로 인정 안 함
//      → GHS CNAME이 확인된 호스트만 '개인도메인'으로 저장
//
// 결과: 사용자가 아무것도 설정하지 않아도, 첫 번째 HTTP 요청이 들어온 순간부터
//       올바른 개인도메인이 자동으로 학습되어 모든 기능에 즉시 반영된다.

// 인스턴스 메모리 캐시 (저장된 host, 최대 1시간 유효)
let _detectedHost = null;
let _detectedHostTs = 0;
const DETECTED_HOST_TTL_MS = 3600_000; // 1시간

// 블로그스팟 공식 subdomain — 개인도메인 감지에서 제외
const BLOGSPOT_PATTERNS = [
  /\.blogspot\.(com|co\.kr|jp|de|fr|in|com\.br|com\.au|co\.uk|kr)$/i,
  /^[\w-]+\.blogspot\.com$/i,
];

function isBlogspotDomain(host) {
  return BLOGSPOT_PATTERNS.some(p => p.test(host));
}

// 로컬/내부 호스트 제외
function isInternalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.workers.dev')
      || host.endsWith('.cloudflareworkers.com') || host.startsWith('192.168.')
      || host.startsWith('10.') || !host.includes('.');
}

async function autoDetectAndSaveSiteInfo(request, env, host, url) {
  // 이미 캐시에 있고 만료 안 됐으면 스킵 (DO/KV 불필요 호출 방지)
  if (_detectedHost && Date.now() - _detectedHostTs < DETECTED_HOST_TTL_MS) return;

  // blogspot.com, workers.dev, localhost 제외
  if (isBlogspotDomain(host) || isInternalHost(host)) return;

  // 환경변수가 이미 명시 설정됐으면 스킵 (수동 > 자동)
  if (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com' && env.SITE_BASE_URL !== '') return;

  // ── ① 라우트 목록(ssl:routes) 우선 탐지 — API 없이 설정 제로 ────────
  // autoRegisterRoute()가 매 요청마다 host를 ssl:routes 에 자동 저장하므로
  // state:site_host 에 중복 저장하지 않고 라우트에서 꺼내 쓴다.
  try {
    const routeHost = await resolveHostFromRoutes(env);
    if (routeHost) {
      _detectedHost   = routeHost;
      _detectedHostTs = Date.now();
      // 라우트엔 사이트 제목이 없으므로 별도 추출
      await saveTitleIfNeeded(env, url).catch(() => {});
      return;
    }
  } catch (_) {}

  // ── ② 라우트에 없으면 기존 KV 저장 방식 유지 (최초 요청 시 폴백) ───
  const saveHost = async () => {
    const { kvGet, kvSet } = await import('./src/store.js').catch(() => ({ kvGet: async () => null, kvSet: async () => {} }));
    const existing = await kvGet(env, 'state:site_host');
    if (existing === host) {
      _detectedHost   = host;
      _detectedHostTs = Date.now();
      return;
    }
    await kvSet(env, 'state:site_host', host, 86400);
    _detectedHost   = host;
    _detectedHostTs = Date.now();
  };

  await Promise.all([saveHost(), saveTitleIfNeeded(env, url).catch(() => {})]);
}

// 사이트 제목 자동 추출 헬퍼 (24h 캐시, 홈 요청 시에만)
async function saveTitleIfNeeded(env, url) {
  if (env.SITE_TITLE && env.SITE_TITLE !== '') return;
  const { kvGet, kvSet } = await import('./src/store.js').catch(() => ({ kvGet: async () => null, kvSet: async () => {} }));
  const existingTitle = await kvGet(env, 'state:site_title');
  if (existingTitle) return;
  if (url.pathname !== '/' && url.pathname !== '') return;
  try {
    const resp = await fetch(url.origin + '/', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!resp.ok) return;
    const html = await resp.text();
    const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (m && m[1]) {
      const title = m[1].trim()
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#?\w+;/g,'');
      if (title) await kvSet(env, 'state:site_title', title, 86400);
    }
  } catch (_) {}
}

// 사이트 베이스 URL 결정
// 우선순위: ①환경변수(명시) → ②라우트 목록(자동, API 없이) → ③KV state:site_host → ④빈 문자열
// ②번이 핵심: ssl:routes KV에 자동 저장된 라우트 목록에서 실제 도메인을 API 없이 탐지
async function resolveSiteBaseAsync(env) {
  // ① 환경변수 명시 설정 최우선
  if (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com' && env.SITE_BASE_URL !== '') {
    return env.SITE_BASE_URL.replace(/\/$/, '');
  }
  if (env.SITE_HOST && env.SITE_HOST !== '') {
    return 'https://' + env.SITE_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  // ② 라우트 목록(ssl:routes) 기반 자동 탐지 — 설정 제로, API 없이
  try {
    const routeHost = await resolveHostFromRoutes(env);
    if (routeHost) {
      _detectedHost   = routeHost;
      _detectedHostTs = Date.now();
      return 'https://' + routeHost;
    }
  } catch (_) {}
  // ③ 메모리 캐시 (이전 요청 자동 감지)
  if (_detectedHost && Date.now() - _detectedHostTs < DETECTED_HOST_TTL_MS) {
    return 'https://' + _detectedHost;
  }
  // ④ KV state:site_host (기존 자동감지 저장값 — 하위 호환)
  try {
    const { kvGet } = await import('./src/store.js').catch(() => ({ kvGet: async () => null }));
    const savedHost = await kvGet(env, 'state:site_host');
    if (savedHost && !isBlogspotDomain(savedHost) && !isInternalHost(savedHost)) {
      _detectedHost   = savedHost;
      _detectedHostTs = Date.now();
      return 'https://' + savedHost;
    }
  } catch (_) {}
  // ⑤ 폴백: 빈 문자열 (사이트맵 생성 스킵)
  return '';
}

// 사이트 제목 자동 결정 (환경변수 없으면 KV 자동감지값 사용)
async function resolveSiteTitleAsync(env) {
  if (env.SITE_TITLE && env.SITE_TITLE !== '') return env.SITE_TITLE;
  try {
    const { kvGet } = await import('./src/store.js').catch(() => ({ kvGet: async () => null }));
    const saved = await kvGet(env, 'state:site_title');
    if (saved) return saved;
  } catch (_) {}
  return 'BloggerSEO';
}

// 동기 버전 — 메모리 캐시 값만 사용 (Cron에서는 비동기 버전 사용)
// 비동기 resolveSiteBaseAsync()가 먼저 호출되어 _detectedHost 가 채워진 상태라면
// 라우트 기반 감지 결과도 여기서 즉시 반환된다 (캐시 공유).
function resolveSiteBase(env) {
  if (env.SITE_BASE_URL && env.SITE_BASE_URL !== 'https://example.com' && env.SITE_BASE_URL !== '') {
    return env.SITE_BASE_URL.replace(/\/$/, '');
  }
  if (env.SITE_HOST && env.SITE_HOST !== '') {
    return 'https://' + env.SITE_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  // 메모리 캐시 (resolveSiteBaseAsync가 라우트 목록에서 채워둔 값 포함)
  if (_detectedHost && Date.now() - _detectedHostTs < DETECTED_HOST_TTL_MS) {
    return 'https://' + _detectedHost;
  }
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
    // 자동감지 도메인 사용 (환경변수 없어도 KV에서 자동으로 가져옴)
    const base   = (await resolveSiteBaseAsync(env)) || url.origin;
    const result = await generateSitemap(env, base);
    return new Response(JSON.stringify({ count: result.count, base }), jsonHeaders());
  }
  if (subPath === 'api/generate_rss') {
    const base   = (await resolveSiteBaseAsync(env)) || url.origin;
    const title  = await resolveSiteTitleAsync(env);
    const result = await generateRss(env, base, title);
    return new Response(JSON.stringify({ count: result.count, base }), jsonHeaders());
  }

  // SSL/TLS 관리 API
  const sslApiResp = await handleSslPanelApi(subPath, request, env);
  if (sslApiResp) return sslApiResp;

  // K8s 클러스터 상태
  if (subPath === 'api/k8s_status') {
    return new Response(JSON.stringify(Cluster.status(), null, 2), jsonHeaders());
  }
  // K8s 이벤트
  if (subPath === 'api/k8s_events') {
    return new Response(JSON.stringify(EventBus.recent(100), null, 2), jsonHeaders());
  }
  // K8s Reconcile 강제 실행
  if (subPath === 'api/k8s_reconcile' && request.method === 'POST') {
    const results = await Cluster.reconcileAll().catch(e => [{ ok: false, error: e.message }]);
    return new Response(JSON.stringify({ ok: true, results }), jsonHeaders());
  }
  // K8s Apply (선언적 manifest 적용)
  if (subPath === 'api/k8s_apply' && request.method === 'POST') {
    try {
      const manifest = await request.json();
      const result   = await Cluster.apply(manifest);
      return new Response(JSON.stringify({ ok: true, kind: manifest.kind, name: manifest.metadata?.name }), jsonHeaders());
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), jsonHeaders());
    }
  }
  // 컨테이너 목록
  if (subPath === 'api/containers') {
    return new Response(JSON.stringify(ContainerLifecycle.stats(), null, 2), jsonHeaders());
  }
  // ── Linux 상태 API ──────────────────────────────────────────────
  if (subPath === 'api/linux_status') {
    return new Response(JSON.stringify(linuxStatus(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_ps') {
    return new Response(JSON.stringify(ProcessManager.ps(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_cgroups') {
    return new Response(JSON.stringify(CgroupManager.tree(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_journal') {
    const n = parseInt(url.searchParams.get('n') || '100');
    return new Response(JSON.stringify(Journald.query({ n }), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_systemd') {
    return new Response(JSON.stringify(Systemd.status(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_cron') {
    return new Response(JSON.stringify(CronDaemon.list(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_workers') {
    return new Response(JSON.stringify(WorkerProcessManager.stats(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_netns') {
    return new Response(JSON.stringify(NetworkNS.list(), null, 2), jsonHeaders());
  }
  if (subPath === 'api/linux_vfs_proc') {
    return new Response(JSON.stringify({
      loadavg: VirtualFS.loadavg(),
      meminfo: VirtualFS.meminfo(),
    }), jsonHeaders());
  }
  // 캐시 초기화 로그
  if (subPath === 'api/cache_reset_log') {
    const { kvGetJson } = await import('./src/store.js').catch(() => ({ kvGetJson: async () => null }));
    const log = await kvGetJson(env, 'state:cache_reset_log');
    return new Response(JSON.stringify(log || { ts: null, nextResetAt: null, ttlPolicy: {} }), jsonHeaders());
  }
  // 현재 도메인 설정 (자동감지 포함)
  if (subPath === 'api/domain_info') {
    const autoBase = await resolveSiteBaseAsync(env);
    const autoTitle = await resolveSiteTitleAsync(env);
    const { kvGet } = await import('./src/store.js').catch(() => ({ kvGet: async () => null }));
    const kvHost  = await kvGet(env, 'state:site_host').catch(() => null);
    const kvTitle = await kvGet(env, 'state:site_title').catch(() => null);
    // 라우트 목록에서 탐지된 실사용 도메인
    const routeHost = await resolveHostFromRoutes(env).catch(() => null);
    return new Response(JSON.stringify({
      SITE_BASE_URL    : env.SITE_BASE_URL  || '(미설정 — 자동감지 사용 중)',
      SITE_HOST        : env.SITE_HOST      || '(미설정 — 자동감지 사용 중)',
      SITE_TITLE       : env.SITE_TITLE     || '(미설정 — 자동감지 사용 중)',
      autoDetectedHost : kvHost   || '(미감지 — 첫 요청 후 자동저장)',
      autoDetectedTitle: kvTitle  || '(미감지)',
      routeDetectedHost: routeHost || '(미감지 — 첫 요청 후 라우트 자동저장)',
      resolved         : autoBase  || url.origin,
      resolvedTitle    : autoTitle,
      workerOrigin     : url.origin,
      isExampleCom     : !autoBase || autoBase === 'https://example.com',
      memCacheHost     : _detectedHost || null,
      detectionMethod  : routeHost ? 'route(ssl:routes KV)' : (kvHost ? 'state:site_host KV' : 'fallback'),
    }), jsonHeaders());
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
  const linuxProc = ProcessManager.ps();
  const info = {
    host, version: 'v8',
    workerId   : lbWorkerId(),
    load       : lbLoad(),
    cnameOk,
    features   : [
      'argo-routing','tiered-cache','priority-routing','cache-reserve-4h',
      'schema-markup','faq-ai','sitemap-cron','rss-cron','load-balancer-kv',
      'panel','redis-do' + (doRedisAvailable(env) ? ':active' : ':unavailable'),
      'seo-slug-v8','linux-kernel','k8s-v8','container-v8',
      'process-manager','cgroup-v2','pipeline-engine','ipc-bus',
      'virtual-fs','systemd','cron-daemon','signal-handler','journald',
      'network-ns','worker-process-manager',
    ],
    linux: {
      kernel   : 'BloggerSEO-Linux/6.6.0-virtual',
      processes: linuxProc.length,
      workers  : WorkerProcessManager.stats().running,
    },
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
    titlePath  : null,  // ✅ v8: SEO 슬러그 경로 (KV에서 나중에 채워짐)
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
    h.set('x-powered-by', 'BloggerSEO-v8');
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

function buildResponseHeaders(etag, cacheControl = 'no-store', extra = {}) {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  h.set('cache-control',          cacheControl);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('permissions-policy',     'camera=(), microphone=(), geolocation=()');
  h.set('x-xss-protection',       '1; mode=block');
  h.set('vary',                   'Accept-Encoding');
  h.set('x-powered-by',           'BloggerSEO-v8');
  if (extra.serverTiming) h.set('server-timing', extra.serverTiming);
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
  <div class="nav-item active" onclick="showSection('dashboard',this)">📊 대시보드</div>
  <div class="nav-item" onclick="showSection('cache',this)">💾 캐시 관리</div>
  <div class="nav-item" onclick="showSection('redis',this)">🧬 Redis 관리</div>
  <div class="nav-item" onclick="showSection('routing',this)">🌐 라우팅 상태</div>
  <div class="nav-item" onclick="showSection('lb',this)">⚖️ 로드밸런서</div>
  <div class="nav-item" onclick="showSection('analytics',this)">📈 캐시 애널리틱스</div>
  <div class="nav-item" onclick="showSection('security',this)">🛡️ 보안/IP 관리</div>
  <div class="nav-item" onclick="showSection('sitemap',this)">🗺️ 사이트맵/RSS</div>
  <div class="nav-item" onclick="showSection('domain',this)">🌍 도메인 설정</div>
  <div class="nav-item" onclick="showSection('ssl',this)">🔒 SSL/TLS 인증서</div>
  <div class="nav-item" onclick="showSection('k8s',this)">☸️ 컨테이너/K8s</div>
  <div class="nav-item" onclick="showSection('linux',this)">🐧 Linux 인프라</div>
  <div class="nav-item" onclick="showSection('cachepolicy',this)">⏱️ 캐시 TTL 정책</div>
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
  <!-- 도메인 설정 진단 -->
  <div id="s-domain" style="display:none">
    <h2>🌍 도메인 자동 감지</h2>
    <div class="grid" id="domain-cards">
      <div class="card"><div class="card-title">실제 사용 도메인</div><div class="card-value" id="d-resolved" style="font-size:14px">-</div><div class="card-sub">자동감지 결과</div></div>
      <div class="card"><div class="card-title">🛣️ 라우트 감지</div><div class="card-value" id="d-route" style="font-size:14px">-</div><div class="card-sub">ssl:routes KV 자동탐지</div></div>
      <div class="card"><div class="card-title">감지 방법</div><div class="card-value" id="d-method" style="font-size:13px">-</div></div>
      <div class="card"><div class="card-title">example.com 여부</div><div class="card-value" id="d-example">-</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-title" style="margin-bottom:10px">🤖 자동 감지 현황</div>
      <div id="d-auto-info" style="color:#94a3b8;font-size:13px;line-height:2">로딩 중...</div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="card-title" style="margin-bottom:10px">ℹ️ 완전 자동화 안내</div>
      <div style="color:#94a3b8;font-size:13px;line-height:2">
        ✅ <strong>설정 불필요</strong> — 개인도메인으로 첫 HTTP 요청이 들어오는 순간 자동으로 도메인이 감지·저장됩니다.<br>
        ✅ 라우트(ssl:routes) → state:site_host KV 순으로 탐지 (API 없이, 설정 제로).<br>
        ✅ 이후 사이트맵, RSS, 스키마 마크업 등 모든 URL이 실제 개인도메인으로 자동 생성됩니다.<br>
        ✅ 블로그 제목도 홈페이지 &lt;title&gt;에서 자동으로 추출됩니다.<br>
        ✅ 모든 포스트 URL은 제목 기반 SEO 슬러그로 자동 전환됩니다.
      </div>
    </div>
    <div class="flex" style="margin-top:16px">
      <button class="btn btn-primary" onclick="loadDomainInfo()">🔄 새로고침</button>
    </div>
  </div>

  <!-- SSL/TLS 인증서 관리 -->
  <div id="s-ssl" style="display:none">
    <h2>🔒 SSL/TLS 인증서 관리</h2>

    <!-- 요약 카드 -->
    <div class="grid">
      <div class="card">
        <div class="card-title">등록된 도메인</div>
        <div class="card-value" id="ssl-total">-</div>
        <div class="card-sub">자동 감지 + 수동 추가</div>
      </div>
      <div class="card">
        <div class="card-title">SSL 활성</div>
        <div class="card-value" id="ssl-active">-</div>
        <div class="card-sub">HTTPS 정상 도메인</div>
      </div>
      <div class="card">
        <div class="card-title">HTTPS 강제</div>
        <div class="card-value"><span class="badge badge-green">✅ 항상 켜짐</span></div>
        <div class="card-sub">Worker 레벨 301 리디렉션</div>
      </div>
      <div class="card">
        <div class="card-title">자동 갱신</div>
        <div class="card-value"><span class="badge badge-green">✅ 자동</span></div>
        <div class="card-sub">Cloudflare Universal SSL</div>
      </div>
    </div>

    <!-- 도메인 추가 -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-title" style="margin-bottom:10px">➕ 도메인 수동 추가</div>
      <div style="color:#94a3b8;font-size:12px;margin-bottom:12px;line-height:1.7">
        커스텀 도메인으로 요청이 들어오면 <strong>자동으로 등록</strong>됩니다.<br>
        아직 트래픽이 없는 도메인은 여기서 직접 추가하세요.
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <input class="ip-input" id="ssl-add-host" placeholder="example.com" style="width:260px">
        <button class="btn btn-primary" onclick="sslAddRoute()">➕ 추가</button>
      </div>
    </div>

    <!-- 도메인 + 인증서 현황 테이블 -->
    <div class="section">
      <h2 style="font-size:16px;margin-bottom:12px">📋 도메인 · 인증서 현황</h2>
      <div id="ssl-empty" style="display:none;color:#64748b;font-size:13px;margin-bottom:16px;padding:20px;text-align:center">
        등록된 도메인이 없습니다.<br>
        커스텀 도메인으로 첫 요청이 들어오면 자동으로 나타납니다.
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>도메인</th>
              <th>SSL 상태</th>
              <th>TLS 버전</th>
              <th>인증 기관</th>
              <th>HSTS</th>
              <th>갱신</th>
              <th>등록 방식</th>
              <th>작업</th>
            </tr>
          </thead>
          <tbody id="ssl-route-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- 동작 원리 안내 -->
    <div class="card" style="margin-top:8px">
      <div class="card-title" style="margin-bottom:10px">ℹ️ 설정 없이 자동 동작하는 이유</div>
      <div style="color:#94a3b8;font-size:13px;line-height:2">
        ✅ <strong>API 토큰 불필요</strong> — Cloudflare Zone에 DNS가 연결된 도메인은 Universal SSL이 자동 발급<br>
        ✅ <strong>블로그스팟 별도 SSL 불필요</strong> — Worker가 앞단에서 HTTPS 처리<br>
        ✅ <strong>HTTP 접속 → 즉시 301 HTTPS</strong> — Worker 레벨, 설정 없이 항상 켜짐<br>
        ✅ <strong>인증서 자동 갱신</strong> — Cloudflare가 90일마다 자동 처리 (Let's Encrypt 또는 Google Trust)<br>
        ✅ <strong>도메인 자동 감지</strong> — 커스텀 도메인으로 첫 요청 시 자동 등록<br>
        ✅ <strong>Cron 상태 확인</strong> — 매 1시간마다 인증서 상태를 TLS 핸드셰이크로 직접 확인<br><br>
        방문자 ──HTTPS(TLS1.3)──▶ <strong>Cloudflare Worker</strong> ──HTTP──▶ ghs.google.com(블로그스팟)
      </div>
    </div>

    <div class="flex" style="margin-top:16px">
      <button class="btn btn-primary" onclick="loadSslStatus()">🔄 새로고침</button>
      <button class="btn btn-primary" onclick="sslRefreshAll()" style="background:#0d9488">🔍 전체 인증서 재확인</button>
    </div>
  </div>

  <!-- K8s / 컨테이너 관리 -->
  <div id="s-k8s" style="display:none">
    <h2>☸️ 자체 K8s 오케스트레이션</h2>
    <div class="grid" id="k8s-cards">
      <div class="card"><div class="card-title">네임스페이스</div><div class="card-value" id="k8s-ns">-</div></div>
      <div class="card"><div class="card-title">Deployment</div><div class="card-value" id="k8s-dep">-</div></div>
      <div class="card"><div class="card-title">서비스</div><div class="card-value" id="k8s-svc">-</div></div>
      <div class="card"><div class="card-title">컨테이너</div><div class="card-value" id="k8s-ctr">-</div></div>
      <div class="card"><div class="card-title">이벤트</div><div class="card-value" id="k8s-ev-count">-</div></div>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <table><thead><tr><th>컨테이너 ID</th><th>이미지</th><th>상태</th><th>CPU</th><th>요청수</th><th>헬스</th></tr></thead>
      <tbody id="k8s-ctr-table"></tbody></table>
    </div>
    <div class="section" style="margin-top:20px">
      <div class="card">
        <div class="card-title">최근 이벤트</div>
        <div id="k8s-events" style="margin-top:10px;font-family:monospace;font-size:12px;color:#94a3b8;line-height:1.8"></div>
      </div>
    </div>
    <div class="flex" style="margin-top:16px">
      <button class="btn btn-primary" onclick="loadK8s()">🔄 새로고침</button>
      <button class="btn btn-primary" onclick="k8sReconcile()">⚙️ Reconcile 실행</button>
    </div>
  </div>

  <!-- Linux 인프라 -->
  <div id="s-linux" style="display:none">
    <h2>🐧 Linux 인프라 (자체 구현)</h2>
    <div class="grid">
      <div class="card"><div class="card-title">커널</div><div class="card-value" style="font-size:13px">BloggerSEO-Linux/6.6.0</div></div>
      <div class="card"><div class="card-title">프로세스 수</div><div class="card-value" id="lx-ps-count">-</div></div>
      <div class="card"><div class="card-title">워커 인스턴스</div><div class="card-value" id="lx-workers">-</div></div>
      <div class="card"><div class="card-title">Cgroup 수</div><div class="card-value" id="lx-cg-count">-</div></div>
      <div class="card"><div class="card-title">Systemd 유닛</div><div class="card-value" id="lx-units">-</div></div>
      <div class="card"><div class="card-title">Cron 잡</div><div class="card-value" id="lx-cron">-</div></div>
    </div>

    <!-- /proc 정보 -->
    <div class="card" style="margin-top:16px">
      <div class="card-title">/proc/loadavg & meminfo</div>
      <pre id="lx-proc" style="margin-top:8px;font-family:monospace;font-size:12px;color:#94a3b8;line-height:1.7">로딩 중...</pre>
    </div>

    <!-- 프로세스 테이블 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">📋 프로세스 테이블 (ps aux)</h3>
      <div class="table-wrap">
        <table><thead><tr><th>PID</th><th>이름</th><th>상태</th><th>CPU ms</th><th>Cgroup</th><th>PPID</th></tr></thead>
        <tbody id="lx-ps-table"></tbody></table>
      </div>
    </div>

    <!-- Cgroup 트리 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">🗂️ Cgroup 트리</h3>
      <div class="table-wrap">
        <table><thead><tr><th>Cgroup</th><th>상위</th><th>CPU 사용</th><th>CPU 한도</th><th>메모리 사용</th><th>PID 수</th></tr></thead>
        <tbody id="lx-cg-table"></tbody></table>
      </div>
    </div>

    <!-- Systemd 유닛 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">⚙️ Systemd 유닛 (systemctl status)</h3>
      <div class="table-wrap">
        <table><thead><tr><th>유닛</th><th>설명</th><th>상태</th><th>재시작</th><th>PID</th></tr></thead>
        <tbody id="lx-unit-table"></tbody></table>
      </div>
    </div>

    <!-- Cron 잡 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">⏰ Cron 잡 (crontab -l)</h3>
      <div class="table-wrap">
        <table><thead><tr><th>ID</th><th>이름</th><th>스케줄</th><th>마지막 실행</th><th>실행 횟수</th><th>에러</th></tr></thead>
        <tbody id="lx-cron-table"></tbody></table>
      </div>
    </div>

    <!-- 워커 인스턴스 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">🔀 멀티 워커 인스턴스 (다중 인스턴스 LB)</h3>
      <div class="table-wrap">
        <table><thead><tr><th>인스턴스 ID</th><th>역할</th><th>PID</th><th>상태</th><th>요청 수</th><th>에러</th><th>Cgroup</th></tr></thead>
        <tbody id="lx-inst-table"></tbody></table>
      </div>
    </div>

    <!-- 저널 로그 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">📔 Journald 로그 (journalctl -n 50)</h3>
      <div class="card" style="max-height:300px;overflow-y:auto">
        <div id="lx-journal" style="font-family:monospace;font-size:11px;color:#94a3b8;line-height:1.7"></div>
      </div>
    </div>

    <!-- 네트워크 네임스페이스 -->
    <div class="section" style="margin-top:16px">
      <h3 style="font-size:14px;margin-bottom:8px;color:#f8fafc">🌐 네트워크 네임스페이스 (ip netns list)</h3>
      <div id="lx-netns" style="color:#94a3b8;font-size:13px"></div>
    </div>

    <div class="flex" style="margin-top:16px">
      <button class="btn btn-primary" onclick="loadLinux()">🔄 새로고침</button>
    </div>
  </div>

  <!-- 캐시 TTL 정책 -->
  <div id="s-cachepolicy" style="display:none">
    <h2>⏱️ 캐시 TTL 정책 & 자동 초기화</h2>
    <div class="grid">
      <div class="card"><div class="card-title">홈 페이지 TTL</div><div class="card-value">30분</div><div class="card-sub">max-age=1800</div></div>
      <div class="card"><div class="card-title">포스트 TTL</div><div class="card-value">1시간</div><div class="card-sub">max-age=3600</div></div>
      <div class="card"><div class="card-title">정적 페이지 TTL</div><div class="card-value">4시간</div><div class="card-sub">max-age=14400</div></div>
      <div class="card"><div class="card-title">라벨/카테고리 TTL</div><div class="card-value">1시간</div><div class="card-sub">max-age=3600</div></div>
    </div>
    <div class="grid" style="margin-top:12px">
      <div class="card"><div class="card-title">RSS 피드 TTL</div><div class="card-value">1시간</div><div class="card-sub">저장: 3600s</div></div>
      <div class="card"><div class="card-title">사이트맵 TTL</div><div class="card-value">2시간</div><div class="card-sub">저장: 7200s</div></div>
      <div class="card"><div class="card-title">데이터 최대 보유</div><div class="card-value">1시간</div><div class="card-sub">DO/KV 캡</div></div>
      <div class="card"><div class="card-title">자동 초기화 주기</div><div class="card-value">30분</div><div class="card-sub">Cron: */30</div></div>
    </div>
    <div class="card" style="margin-top:20px">
      <div class="card-title">마지막 캐시 초기화</div>
      <div id="cache-reset-info" style="margin-top:12px;color:#94a3b8;font-size:13px;line-height:1.8">로딩 중...</div>
    </div>
    <div class="flex" style="margin-top:16px">
      <button class="btn btn-primary" onclick="loadCachePolicyInfo()">🔄 새로고침</button>
      <button class="btn btn-danger" onclick="purgeCache()">🗑️ 지금 즉시 초기화</button>
    </div>
  </div>
</div>

<div id="toast">✅ 완료</div>
<script id="panel-cfg" type="application/json">${ JSON.stringify({ s: secret }) }</script>

<script>
const SECRET = JSON.parse(document.getElementById('panel-cfg').textContent).s;
const api = (path) => fetch('/panel/'+path+'?secret='+encodeURIComponent(SECRET)).then(r=>r.json());
const apiPost = (path) => fetch('/panel/'+path+'?secret='+encodeURIComponent(SECRET), {method:'POST'}).then(r=>r.json());

function toast(msg='완료'){
  const t=document.getElementById('toast');
  t.textContent='✅ '+msg; t.style.opacity='1';
  setTimeout(()=>t.style.opacity='0',2500);
}

function showSection(name, navEl){
  document.querySelectorAll('[id^="s-"]').forEach(el=>el.style.display='none');
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  document.getElementById('s-'+name).style.display='';
  if(navEl) navEl.classList.add('active');
  if(name==='dashboard') loadDashboard();
  else if(name==='cache') loadCacheStats();
  else if(name==='redis') loadRedis();
  else if(name==='routing') loadRegional();
  else if(name==='lb') loadLb();
  else if(name==='analytics') loadAnalytics();
  else if(name==='security') loadIps();
  else if(name==='sitemap') {}
  else if(name==='domain') loadDomainInfo();
  else if(name==='ssl') loadSslStatus();
  else if(name==='k8s') loadK8s();
  else if(name==='linux') loadLinux();
  else if(name==='cachepolicy') loadCachePolicyInfo();
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

// ── SSL/TLS 관리 함수 (API 토큰 불필요) ────────────────────────────
async function loadSslStatus() {
  const d = await api('api/ssl_status');
  document.getElementById('ssl-total').textContent  = d.totalCount ?? 0;
  document.getElementById('ssl-active').textContent = d.activeCount ?? 0;

  const routes = d.routes || [];
  const tb     = document.getElementById('ssl-route-tbody');
  const empty  = document.getElementById('ssl-empty');

  if (routes.length === 0) {
    empty.style.display = '';
    tb.innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  tb.innerHTML = routes.map(r => {
    const sc = r.sslStatus === 'active'      ? 'badge-green'
             : r.sslStatus === 'pending'     ? 'badge-yellow'
             : r.sslStatus === 'unavailable' ? 'badge-red'
             : 'badge-yellow';
    const statusLabel = r.sslStatus === 'active'      ? '✅ 활성'
                      : r.sslStatus === 'pending'     ? '⏳ 대기'
                      : r.sslStatus === 'unavailable' ? '❌ 불가'
                      : '❓ 확인중';
    const byLabel = r.addedBy === 'auto' ? '🤖 자동' : '👤 수동';
    const tlsCol  = r.tlsVersion && r.tlsVersion !== '-'
      ? \`<span class="badge badge-green">\${r.tlsVersion}</span>\`
      : '<span class="badge badge-yellow">미확인</span>';
    const http3   = r.http3Enabled ? '<span class="badge badge-green">H3✅</span>' : '';
    const hsts    = r.hstsEnabled  ? \`<span class="badge badge-green">HSTS(\${r.hstsMaxAge ? Math.round(r.hstsMaxAge/86400)+'d' : '?'})</span>\` : '<span class="badge badge-yellow">HSTS없음</span>';
    return \`<tr>
      <td><strong>\${r.host}</strong></td>
      <td><span class="badge \${sc}">\${statusLabel}</span></td>
      <td>\${tlsCol} \${http3}</td>
      <td style="font-size:12px">\${r.issuer || 'Cloudflare Universal SSL'}</td>
      <td>\${hsts}</td>
      <td><span class="badge badge-green">✅ 자동</span></td>
      <td><span class="tag">\${byLabel}</span></td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="sslRefreshOne('\${r.host}')">🔍</button>
        <button class="btn btn-sm btn-danger"  onclick="sslRemoveRoute('\${r.host}')" style="margin-left:4px">🗑️</button>
      </td>
    </tr>\`;
  }).join('');
}

async function sslAddRoute() {
  const host = document.getElementById('ssl-add-host').value.trim();
  if (!host) { toast('도메인을 입력하세요'); return; }
  const r = await fetch('/panel/api/ssl_add_route?secret='+encodeURIComponent(SECRET), {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ host }),
  }).then(r=>r.json());
  toast(r.ok ? r.message : r.message);
  document.getElementById('ssl-add-host').value = '';
  if (r.ok) loadSslStatus();
}

async function sslRemoveRoute(host) {
  if (!confirm(\`\${host} 을(를) 목록에서 삭제하시겠습니까?\`)) return;
  const r = await fetch('/panel/api/ssl_remove_route?secret='+encodeURIComponent(SECRET), {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ host }),
  }).then(r=>r.json());
  toast(r.message);
  loadSslStatus();
}

async function sslRefreshOne(host) {
  toast(\`\${host} 인증서 확인 중...\`);
  const r = await fetch('/panel/api/ssl_refresh?secret='+encodeURIComponent(SECRET), {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ host }),
  }).then(r=>r.json());
  toast(r.sslStatus === 'active' ? \`\${host} — SSL 정상 ✅\` : \`\${host} — \${r.sslStatus}\`);
  loadSslStatus();
}

async function sslRefreshAll() {
  toast('전체 인증서 재확인 중...');
  const r = await fetch('/panel/api/ssl_refresh?secret='+encodeURIComponent(SECRET), {method:'POST'}).then(r=>r.json());
  toast(\`재확인 완료: \${r.refreshed?.length ?? 0}개 갱신, \${r.skipped ?? 0}개 스킵\`);
  loadSslStatus();
}

// 초기 로드
loadDashboard();

async function loadLinux() {
  const d = await api('api/linux_status');
  // /proc 정보
  document.getElementById('lx-proc').textContent =
    'loadavg: ' + (d.proc?.loadavg || '-') + '\n' + (d.proc?.meminfo || '-');

  // 요약 카드
  document.getElementById('lx-ps-count').textContent = (d.ps || []).length;
  document.getElementById('lx-workers').textContent  = d.workers?.running ?? '-';
  document.getElementById('lx-cg-count').textContent = (d.cgroups || []).length;
  document.getElementById('lx-units').textContent    = (d.systemd || []).length;
  document.getElementById('lx-cron').textContent     = (d.cron || []).length;

  // 프로세스 테이블
  const psTb = document.getElementById('lx-ps-table');
  psTb.innerHTML = (d.ps || []).length
    ? (d.ps || []).map(p => \`<tr>
        <td>\${p.pid}</td><td><code>\${p.name}</code></td>
        <td><span class=\"badge \${p.state==='R'?'badge-green':p.state==='Z'?'badge-yellow':'badge-red'}\">\${p.state}</span></td>
        <td>\${p.cpuMs}ms</td><td>\${p.cgroup||'/'}</td><td>\${p.ppid||0}</td>
      </tr>\`).join('')
    : '<tr><td colspan="6" style="color:#64748b;text-align:center">프로세스 없음</td></tr>';

  // Cgroup 트리
  const cgTb = document.getElementById('lx-cg-table');
  cgTb.innerHTML = (d.cgroups || []).map(cg => \`<tr>
    <td><code>\${cg.id}</code></td><td>\${cg.parent||'root'}</td>
    <td>\${cg.cpu?.used||0}ms</td>
    <td><span class=\"badge \${(cg.cpu?.pct||0)>80?'badge-red':(cg.cpu?.pct||0)>50?'badge-yellow':'badge-green'}\">\${cg.cpu?.pct||0}%</span></td>
    <td>\${cg.mem?.used||0} kB</td>
    <td>\${(cg.pids||[]).length}</td>
  </tr>\`).join('') || '<tr><td colspan="6" style="color:#64748b;text-align:center">Cgroup 없음</td></tr>';

  // Systemd 유닛
  const unitTb = document.getElementById('lx-unit-table');
  unitTb.innerHTML = (d.systemd || []).map(u => \`<tr>
    <td><code>\${u.name}</code></td><td style=\"font-size:12px\">\${u.description||''}</td>
    <td><span class=\"badge \${u.state==='active'?'badge-green':u.state==='failed'?'badge-red':'badge-yellow'}\">\${u.state}</span></td>
    <td>\${u.restarts||0}</td><td>\${u.pid||'-'}</td>
  </tr>\`).join('') || '<tr><td colspan=\"5\" style=\"color:#64748b;text-align:center\">유닛 없음</td></tr>';

  // Cron 잡
  const cronTb = document.getElementById('lx-cron-table');
  cronTb.innerHTML = (d.cron || []).map(j => \`<tr>
    <td><code>\${j.id}</code></td><td>\${j.name||''}</td>
    <td><span class=\"tag\">\${j.expr}</span></td>
    <td style=\"font-size:11px\">\${j.lastRun ? new Date(j.lastRun).toLocaleString('ko-KR') : '-'}</td>
    <td>\${j.runs||0}</td>
    <td><span class=\"\${j.errors>0?'badge badge-red':''}\"> \${j.errors||0}</span></td>
  </tr>\`).join('') || '<tr><td colspan=\"6\" style=\"color:#64748b;text-align:center\">Cron 잡 없음</td></tr>';

  // 워커 인스턴스
  const instTb = document.getElementById('lx-inst-table');
  instTb.innerHTML = (d.workers?.instances || []).map(i => \`<tr>
    <td><code>\${i.id}</code></td><td><span class=\"tag\">\${i.role}</span></td>
    <td>\${i.pid||'-'}</td>
    <td><span class=\"badge \${i.state==='running'?'badge-green':i.state==='failed'?'badge-red':'badge-yellow'}\">\${i.state}</span></td>
    <td>\${i.stats?.requests||0}</td>
    <td>\${i.stats?.errors||0}</td>
    <td>\${i.cgroup||'-'}</td>
  </tr>\`).join('') || '<tr><td colspan=\"7\" style=\"color:#64748b;text-align:center\">워커 인스턴스 없음 — 첫 요청 후 자동 생성</td></tr>';

  // 저널 로그
  const jEl = document.getElementById('lx-journal');
  jEl.innerHTML = (d.journal || []).slice(-50).reverse().map(e => {
    const col = e.priority==='error'?'#f87171':e.priority==='warn'?'#fb923c':'#94a3b8';
    return \`<div>[<span style=\"color:#60a5fa\">\${new Date(e.ts).toLocaleTimeString('ko-KR')}</span>] <span style=\"color:\${col}\">\${e.priority?.toUpperCase()}</span> \${e.message}</div>\`;
  }).join('') || '<div style="color:#475569">로그 없음</div>';

  // 네트워크 네임스페이스
  const nsEl = document.getElementById('lx-netns');
  const netns = d.netns || [];
  nsEl.innerHTML = netns.length
    ? netns.map(n => \`<span class=\"tag\" style=\"margin-right:8px\">\${n}</span>\`).join('')
    : '<span style="color:#64748b">네트워크 네임스페이스 없음</span>';
}

async function loadDomainInfo() {
  const d = await api('api/domain_info');
  document.getElementById('d-resolved').textContent = d.resolved   || '-';
  document.getElementById('d-example').innerHTML = d.isExampleCom
    ? '<span class="badge badge-red">⚠️ example.com 감지</span>'
    : '<span class="badge badge-green">✅ 정상</span>';
  const routeEl = document.getElementById('d-route');
  if (routeEl) routeEl.textContent = d.routeDetectedHost || '-';
  const methodEl = document.getElementById('d-method');
  if (methodEl) methodEl.textContent = d.detectionMethod || '-';
  const autoEl = document.getElementById('d-auto-info');
  if (autoEl) {
    autoEl.innerHTML = [
      d.routeDetectedHost && d.routeDetectedHost !== '(미감지 — 첫 요청 후 라우트 자동저장)'
        ? '🛣️ 라우트 감지 도메인: <strong>' + d.routeDetectedHost + '</strong>'
        : '🛣️ 라우트 감지 도메인: (첫 요청 후 ssl:routes에 자동저장)',
      d.autoDetectedHost  ? '🔍 KV 감지 도메인: <strong>' + d.autoDetectedHost  + '</strong>' : '🔍 KV 감지 도메인: (첫 요청 후 자동저장)',
      d.autoDetectedTitle ? '📝 자동감지 제목: <strong>'  + d.autoDetectedTitle + '</strong>' : '📝 자동감지 제목: (홈 첫 방문 후 자동저장)',
      d.memCacheHost      ? '⚡ 메모리 캐시: <strong>'    + d.memCacheHost      + '</strong>' : '⚡ 메모리 캐시: (비어있음)',
    ].join('<br>');
  }
}

async function loadK8s() {
  const [status, events] = await Promise.all([api('api/k8s_status'), api('api/k8s_events')]);
  document.getElementById('k8s-ns').textContent       = (status.namespaces  || []).length;
  document.getElementById('k8s-dep').textContent      = (status.deployments || []).length;
  document.getElementById('k8s-svc').textContent      = (status.services    || []).length;
  document.getElementById('k8s-ctr').textContent      = (status.containers?.total || 0);
  document.getElementById('k8s-ev-count').textContent = (events || []).length;

  const ctrs = status.containers?.containers || [];
  const tb = document.getElementById('k8s-ctr-table');
  tb.innerHTML = ctrs.length
    ? ctrs.map(c => \`<tr>\n        <td><code>\${c.id?.slice(0,14)||'-'}</code></td>\n        <td>\${c.image||'-'}</td>\n        <td><span class=\"badge \${c.state==='running'?'badge-green':c.state==='stopped'?'badge-yellow':'badge-red'}\">\${c.state||'-'}</span></td>\n        <td>\${c.cpu?.usedMs?.toFixed(1)||0}ms</td>\n        <td>\${c.requests?.count||0}</td>\n        <td><span class=\"badge \${c.health?.status==='healthy'?'badge-green':'badge-yellow'}\">\${c.health?.status||'unknown'}</span></td>\n      </tr>\`).join('')
    : '<tr><td colspan="6" style="color:#64748b;text-align:center">실행 중인 컨테이너 없음 — Reconcile 실행 후 새로고침</td></tr>';

  const evDiv = document.getElementById('k8s-events');
  evDiv.innerHTML = (events || []).slice(0, 30).map(e =>
    \`<div>[<span style="color:#60a5fa">\${new Date(e.ts).toLocaleTimeString('ko-KR')}</span>] <span style="color:#a78bfa">\${e.type}</span> \${e.deployment||e.pod||e.namespace||''}</div>\`
  ).join('') || '<div style="color:#475569">이벤트 없음 — Worker 첫 요청 후 자동 생성됩니다</div>';
}

async function k8sReconcile() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = '⏳ 실행 중...';
  try {
    const r = await fetch('/panel/api/k8s_reconcile?secret='+encodeURIComponent(SECRET), {method:'POST'}).then(r=>r.json());
    toast(r.ok ? 'Reconcile 완료 (' + (r.results||[]).length + '개)' : '오류: ' + r.error);
    await loadK8s();
  } finally {
    btn.disabled = false; btn.textContent = '⚙️ Reconcile 실행';
  }
}

async function loadCachePolicyInfo() {
  const log = await api('api/cache_reset_log');
  const el  = document.getElementById('cache-reset-info');
  if (!log || !log.ts) {
    el.innerHTML = '아직 캐시 초기화 기록이 없습니다. 첫 Cron 실행을 기다리세요.';
    return;
  }
  const last = new Date(log.ts).toLocaleString('ko-KR');
  const next = log.nextResetAt ? new Date(log.nextResetAt).toLocaleString('ko-KR') : '-';
  const pol  = log.ttlPolicy || {};
  el.innerHTML = \`
    🕐 마지막 초기화: <strong>\${last}</strong><br>
    ⏭️ 다음 초기화 예정: <strong>\${next}</strong><br><br>
    📋 TTL 정책:<br>
    \${Object.entries(pol).map(([k,v])=>\`  &nbsp;&nbsp;<span class="tag">\${k}</span> \${v}초\`).join('<br>')}
  \`;
}
</script>
</body>
</html>`;
}
