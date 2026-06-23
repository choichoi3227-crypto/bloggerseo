/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * - blogspot.com 원본 탐지 없음
 * - 리다이렉트 추적 없음 (redirect: 'manual')
 * - cf.resolveOverride: 'ghs.google.com' 으로 DNS 우회
 * - CNAME 검증 실패해도 차단하지 않음 (soft 검증)
 * - 525 등 SSL 에러 방지
 *
 * [수정 내역]
 * 1. 슬러그: /yyyy/mm/원본.html → /제목기반슬러그 로 완전 평탄화
 *    (날짜 경로와 .html 확장자 모두 제거하고 제목 슬러그로 전체 교체)
 * 2. 캐싱: HTML(KV Cache Reserve) 캐싱을 완전히 비활성화함.
 *    메뉴 드롭다운, 검색, 위젯 효과 등 Blogger JS 동작은 매 요청마다
 *    Blogger가 새로 내려주는 동적 마크업/초기화 데이터에 의존하는데,
 *    HTML 스냅샷을 캐싱하면 이 데이터가 고정되어 동작이 깨짐.
 *    이제 HTML은 항상 origin에서 가져와 SEO 태그만 매번 주입하고
 *    응답에 cache-control: no-store를 명시해 브라우저/CDN에도 안 쌓이게 함.
 *    대신 정적 자산(js/css/이미지/폰트/feed/sitemap)은 origin 헤더를 따르되,
 *    origin이 약한 캐시 헤더를 주는 경우 최소 1일 캐시를 보장해 사용자가
 *    체감하는 로딩 속도는 유지함.
 * 3. 에러 수정: 위젯(검색/메뉴 등) 동작을 깨던 강제 <script defer> 주입 제거,
 *    alias 슬러그와 다른 라우트(/p/, /search, sitemap, 정적 자산 등) 충돌 방지,
 *    정규식/디코딩 관련 예외 방어 강화.
 * 4. 멀티테넌트 도메인 격리 (Durable Objects 기반):
 *    여러 Blogger 커스텀 도메인을 이 워커 하나가 처리하므로, 도메인(host)별로
 *    Durable Object 인스턴스 하나씩을 자동 배정(idFromName(host))해 "도메인별
 *    격리된 작은 컨테이너"처럼 동작시킴 (쿠버네티스의 pod-per-tenant와 유사한
 *    개념을 Workers 네이티브 방식으로 구현):
 *      - 동시성 제어: 도메인당 동시 origin 요청 수를 제한해, 한 도메인의
 *        트래픽 폭주가 다른 도메인에 영향을 주지 않도록 격리(노이지 네이버 방지)
 *      - 헬스 상태/서비스 디스커버리: 도메인별 연속 실패율을 추적해 불안정한
 *        도메인은 빠르게 circuit-break, 일정 시간 후 자동 half-open 복구 시도
 *    실제 컨테이너/쿠버네티스를 Worker 안에서 구동하는 것은 런타임 모델상
 *    불가능하므로(영속 프로세스/디스크 없음), 같은 격리·복구 목표를 Durable
 *    Objects로 달성함. wrangler.toml 설정은 파일 하단 주석 참고.
 * 5. 이미지/파일 전송 최적화:
 *    Blogger 이미지 URL의 네이티브 리사이즈 파라미터(=s###, =w###-h###)를
 *    이용해 반응형 srcset/sizes를 자동 생성. WebSocket은 Blogger origin이
 *    WebSocket 서버가 아니라 적용 대상이 없어 이번 변경에 포함하지 않음.
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
// [수정] HTML 본문 캐싱(KV Cache Reserve) 관련 TTL 상수 전체 제거.
// HTML은 더 이상 캐싱하지 않고 항상 origin 직통 + no-store 응답.
const CNAME_CACHE_TTL = 24 * 3600 * 1000; // CNAME(DoH) 조회 결과는 계속 캐싱 (변하지 않는 DNS 정보)
const SLUG_CHECK_MS   = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY    = 0.25;
const LB_RTT_TTL      = 60;
const GHS_TARGET      = 'ghs.google.com';
const DOH_URL         = 'https://1.1.1.1/dns-query';

// [추가] 도메인별 격리(Durable Object: TenantCoordinator) 관련 설정
const TENANT_MAX_CONCURRENCY   = 24;    // 도메인 하나당 동시 origin fetch 허용 수
const TENANT_FAILURE_THRESHOLD = 5;     // 연속 실패 이 횟수 넘으면 circuit-break
const TENANT_OPEN_COOLDOWN_MS  = 15000; // circuit-break 유지 시간(half-open 전환까지)

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvCname = h => 'cname_ok:' + h;
const kvRtt   = h => 'lb:rtt:'   + h;
const kvBw    = h => 'lb:bw:'    + h;

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return errResp(502, 'Worker exception: ' + String((e && e.message) || e));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env).catch(() => {}));
  },
};

async function handleFetch(request, env, ctx) {
  const url  = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;

  // ── 디버그 엔드포인트 /__blogger_debug ────────
  if (path === '/__blogger_debug') {
    return safeStep(() => bloggerDebug(url, env), () => errResp(502, 'Debug failed'));
  }

  // ── 캐시 전체 purge: /__purge_all ────────────
  if (path === '/__purge_all') {
    return safeStep(() => purgeAll(env), () => errResp(502, 'Purge failed'));
  }

  // ── CNAME 검증 (soft: 실패해도 차단 안 함, 로그만) ──
  ctx.waitUntil(warmCnameCache(host, env).catch(() => {}));

  // ── 1. 정적 자산 / Feed / Sitemap 직통 ──────
  // [수정] sitemap/feed 등은 슬러그 라우팅보다 먼저 확정해 충돌 방지.
  // 정적 자산이므로 캐시 강화(isStaticAsset=true) 적용
  if (isPassthrough(path, url)) {
    return proxyPass(url, request, env, true);
  }

  // ── 2. 캐시 우회 판별 ────────────────────────
  const bypassCache = shouldBypassCache(request, url, path);

  // purge 모드: KV에서 해당 키 삭제 후 origin에서 새로 가져옴
  if (bypassCache && url.searchParams.get('purge') === '1') {
    try {
      const cacheKey = buildCacheKey(url);
      await deleteCacheReserve(cacheKey, env);
    } catch (_) {}
    const clean = new URL(url.toString());
    clean.searchParams.delete('purge');
    return Response.redirect(clean.toString(), 302);
  }

  // 캐시 우회: origin 직통
  if (bypassCache) {
    return proxyPass(url, request, env);
  }

  // ── 3. 슬러그 라우팅 ──────────────────────────
  let slugRoute;
  try {
    slugRoute = await resolveSlugRoute(path, url, env);
  } catch (_) {
    slugRoute = { type: 'passthrough' };
  }

  if (slugRoute.type === 'redirect') {
    // 원본 blogspot 경로 → 제목 슬러그 경로(평탄화)로 301
    const dest = new URL(url.toString());
    dest.pathname = slugRoute.titlePath;
    return Response.redirect(dest.toString(), 301);
  }

  // alias 경로(제목 슬러그)로 들어온 요청:
  // KV에서 찾은 원본 경로로 내부 fetch하되 응답 URL은 슬러그 그대로 유지
  let fetchUrl = url;
  if (slugRoute.type === 'alias') {
    fetchUrl = new URL(url.toString());
    fetchUrl.pathname = slugRoute.originPath;
  }

  // ── 4. Origin Fetch ──────────────────────────
  // [수정] HTML KV 캐시(Cache Reserve) 비활성화. Blogger 위젯(메뉴/검색/효과 등)이
  // 매 요청마다 새로 생성되는 동적 마크업에 의존하므로, HTML은 항상 origin에서
  // 새로 받아와야 함. 캐시 키만 유지해 두 가지 보조 기능에 재사용:
  //   - /__purge_all, ?purge=1 호환을 위해 buildCacheKey는 그대로 둠 (no-op이지만
  //     기존 운영 스크립트/북마크가 깨지지 않도록 안전하게 유지)
  const cacheKey = buildCacheKey(url);

  // [추가] 도메인별 동시성/헬스 격리 (TenantCoordinator DO). 바인딩이 없으면
  // 항상 ok:true로 통과하므로 기존 동작에 영향 없음.
  const tenant = await tenantAcquire(host, env);
  if (!tenant.ok) {
    return errResp(503, 'Tenant busy/unstable: ' + (tenant.reason || 'unknown'));
  }

  let originResp;
  let originSuccess = false;
  const t0 = Date.now();
  try {
    originResp = await bloggerFetch(fetchUrl, 'GET', request.headers, true); // [수정] HTML: edge 캐시 우회
    originSuccess = originResp.status < 500;
  } catch (e) {
    ctx.waitUntil(tenantRelease(tenant.stub, false));
    return errResp(502, 'Fetch failed: ' + String((e && e.message) || e));
  }
  ctx.waitUntil(tenantRelease(tenant.stub, originSuccess));
  const rtt = Date.now() - t0;
  ctx.waitUntil(lbRecordRtt(host, rtt, env).catch(() => {}));

  // 3xx: 리다이렉트 그대로 반환 (루프 방지)
  if (originResp.status >= 300 && originResp.status < 400) {
    return stripInternalHeaders(originResp);
  }

  if (originResp.status >= 500) return errResp(originResp.status, 'Origin error ' + originResp.status);
  if (!isHtml(originResp) || !originResp.ok) return stripInternalHeaders(originResp);

  // ── 6. HTML 파이프라인 ────────────────────────
  let html;
  try {
    html = await originResp.text();
  } catch (e) {
    return errResp(502, 'Body read failed: ' + String((e && e.message) || e));
  }

  let result = html;
  let pageCtx = null;
  try {
    pageCtx = extractPageContext(html, url);
    result  = transformHtml(html, pageCtx, url);
    if (!result || typeof result !== 'string') result = html; // [수정] 변환 결과 무결성 보장
  } catch (_) {
    result = html;   // 변환 실패 시 원본 HTML 그대로 응답 (서비스 중단 방지)
    pageCtx = null;
  }

  // ── 7. 비동기 후처리 (모두 방어적, 실패해도 응답에 영향 없음) ──
  // [수정] HTML 본문 KV 저장(setCacheReserve) 제거 — 캐싱된 스냅샷이 위젯 동작을
  // 깨뜨리는 원인이었으므로, 슬러그 등록과 LB 통계만 비동기로 남김
  const respHeaders = buildResponseHeaders();
  if (pageCtx) ctx.waitUntil(updateSlugKV(pageCtx, url, env).catch(() => {}));
  ctx.waitUntil(lbRecordBandwidth(host, result.length, env).catch(() => {}));

  return new Response(result, { status: 200, headers: respHeaders });
}

async function safeStep(fn, onError) {
  try {
    return await fn();
  } catch (e) {
    return onError(e);
  }
}

// ─────────────────────────────────────────────
// 캐시 우회 판별
// ─────────────────────────────────────────────
function shouldBypassCache(request, url, path) {
  if (!['GET', 'HEAD'].includes(request.method)) return true;
  if (url.searchParams.get('purge') === '1') return true;
  if (request.headers.get('cache-control') === 'no-cache') return true;
  if (path.startsWith('/b/'))          return true;  // Blogger 관리 패널
  if (path.startsWith('/admin'))       return true;
  if (path === '/ncr')                 return true;
  if (url.searchParams.has('blogedit'))  return true;
  if (url.searchParams.has('postID'))    return true;
  if (url.searchParams.has('action'))    return true;
  if (url.searchParams.has('widgetType')) return true;
  if (path.startsWith('/search') && url.searchParams.has('q')) return true;
  return false;
}

// ─────────────────────────────────────────────
// 전체 캐시 purge
// [수정] HTML을 더 이상 KV에 저장하지 않으므로, 이 엔드포인트는 과거 버전에서
// 이미 저장된 잔존 캐시 엔트리(meta:*, body:*)를 정리하는 1회성 청소 용도로만
// 의미가 있음. 신규 데이터는 더 이상 쌓이지 않음.
// ─────────────────────────────────────────────
async function purgeAll(env) {
  // [수정] CACHE_RESERVE_KV는 더 이상 필수 바인딩이 아님(HTML을 KV에 저장하지
  // 않으므로). 바인딩이 없어도 500 에러 대신 "정리할 것 없음"으로 정상 응답.
  if (!env.CACHE_RESERVE_KV) {
    return new Response(JSON.stringify({ purged: 0, note: 'CACHE_RESERVE_KV not bound; HTML caching is disabled, nothing to purge' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  try {
    let deleted = 0;
    let cursor;
    do {
      const listed = await env.CACHE_RESERVE_KV.list({ prefix: 'meta:', cursor });
      for (const key of listed.keys) {
        const bodyKey = 'body:' + key.name.slice('meta:'.length);
        await env.CACHE_RESERVE_KV.delete(key.name).catch(() => {});
        await env.CACHE_RESERVE_KV.delete(bodyKey).catch(() => {});
        deleted++;
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
    return new Response(JSON.stringify({ purged: deleted }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return errResp(500, 'Purge failed: ' + String((e && e.message) || e));
  }
}

// ─────────────────────────────────────────────
// CNAME 캐시 워밍 (soft, 차단 안 함)
// ─────────────────────────────────────────────
async function warmCnameCache(host, env) {
  if (!env.SLUG_KV) return;
  try {
    const raw = await env.SLUG_KV.get(kvCname(host));
    if (raw !== null) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      if (parsed && Date.now() - parsed.ts < CNAME_CACHE_TTL) return;
      env.SLUG_KV.delete(kvCname(host)).catch(() => {});
    }
    const ok = await checkCnameGhs(host);
    await env.SLUG_KV.put(
      kvCname(host),
      JSON.stringify({ ok, ts: Date.now() }),
      { expirationTtl: 86400 }
    );
  } catch (_) {}
}

// ─────────────────────────────────────────────
// CNAME 확인 (DoH)
// ─────────────────────────────────────────────
async function checkCnameGhs(host) {
  let current = host;
  const seen  = new Set();
  for (let i = 0; i < 10; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    let cname;
    try { cname = await dnsCname(current); } catch (_) { break; }
    if (!cname) break;
    const normalized = cname.replace(/\.$/, '').toLowerCase();
    if (normalized === GHS_TARGET) return true;
    current = normalized;
  }
  return false;
}

async function dnsCname(host) {
  try {
    const resp = await fetch(
      `${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`,
      { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !Array.isArray(data.Answer)) return null;
    const rec = data.Answer.find(r => r.type === 5);
    return rec ? String(rec.data) : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────
// Blogger fetch
// [수정] bypassEdgeCache 파라미터 추가: HTML 페이지 요청에서만 Cloudflare
// edge 캐시를 명시적으로 우회하고, 정적 자산(js/css/이미지 등)은 origin이
// 보내는 캐시 헤더를 그대로 따르도록(기본 동작) 분리.
// ─────────────────────────────────────────────
async function bloggerFetch(url, method, reqHeaders, bypassEdgeCache) {
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs = params.toString() ? '?' + params.toString() : '';

  const targetUrl = url.origin + url.pathname + qs;

  const headers = new Headers();
  for (const [k, v] of reqHeaders.entries()) {
    const kl = k.toLowerCase();
    if (kl === 'host')            continue;
    if (kl.startsWith('cf-'))     continue;
    if (kl === 'x-forwarded-for') continue;
    if (kl === 'x-real-ip')       continue;
    headers.set(k, v);
  }
  headers.set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

  const cf = { resolveOverride: GHS_TARGET };
  if (bypassEdgeCache) {
    // HTML이 Cloudflare 자체 edge 캐시에 걸리지 않도록 명시적으로 우회.
    // KV 캐시를 꺼도 Cloudflare가 origin 응답을 자체적으로 캐싱하면 동일한
    // 문제(메뉴/위젯 동작 깨짐)가 재발하므로 fetch 단계에서부터 차단.
    cf.cacheTtl = 0;
    cf.cacheEverything = false;
  }

  return fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : null,
    redirect: 'manual',
    cf,
  });
}

// ─────────────────────────────────────────────
// 디버그
// ─────────────────────────────────────────────
async function bloggerDebug(url, env) {
  const host = url.hostname;
  let status = 0, ok = false, errorMsg = null;
  try {
    const resp = await fetch(url.origin + '/', {
      method: 'HEAD',
      headers: { 'user-agent': 'Mozilla/5.0' },
      redirect: 'manual',
      cf: { resolveOverride: GHS_TARGET },
    });
    status = resp.status;
    ok = resp.ok || resp.status === 301 || resp.status === 302;
  } catch (e) {
    errorMsg = String((e && e.message) || e);
  }

  let cnameOk = null;
  if (env.SLUG_KV) {
    try {
      const raw = await env.SLUG_KV.get(kvCname(host));
      if (raw) cnameOk = JSON.parse(raw).ok;
    } catch (_) {}
  }

  const tenant = await tenantStatus(host, env);

  const info = {
    host,
    resolveOverride: GHS_TARGET,
    ghsStatus: status,
    ok,
    cnamePointsToGhs: cnameOk,
    htmlCaching: 'disabled',                       // HTML은 항상 origin 직통, no-store
    staticAssetCaching: 'public, max-age=86400',   // js/css/이미지/폰트 등은 최소 1일 캐시 보장
    tenant,                                         // [추가] 도메인별 동시성/헬스 상태(TenantCoordinator DO)
    ...(errorMsg ? { error: errorMsg } : {}),
    message: errorMsg
      ? 'ERROR: fetch 실패: ' + errorMsg
      : ok
        ? 'OK: ghs.google.com resolveOverride 정상 동작'
        : 'FAIL: 응답 이상 (status=' + status + '). Blogger 커스텀 도메인 설정을 확인하세요.',
  };
  return new Response(JSON.stringify(info, null, 2), {
    status: ok ? 200 : 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ─────────────────────────────────────────────
// 프록시 유틸
// [수정] isStaticAsset=true(JS/CSS/이미지/폰트 등 isPassthrough 대상)일 때만
// 장기 캐시 헤더를 보강. HTML 경로(캐시 우회로 들어온 /b/, /admin 등)는
// 절대 영향받지 않도록 분리.
// ─────────────────────────────────────────────
async function proxyPass(url, request, env, isStaticAsset) {
  try {
    const resp = await bloggerFetch(url, request.method, request.headers);
    return stripInternalHeaders(resp, isStaticAsset);
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + String((e && e.message) || e));
  }
}

function stripInternalHeaders(resp, isStaticAsset) {
  try {
    const h = new Headers(resp.headers);
    h.delete('cf-cache-status');
    h.delete('cf-ray');
    h.delete('nel');
    h.delete('report-to');
    h.delete('server');
    // [수정] 정적 자산만 장기 캐시 보강. origin이 캐시 헤더를 약하게 주거나
    // 안 주는 경우를 대비해 최소 1일 캐시를 보장 (HTML과는 완전히 분리된 정책).
    if (isStaticAsset && resp.ok) {
      const existing = h.get('cache-control') || '';
      if (!existing || /no-store|no-cache|max-age=0/i.test(existing)) {
        h.set('cache-control', 'public, max-age=86400, stale-while-revalidate=3600');
      }
      // [추가] 파일 전송 최적화: Accept-Encoding 기준으로 압축 변형이 캐시되도록
      // Vary를 보강. 누락 시 일부 CDN/브라우저가 압축 안 된 응답을 잘못 캐싱해
      // 전송량이 커지는 문제를 방지.
      const vary = h.get('vary') || '';
      if (!/accept-encoding/i.test(vary)) {
        h.set('vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding');
      }
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  } catch (_) {
    return resp;
  }
}

function errResp(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type':  'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-error':       String(message).slice(0, 500),
    },
  });
}

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/'))               return true;
  if (path === '/atom.xml')                     return true;
  if (path === '/rss.xml')                      return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path))  return true;
  if (url.searchParams.has('alt'))              return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─────────────────────────────────────────────
// Cache Reserve (KV) — [수정] HTML 본문 캐싱 완전 비활성화
//
// 더 이상 HTML을 KV에 저장/조회하지 않음 (메뉴/드롭다운 등 위젯 JS가
// 매 요청마다 origin이 새로 생성하는 동적 데이터에 의존하기 때문).
// buildCacheKey/deleteCacheReserve는 기존 ?purge=1 호환과, 과거에
// 저장된 잔여 KV 엔트리를 정리하기 위한 목적으로만 유지.
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const s = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (s.toString() ? '?' + s : '');
}

// [수정] HTML을 더 이상 KV에 캐싱하지 않으므로 이 함수는 과거 잔존 엔트리를
// 정리하는 용도로만 남김. ?purge=1 요청이 들어와도 실제로는 origin에서 항상
// 새로 받아오기 때문에 동작상 차이는 없으나, 구버전에서 남은 KV 키가 있다면 삭제됨.
async function deleteCacheReserve(key, env) {
  if (!env.CACHE_RESERVE_KV) return;
  try {
    await env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
    await env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 라우팅 [수정: 완전 평탄화]
//
// KV 구조:
//   origin:{originPath}  → { title, titleSlug, titlePath, createdAt, checkedAt }
//     원본 blogspot 경로(/yyyy/mm/x.html 또는 /p/x) → 평탄화된 제목 슬러그 경로(/제목, 확장자 없음)
//
//   alias:{titlePath}    → originPath
//     평탄화된 슬러그 경로 → 원본 경로 역방향 매핑
//
// 동작:
//   원본 경로(/yyyy/mm/...html, /p/...) 요청 → 평탄화된 /제목 경로로 301
//   평탄화된 슬러그 경로 요청 → 원본 경로로 내부 fetch (URL은 슬러그 그대로 유지)
// ─────────────────────────────────────────────

function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

// [수정] 슬러그 경로 충돌 방지: passthrough 대상이나 예약 경로와 겹치지 않게 검증
function isReservedFlatPath(p) {
  if (p === '/') return true;
  if (p === '')  return true;
  if (p.startsWith('/feeds/'))         return true;
  if (p.startsWith('/b/'))             return true;
  if (p.startsWith('/admin'))          return true;
  if (p.startsWith('/search'))         return true;
  if (p === '/ncr')                    return true;
  if (p === '/__blogger_debug')        return true;
  if (p === '/__purge_all')            return true;
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(p)) return true;
  if (p === '/atom.xml' || p === '/rss.xml') return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json|html?)$/i.test(p)) return true;
  return false;
}

// 평탄화된 슬러그 경로 생성: /[titleSlug] ([수정] .html 확장자 제거, 날짜/디렉토리 구조도 제거)
function buildFlatTitlePath(titleSlug) {
  return '/' + titleSlug;
}

// 요청 경로의 슬러그 라우팅 타입 반환
//   { type: 'redirect', titlePath }  → 원본 경로, 평탄화된 제목 슬러그로 301
//   { type: 'alias',    originPath } → 평탄화된 슬러그 경로, 원본으로 내부 fetch
//   { type: 'passthrough' }          → 처리 없이 통과
async function resolveSlugRoute(path, url, env) {
  if (!env.SLUG_KV) return { type: 'passthrough' };

  // 1. 원본(날짜형) 경로로 들어온 요청인지 확인 → 평탄화된 슬러그로 리다이렉트
  if (isPostPath(path)) {
    try {
      const rec = await env.SLUG_KV.get('origin:' + path, { type: 'json' });
      if (rec && rec.titlePath && rec.titlePath !== path) {
        return { type: 'redirect', titlePath: rec.titlePath };
      }
    } catch (_) {}
    return { type: 'passthrough' };
  }

  // 2. 평탄화된 슬러그 경로(/제목)로 들어온 요청인지 확인
  //    [수정] .html 확장자 없는 단일 세그먼트 경로(/foo)만 alias 대상으로 취급.
  //    슬래시가 더 있는 경로(/p/x, /2024/01/x.html)나 예약 경로는 절대 가로채지 않음
  if (/^\/[^/]+$/.test(path) && !isReservedFlatPath(path)) {
    try {
      const originPath = await env.SLUG_KV.get('alias:' + path);
      if (originPath && originPath !== path) {
        return { type: 'alias', originPath };
      }
    } catch (_) {}
  }

  return { type: 'passthrough' };
}

// HTML fetch 후 슬러그 KV 등록/갱신
async function updateSlugKV(pageCtx, url, env) {
  if (!env.SLUG_KV) return;
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;

  const originPath = url.pathname;

  // 이미 평탄화된 슬러그 경로로 직접 접근한 경우(= alias 통해서 들어온 게 아니라
  // origin 자체가 평탄화된 경로) 등록 대상에서 제외
  if (!isPostPath(originPath)) return;

  const titleSlug = generateSlug(pageCtx.title);
  const titlePath = buildFlatTitlePath(titleSlug); // [수정] 날짜 경로 제거, 완전 평탄화

  if (isReservedFlatPath(titlePath)) return; // 안전장치: 예약 경로와 충돌 시 등록 스킵

  try {
    const existing = await env.SLUG_KV.get('origin:' + originPath, { type: 'json' });
    const now = Date.now();

    if (!existing) {
      await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({
        title: pageCtx.title, titleSlug, titlePath, createdAt: now, checkedAt: now,
      }));
      await env.SLUG_KV.put('alias:' + titlePath, originPath);
    } else {
      const newSlug      = generateSlug(pageCtx.title);
      const newTitlePath = buildFlatTitlePath(newSlug);

      if (newTitlePath !== existing.titlePath) {
        await env.SLUG_KV.delete('alias:' + existing.titlePath).catch(() => {});
        await env.SLUG_KV.put('alias:' + newTitlePath, originPath);
        await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({
          ...existing, title: pageCtx.title, titleSlug: newSlug, titlePath: newTitlePath, checkedAt: now,
        }));
      } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
        await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({ ...existing, checkedAt: now }));
      }
    }
  } catch (_) {}
}

async function runSlugAudit(env) {
  if (!env.SLUG_KV) return;
  try {
    const list = await env.SLUG_KV.list({ prefix: 'origin:' });
    const now  = Date.now();
    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data || now - data.checkedAt < SLUG_CHECK_MS) continue;
        const newSlug      = generateSlug(data.title);
        const originPath   = key.name.replace(/^origin:/, '');
        const newTitlePath = buildFlatTitlePath(newSlug); // [수정] 평탄화 경로 기준
        if (newTitlePath !== data.titlePath) {
          await env.SLUG_KV.delete('alias:' + data.titlePath).catch(() => {});
          await env.SLUG_KV.put('alias:' + newTitlePath, originPath);
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, titleSlug: newSlug, titlePath: newTitlePath, checkedAt: now }));
        } else {
          await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, checkedAt: now }));
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 생성
// ─────────────────────────────────────────────
function generateSlug(title) {
  if (!title) return 'untitled';
  try {
    let s = title.trim().toLowerCase()
      .replace(/\s+/g, '-').replace(/_+/g, '-')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
      .replace(/[^\p{L}\p{N}\-]/gu, '-')
      .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    if (/[^\x00-\x7F]/.test(s)) {
      s = encodeURIComponent(s).replace(/%20/g, '-').replace(/%2F/gi, '-');
    }
    return s || 'post';
  } catch (_) {
    return 'post';
  }
}

// ─────────────────────────────────────────────
// LB 기록
// ─────────────────────────────────────────────
async function lbRecordRtt(host, rttMs, env) {
  if (!env.SLUG_KV) return;
  try {
    const prev = await env.SLUG_KV.get(kvRtt(host), { type: 'json' });
    const ewma = prev && typeof prev.rtt === 'number'
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await env.SLUG_KV.put(kvRtt(host), JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

async function lbRecordBandwidth(host, bytes, env) {
  if (!env.SLUG_KV) return;
  try {
    const raw = await env.SLUG_KV.get(kvBw(host));
    const prev = parseInt(raw || '0', 10) || 0;
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await env.SLUG_KV.put(kvBw(host), String(next), { expirationTtl: 86400 });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인
// [수정] script defer 강제 주입 제거 → 위젯(검색/메뉴 등) 동작 보존
// ─────────────────────────────────────────────
function transformHtml(html, ctx, url) {
  let o = html;
  o = safeTransform(o, stripMobileParam);
  o = safeTransform(o, enforceHttps);
  o = safeTransform(o, h => injectMetaDescription(h, ctx));
  o = safeTransform(o, h => injectCanonical(h, ctx, url));
  o = safeTransform(o, h => injectSchemaMarkup(h, ctx, url));
  o = safeTransform(o, h => injectSeoTags(h, ctx));
  o = safeTransform(o, injectPerformanceOptimizations);
  o = safeTransform(o, injectResponsiveImages); // [추가] 이미지 전송 최적화: 반응형 srcset
  return o;
}

// [수정] 각 변환 단계를 개별적으로 방어하여, 한 단계 실패가 전체 파이프라인을
// 무너뜨리지 않고 직전 단계 결과를 그대로 유지하도록 함
function safeTransform(html, fn) {
  try {
    const out = fn(html);
    return (typeof out === 'string' && out.length > 0) ? out : html;
  } catch (_) {
    return html;
  }
}

function stripMobileParam(html) {
  return html
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+&/gi, '$1?')
    .replace(/((?:href|src|action)=["'][^"']*)&m=\d+/gi,   '$1')
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+/gi,  '$1');
}

function enforceHttps(html) {
  return html.replace(/((?:src|href)=["'])http:\/\//gi, '$1https://');
}

// [수정] <script>에 defer를 강제로 주입하던 로직 완전 제거.
// 기존 로직은 Blogger 위젯(검색, 메뉴, 댓글 등)이 기대하는 동기 실행 순서를
// 깨뜨려 해당 기능이 동작하지 않는 핵심 원인이었음. 이제 스크립트 태그는
// 원본 그대로 두고, 이미지 lazy-loading과 dns-prefetch/preconnect 같은
// 안전한 최적화만 적용.
function injectPerformanceOptimizations(html) {
  let o = html;
  if (!o.includes('rel="dns-prefetch"')) {
    const tags = [
      '<link rel="dns-prefetch" href="//www.blogger.com">',
      '<link rel="dns-prefetch" href="//www.gstatic.com">',
      '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
      '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
      '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    ].join('\n');
    o = o.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
  }
  // 이미지 lazy-loading은 스크립트 실행 순서와 무관하므로 안전하게 유지
  o = o.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');
  return o;
}

// ─────────────────────────────────────────────
// [추가] 이미지 전송 속도 최적화 — 반응형 srcset 자동 생성
//
// Blogger/googleusercontent 이미지는 URL 안에 사이즈 세그먼트(/s320/, /w320-h240/)
// 또는 쿼리 형태(=s320, =w320-h240)가 있고, 그 숫자를 바꾸면 Google 서버가
// 즉석에서 리사이즈된 이미지를 내려줌(별도 이미지 처리 서버 불필요).
// 이미 srcset이 있거나 사이즈 패턴이 없는 이미지는 건드리지 않음(안전 우선).
// ─────────────────────────────────────────────
const RESPONSIVE_WIDTHS = [320, 480, 800, 1200, 1600];

function injectResponsiveImages(html) {
  return html.replace(/<img\b[^>]*>/gi, tag => {
    try {
      if (/\bsrcset=/i.test(tag)) return tag; // 이미 srcset 있으면 건드리지 않음
      const m = tag.match(/\bsrc=["']([^"']+)["']/i);
      if (!m) return tag;
      const src = m[1];
      const srcset = buildBloggerSrcset(src);
      if (!srcset) return tag;
      // sizes는 보편적인 반응형 본문 이미지 기준값. 테마별로 다를 수 있어
      // 보수적인 기본값만 제공(실제 표시 크기를 넘는 다운로드는 방지하되,
      // 작은 화면에서 과도하게 작은 이미지가 선택되지 않도록 함).
      return tag
        .replace(/<img\b/i, `<img srcset="${escapeAttr(srcset)}" sizes="(max-width: 800px) 100vw, 800px"`);
    } catch (_) {
      return tag;
    }
  });
}

// Blogger 이미지 URL의 사이즈 세그먼트를 RESPONSIVE_WIDTHS 각각으로 교체해
// "url width" 쌍의 srcset 문자열을 생성. 패턴이 없으면 null 반환(원본 유지).
//
// [주의] =w320-h240처럼 너비+높이가 모두 고정된 패턴은 너비만 바꾸면 원본
// 비율이 깨져버리므로(높이를 비례 계산할 정보가 없음) 의도적으로 제외하고
// 원본 그대로 둠. 너비만 있거나(=w320) 정사각형 크롭(=s320, /s320/)처럼
// 한 변만 지정하는 패턴만 안전하게 교체함.
function buildBloggerSrcset(src) {
  // 패턴 A: 경로형 .../s320/... 또는 .../s320-c/... (정사각형 기준 한 변)
  const pathPattern = /\/s\d{2,4}(-c)?\//i;
  // 패턴 B: 쿼리형 한 변만 지정 ...=s320 또는 ...=w320 (높이 고정값 없음)
  const queryPattern = /=([sw])\d{2,4}(-c)?(?=$|[?&])/i;
  // 너비+높이가 모두 고정된 패턴은 비율 깨짐 위험이 있어 제외
  const fixedAspectPattern = /=[sw]\d{2,4}-h\d{2,4}/i;

  if (fixedAspectPattern.test(src)) return null;

  if (pathPattern.test(src)) {
    const entries = RESPONSIVE_WIDTHS.map(w => `${src.replace(pathPattern, `/s${w}$1/`)} ${w}w`);
    return entries.join(', ');
  }
  if (queryPattern.test(src)) {
    const entries = RESPONSIVE_WIDTHS.map(w => `${src.replace(queryPattern, `=$1${w}$2`)} ${w}w`);
    return entries.join(', ');
  }
  return null;
}

// ─────────────────────────────────────────────
// 응답 헤더
// ─────────────────────────────────────────────
function buildResponseHeaders() {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  // [수정] HTML 캐싱 완전 비활성화: 브라우저/CDN 어디에도 캐싱되지 않도록 no-store.
  // public/max-age를 내려보내면 KV 캐시를 꺼도 브라우저나 Cloudflare edge가
  // 자체적으로 HTML을 캐싱해버려서 메뉴/드롭다운 등 동적 위젯이 그대로 깨짐.
  h.set('cache-control',          'no-store, must-revalidate');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding');
  return h;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트
// ─────────────────────────────────────────────
function extractPageContext(html, url) {
  const ctx = {
    type: detectPageType(url), title: '', description: '', imageUrl: '',
    author: '', publishDate: '', updateDate: '', tags: [],
    postUrl: url.toString(), siteName: extractSiteName(html), logoUrl: extractLogoUrl(html),
  };
  ctx.title       = extractMeta(html, 'og:title') || extractTagContent(html, /<title[^>]*>([^<]+)<\/title>/i) || '';
  const bodyText  = extractBodyText(html);
  ctx.description = extractMeta(html, 'description') || extractMeta(html, 'og:description') || buildMetaDescription(bodyText, ctx.title);
  ctx.imageUrl    = extractMeta(html, 'og:image') || extractFirstImage(html) || '';
  ctx.publishDate = extractMeta(html, 'article:published_time') || extractJsonLdDate(html, 'datePublished') || '';
  ctx.updateDate  = extractMeta(html, 'article:modified_time')  || extractJsonLdDate(html, 'dateModified')  || ctx.publishDate;
  ctx.author      = extractMeta(html, 'article:author') || extractTagContent(html, /class="fn"[^>]*>([^<]+)</i) || '';
  ctx.tags        = extractLabels(html);
  return ctx;
}

function detectPageType(url) {
  const p = url.pathname;
  if (p === '/' || p === '')                   return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p))  return 'post';
  if (/^\/p\//.test(p))                         return 'page';
  if (p.startsWith('/search/label/'))           return 'label';
  if (p.startsWith('/search'))                  return 'search';
  // [수정] 평탄화된 /[slug] 경로(확장자 없는 단일 세그먼트, 예약 경로 제외)도 post로 인식
  if (/^\/[^/]+$/.test(p) && !isReservedFlatPath(p)) return 'post';
  return 'other';
}

// ─────────────────────────────────────────────
// SEO 주입
// ─────────────────────────────────────────────
function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;
  const esc = escapeAttr(ctx.description);
  if (/<meta[^>]+name=["']description["']/i.test(html))
    return html.replace(/(<meta[^>]+name=["']description["'][^>]+content=["'])[^"']*["']/i, `$1${esc}"`);
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
  const tw = (n, c) => { if (c && !new RegExp(`name=["']${escapeRe(n)}["']`).test(html))     tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`); };
  og('og:title',       ctx.title);
  og('og:description', ctx.description);
  og('og:url',         ctx.postUrl);
  og('og:type',        ctx.type === 'post' ? 'article' : 'website');
  og('og:site_name',   ctx.siteName);
  if (ctx.imageUrl) og('og:image', ctx.imageUrl);
  tw('twitter:card',        ctx.imageUrl ? 'summary_large_image' : 'summary');
  tw('twitter:title',       ctx.title);
  tw('twitter:description', ctx.description);
  if (ctx.imageUrl) tw('twitter:image', ctx.imageUrl);
  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

function injectSchemaMarkup(html, ctx, url) {
  if (html.includes('"@context":"https://schema.org"') ||
      html.includes('"@context": "https://schema.org"')) return html;
  const schemas = [buildWebsiteSchema(ctx, url)];
  if (ctx.type === 'post') schemas.push(buildArticleSchema(ctx, url));
  else schemas.push(buildWebPageSchema(ctx, url));
  const ld = `<script type="application/ld+json">${JSON.stringify(schemas)}<\/script>`;
  return html.replace(/(<\/head>)/i, ld + '\n$1');
}

function buildWebsiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': url.origin + '/#website', url: url.origin + '/',
    name: ctx.siteName || ctx.title,
    ...(ctx.logoUrl ? { publisher: { '@type': 'Organization', name: ctx.siteName, logo: { '@type': 'ImageObject', url: ctx.logoUrl } } } : {}),
  };
}

function buildArticleSchema(ctx, url) {
  const s = {
    '@context': 'https://schema.org', '@type': 'Article',
    '@id': ctx.postUrl + '#article', mainEntityOfPage: ctx.postUrl + '#webpage',
    headline: ctx.title, description: ctx.description,
    author: { '@type': 'Person', name: ctx.author || ctx.siteName },
    inLanguage: 'ko-KR',
  };
  if (ctx.imageUrl)    { s.image = { '@type': 'ImageObject', url: ctx.imageUrl }; }
  if (ctx.publishDate) s.datePublished = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified  = ctx.updateDate;
  if (ctx.tags.length) s.keywords      = ctx.tags.join(', ');
  return s;
}

function buildWebPageSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebPage',
    '@id': ctx.postUrl + '#webpage', url: ctx.postUrl,
    name: ctx.title, description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' }, inLanguage: 'ko-KR',
    ...(ctx.publishDate ? { datePublished: ctx.publishDate } : {}),
    ...(ctx.updateDate  ? { dateModified:  ctx.updateDate  } : {}),
  };
}

// ─────────────────────────────────────────────
// HTML 파싱 유틸
// ─────────────────────────────────────────────
function extractMeta(html, name) {
  const r = escapeRe(name);
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${r}["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+name=["']${r}["'][^>]+content=["']([^"']+)["']`,    'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`,    'i')) ||
    []
  )[1] || '';
}

function extractTagContent(html, re) { return (html.match(re) || ['', ''])[1].trim(); }

function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildMetaDescription(bodyText, title) {
  let t = title ? bodyText.replace(title, '').trim() : bodyText;
  if (t.length > 160) {
    t = t.slice(0, 160);
    const l = t.lastIndexOf(' ');
    if (l > 100) t = t.slice(0, l);
    t += '…';
  }
  return t;
}

function extractFirstImage(html)  { return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || ''; }
function extractSiteName(html)    { return extractMeta(html, 'og:site_name') || extractTagContent(html, /<title[^>]*>([^<|]+)/i) || ''; }
function extractLogoUrl(html) {
  return (
    html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) ||
    []
  )[1] || '';
}
function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi; let m;
  while ((m = re.exec(html)) !== null) {
    const l = m[1].trim();
    if (l && !labels.includes(l)) labels.push(l);
  }
  return labels;
}
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(str)   { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─────────────────────────────────────────────
// [추가] 도메인별 격리 헬퍼 — TenantCoordinator(Durable Object) 호출
//
// 도메인(host)마다 Durable Object 인스턴스가 idFromName(host)으로 정해지므로
// 같은 도메인 요청은 항상 같은 인스턴스로 모이고, 다른 도메인은 자동으로
// 분리됨(서비스 디스커버리 + 격리). DO 바인딩(env.TENANT_DO)이 없는 환경에서도
// 워커 전체가 죽지 않도록 모든 호출을 방어적으로 처리.
// ─────────────────────────────────────────────
async function tenantAcquire(host, env) {
  if (!env.TENANT_DO) return { ok: true, stub: null }; // DO 미바인딩: 그냥 통과
  try {
    const id   = env.TENANT_DO.idFromName(host);
    const stub = env.TENANT_DO.get(id);
    const resp = await stub.fetch('https://tenant/acquire');
    if (!resp.ok) return { ok: true, stub }; // DO 호출 실패해도 서비스는 계속 (degrade gracefully)
    const data = await resp.json().catch(() => ({ allowed: true }));
    return { ok: !!data.allowed, stub, reason: data.reason };
  } catch (_) {
    return { ok: true, stub: null }; // DO 자체가 불안정해도 본 서비스는 죽지 않음
  }
}

async function tenantRelease(stub, success) {
  if (!stub) return;
  try {
    await stub.fetch('https://tenant/release', {
      method: 'POST',
      body: JSON.stringify({ success: !!success }),
      headers: { 'content-type': 'application/json' },
    });
  } catch (_) {}
}

async function tenantStatus(host, env) {
  if (!env.TENANT_DO) return { bound: false };
  try {
    const id   = env.TENANT_DO.idFromName(host);
    const stub = env.TENANT_DO.get(id);
    const resp = await stub.fetch('https://tenant/status');
    if (!resp.ok) return { bound: true, error: 'status fetch failed' };
    return await resp.json();
  } catch (e) {
    return { bound: true, error: String((e && e.message) || e) };
  }
}

// ─────────────────────────────────────────────
// [추가] TenantCoordinator — 도메인(host)별 1개씩 자동 생성되는 Durable Object
//
// 쿠버네티스의 "도메인별 격리된 pod" 개념을 Workers 네이티브 방식으로 구현:
//   - 동시성 제어: 도메인당 동시 origin 요청 수를 TENANT_MAX_CONCURRENCY로 제한.
//     한 도메인이 트래픽 폭주/장애를 겪어도 다른 도메인 처리량에 영향 없음.
//   - 헬스 상태(서비스 디스커버리 역할): 연속 실패 횟수가 임계치를 넘으면
//     circuit을 열어(open) 일정 시간 동안 즉시 503으로 빠르게 실패시키고,
//     쿨다운이 지나면 half-open으로 전환해 다음 요청 1건으로 복구 여부 판단.
//
// Durable Object는 단일 스레드로 직렬 실행되므로 동시성 카운터에 race
// condition이 발생하지 않음(별도 락 불필요).
//
// wrangler.toml 설정 예시는 파일 최하단 주석 참고.
// ─────────────────────────────────────────────
export class TenantCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.inFlight = 0;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.totalRequests = 0;
    this.totalRejected = 0;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/acquire') {
        return this.handleAcquire();
      }
      if (url.pathname === '/release') {
        return this.handleRelease(request);
      }
      if (url.pathname === '/status') {
        return this.handleStatus();
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      // DO 내부에서 어떤 에러가 나도 500 대신 "허용"으로 응답해 본 서비스가
      // 절대 막히지 않도록 함 (이 DO는 보조 안전장치이지 필수 경로가 아님)
      return new Response(JSON.stringify({ allowed: true, error: String((e && e.message) || e) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  handleAcquire() {
    this.totalRequests++;
    const now = Date.now();

    // circuit이 열려 있으면(최근 연속 실패 임계치 초과) 쿨다운 동안 즉시 거부
    if (this.circuitOpenUntil > now) {
      this.totalRejected++;
      return Response.json({
        allowed: false,
        reason: 'circuit_open',
        retryAfterMs: this.circuitOpenUntil - now,
      });
    }

    // 동시성 슬롯 초과 시 거부 (도메인별 과부하 격리)
    if (this.inFlight >= TENANT_MAX_CONCURRENCY) {
      this.totalRejected++;
      return Response.json({ allowed: false, reason: 'concurrency_limit' });
    }

    this.inFlight++;
    return Response.json({ allowed: true });
  }

  async handleRelease(request) {
    let success = true;
    try {
      const body = await request.json();
      success = body && body.success !== false;
    } catch (_) {}

    this.inFlight = Math.max(0, this.inFlight - 1);

    if (success) {
      this.consecutiveFailures = 0;
      // half-open 상태에서 성공하면 circuit을 즉시 닫음
      if (this.circuitOpenUntil > 0) this.circuitOpenUntil = 0;
    } else {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= TENANT_FAILURE_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + TENANT_OPEN_COOLDOWN_MS;
      }
    }

    return Response.json({ ok: true });
  }

  handleStatus() {
    const now = Date.now();
    return Response.json({
      bound: true,
      inFlight: this.inFlight,
      maxConcurrency: TENANT_MAX_CONCURRENCY,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpenUntil > now,
      circuitOpenForMs: this.circuitOpenUntil > now ? this.circuitOpenUntil - now : 0,
      totalRequests: this.totalRequests,
      totalRejected: this.totalRejected,
    });
  }
}

/**
 * ─────────────────────────────────────────────────
 * [추가] wrangler.toml 설정 가이드 — TenantCoordinator Durable Object
 * ─────────────────────────────────────────────────
 *
 * 1) wrangler.toml에 아래 블록 추가 (기존 KV 바인딩들 옆에):
 *
 *   [[durable_objects.bindings]]
 *   name = "TENANT_DO"
 *   class_name = "TenantCoordinator"
 *
 *   # Durable Objects는 신규 클래스 등록 시 마이그레이션 선언이 필요함
 *   [[migrations]]
 *   tag = "v1-tenant-coordinator"
 *   new_classes = ["TenantCoordinator"]
 *
 * 2) 클래스는 이 파일(default export 워커 핸들러가 있는 동일 파일)에서
 *    `export class TenantCoordinator { ... }` 형태로 함께 export 되어 있어야
 *    하며, 이 파일이 wrangler.toml의 `main` 진입점과 일치해야 함.
 *
 * 3) 배포:
 *      npx wrangler deploy
 *    최초 배포 시 migrations가 적용되며 이후엔 결과가 캐싱되어 재실행되지 않음.
 *
 * 4) 동작 확인:
 *      curl https://your-domain/__blogger_debug
 *    응답의 tenant 필드에서 inFlight/circuitOpen 등 실시간 상태 확인 가능.
 *
 * 5) 만약 Durable Objects를 아직 쓰고 싶지 않다면 TENANT_DO 바인딩을 생략해도
 *    무방함 — 위 tenantAcquire/tenantRelease/tenantStatus 함수들은 env.TENANT_DO가
 *    없으면 전부 통과(no-op)로 처리되어 기존 동작과 100% 동일하게 작동함.
 */
