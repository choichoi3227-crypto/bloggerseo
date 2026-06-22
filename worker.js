/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * 설정 제로 — Route 추가만 하면 끝
 *
 * ┌─ 핵심 동작 원리 ────────────────────────────────────────────────┐
 * │  Cloudflare Workers의 fetch()는 Host 헤더 override가 불가능.    │
 * │  따라서 "ghs.google.com에 Host:커스텀도메인" 방식 대신,          │
 * │  blogspot.com URL에 직접 fetch → Blogger가 리다이렉트 없이       │
 * │  콘텐츠 반환 (blogspot URL로 오면 커스텀도메인으로 안 보냄).      │
 * │                                                                  │
 * │  Origin 탐지: ghs.google.com에 커스텀도메인으로 HTTP HEAD 요청   │
 * │  → 302 Location에서 blogspot 주소 추출 (탐지 시에만 사용)        │
 * │  → KV에 저장, 이후 모든 요청은 KV 즉시 조회 (속도 제로)          │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 로드 밸런싱 (자체 구현, CF 유료 기능 불사용) ─────────────────┐
 * │  단일 origin이면 LB 스킵 (오버헤드 제로)                        │
 * │  다중 origin(블로그 여러 개):                                    │
 * │    least_rtt        — EWMA 응답속도 최소 [기본]                  │
 * │    round_robin      — 순서 균등                                  │
 * │    weighted_rr      — 가중치 비례                                │
 * │    least_connections— 현재 연결 수 최소                          │
 * │    least_bandwidth  — 누적 처리 바이트 최소                      │
 * │    ip_hash          — IP 해시 (세션 고정)                        │
 * │    geo              — cf-ray 공항코드 지역 라우팅                │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 선택적 환경변수 (Workers 대시보드 Settings에서 추가):
 *   LB_ALGO      알고리즘 선택 (기본: least_rtt)
 *   LB_WEIGHTS   가중 RR용 JSON {"https://a.blogspot.com":3,...}
 *   LB_GEO_MAP   지역 라우팅 JSON {"APAC":"https://a.blogspot.com",...}
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CACHE_TTL       = 30 * 60;
const SLUG_CHECK_MS   = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY    = 0.25;
const LB_RTT_TTL      = 60;
const LB_ALGO_DEFAULT = 'least_rtt';

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvOrigin    = h => 'origin:'         + h;
const kvCanonical = h => 'canonical:host:' + h;
const kvRtt       = o => 'lb:rtt:'         + o;
const kvBw        = o => 'lb:bw:'          + o;
const kvRr        = h => 'lb:rr:'          + h;

// ─────────────────────────────────────────────
// CF PoP 공항코드 → 대륙 매핑
// ─────────────────────────────────────────────
const POP_REGION = {
  ICN:'APAC',NRT:'APAC',KIX:'APAC',TPE:'APAC',HKG:'APAC',SIN:'APAC',
  KUL:'APAC',BKK:'APAC',SGN:'APAC',MNL:'APAC',CGK:'APAC',DEL:'APAC',
  BOM:'APAC',SYD:'APAC',MEL:'APAC',AKL:'APAC',PVG:'APAC',PEK:'APAC',
  LAX:'NA',SJC:'NA',SEA:'NA',DEN:'NA',DFW:'NA',ORD:'NA',ATL:'NA',
  MIA:'NA',IAD:'NA',EWR:'NA',JFK:'NA',YYZ:'NA',SFO:'NA',
  LHR:'EU',AMS:'EU',CDG:'EU',FRA:'EU',MUC:'EU',ZRH:'EU',MAD:'EU',
  FCO:'EU',ARN:'EU',WAW:'EU',VIE:'EU',DUB:'EU',
  GRU:'SA',BOG:'SA',LIM:'SA',SCL:'SA',
  DXB:'MEA',DOH:'MEA',NBO:'MEA',JNB:'MEA',
};

function popRegion(cfRay) {
  if (!cfRay) return null;
  const m = cfRay.match(/-([A-Z]{3})$/);
  return m ? (POP_REGION[m[1]] || null) : null;
}

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return notice(['처리 중 예외: ' + String(e && e.message || e)]);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env));
  },
};

async function handleFetch(request, env, ctx) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // ── Origin 조회 ──────────────────────────
  const resolved = await resolveOrigin(url.hostname, env);
  if (!resolved) {
    return notice(['Origin 탐지 실패. ghs.google.com이 커스텀도메인에 응답하지 않거나 Blogger 설정이 필요합니다.']);
  }

  const { origins, canonicalHost } = resolved;
  const origin = await lbSelect(origins, url.hostname, request, env);

  // ── 1. 정적 자산 / Feed 직통 ─────────────
  if (isPassthrough(path, url)) {
    try {
      const resp = await originFetch(url, origin, request.method, request.headers, request.body);
      return stripInternalHeaders(resp);
    } catch (e) {
      return notice(['passthrough fetch 예외: ' + e.message]);
    }
  }

  // ── 2. 슬러그 canonical 리다이렉트 ───────
  const slugRedir = await checkSlugRedirect(path, url, env);
  if (slugRedir) return slugRedir;

  // ── 3. KV Cache Reserve ───────────────────
  const cacheKey = buildCacheKey(url);
  const cached   = await getCacheReserve(cacheKey, env);
  if (cached) {
    return new Response(cached.body, { status: 200, headers: buildCachedHeaders(cached.headers) });
  }

  // ── 4. Origin Fetch ───────────────────────
  let originResp;
  const t0 = Date.now();
  try {
    originResp = await originFetch(url, origin, 'GET', request.headers, null);
  } catch (e) {
    ctx.waitUntil(lbRecordFailure(origin, env));
    return notice(['origin fetch 예외: ' + e.message]);
  }
  ctx.waitUntil(lbRecordRtt(origin, Date.now() - t0, env));

  if (originResp.status >= 500) return notice(['origin 5xx: ' + originResp.status]);
  if (!isHtml(originResp) || !originResp.ok) return stripInternalHeaders(originResp);

  // ── 5. HTML 파이프라인 ────────────────────
  const html = await originResp.text();
  let result, pageCtx;
  try {
    pageCtx = extractPageContext(html, url);
    result  = transformHtml(html, pageCtx, url);
  } catch (_) {
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ── 6. 비동기 후처리 (응답 지연 없음) ────
  const respHeaders = buildResponseHeaders();
  ctx.waitUntil(updateSlugKV(pageCtx, url, env));
  ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));
  ctx.waitUntil(lbRecordBandwidth(origin, result.length, env));

  return new Response(result, { status: 200, headers: respHeaders });
}

// ─────────────────────────────────────────────
// 핵심: Blogger origin에 직접 fetch
// ─────────────────────────────────────────────
// Workers에서 fetch()는 Host 헤더를 override할 수 없음.
// 대신 blogspot.com URL로 직접 요청하면 Blogger는 리다이렉트 없이
// 콘텐츠를 바로 반환한다 (blogspot URL 직접 접근 = 내부 서빙 모드).
//
// ?m=1 제거: Blogger 모바일 파라미터로, blogspot URL로 보내면
// 모바일 전용 페이지(리다이렉트 경고 원인)로 분기되므로 반드시 제거.
async function originFetch(url, origin, method, reqHeaders, body) {
  // ?m= 제거
  const params = new URLSearchParams(url.search);
  params.delete('m');
  const qs        = params.toString() ? '?' + params.toString() : '';
  const targetUrl = origin + url.pathname + qs;

  // 전달할 헤더 — CF 내부 헤더 제거, Accept-Encoding 유지
  const headers = new Headers();
  for (const [k, v] of reqHeaders.entries()) {
    const kl = k.toLowerCase();
    // CF 내부 전용 헤더 제거 (origin에 보내면 안 됨)
    if (kl === 'host') continue;
    if (kl.startsWith('cf-')) continue;
    if (kl === 'x-forwarded-for') continue;
    if (kl === 'x-real-ip') continue;
    headers.set(k, v);
  }
  headers.set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

  const resp = await fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
    redirect: 'follow',   // blogspot 내부 리다이렉트는 follow (https 강제 등)
  });

  return resp;
}

// Cloudflare/Blogger 내부 헤더를 응답에서 제거
function stripInternalHeaders(resp) {
  const h = new Headers(resp.headers);
  h.delete('cf-cache-status');
  h.delete('cf-ray');
  h.delete('nel');
  h.delete('report-to');
  h.delete('server');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// ─────────────────────────────────────────────
// Origin 자동 탐지 & KV 캐시
// ─────────────────────────────────────────────
async function resolveOrigin(host, env) {
  // 1) KV 즉시 조회 (정상 경로 — 속도 제로)
  try {
    const raw = await env.SLUG_KV.get(kvOrigin(host));
    if (raw) {
      const origins       = JSON.parse(raw);
      const canonicalHost = (await env.SLUG_KV.get(kvCanonical(host))) || host;
      return { origins, canonicalHost };
    }
  } catch (_) {}

  // 2) 첫 요청 시 실시간 탐지 (이후 KV에 저장되어 다시 탐지 안 함)
  const result = await detectOrigin(host);
  if (!result) return null;

  try {
    await env.SLUG_KV.put(kvOrigin(host),    JSON.stringify(result.origins));
    await env.SLUG_KV.put(kvCanonical(host), result.canonicalHost);
  } catch (_) {}

  return result;
}

// ─────────────────────────────────────────────
// Origin 탐지 (ghs.google.com 방식)
// ─────────────────────────────────────────────
// Blogger 커스텀 도메인은 반드시 ghs.google.com CNAME을 가짐.
// ghs.google.com 의 IP로 직접 HTTP 요청하면서 Host 헤더로
// 커스텀 도메인을 지정 → Blogger가 해당 blogspot 주소로 301 반환.
//
// 탐지 시에만 사용하며, 이때는 Host override가 필요하므로
// fetch 대신 실제 IP(ghs.google.com의 A 레코드)로 요청하거나,
// Cloudflare가 허용하는 방식(실제 URL을 ghs IP로 구성)을 사용.
//
// Workers에서 Host override가 안 되는 문제 우회:
// ghs.google.com 의 IP 주소들 중 하나로 URL을 만들고
// URL 자체에 커스텀 도메인을 포함시켜 Blogger 라우터가 인식하게 함.
// 실제로는 ghs.google.com 도메인으로 fetch하되,
// URL path에 커스텀 도메인 힌트를 주는 방식이 아니라
// Cloudflare Subrequest의 특성을 이용:
// fetch('http://ghs.google.com/', { headers: { host: customDomain } })
// → CF 엣지에서 TCP는 ghs.google.com의 실제 IP로, HTTP Host는 customDomain으로 전송
// → 이건 실제로 동작함 (CF Workers는 서브리퀘스트에서 Host override 가능)
async function detectOrigin(host) {
  // ── 방법 1: ghs.google.com HTTP + Host override ──
  // CF Workers 서브리퀘스트는 Host 헤더 override가 작동함
  // (브라우저와 달리 Worker의 fetch()는 제한이 덜함)
  try {
    const resp = await fetch('http://ghs.google.com/', {
      method:  'HEAD',
      headers: { host: host, 'user-agent': 'Mozilla/5.0' },
      redirect: 'manual',
    });
    const loc = resp.headers.get('location') || '';

    // Case A: Location이 같은 도메인 계열 → 정식 호스트로 재시도
    const canonical = extractSameRootHost(loc, host);
    if (canonical && canonical !== host) {
      const resp2 = await fetch('http://ghs.google.com/', {
        method:  'HEAD',
        headers: { host: canonical, 'user-agent': 'Mozilla/5.0' },
        redirect: 'manual',
      });
      const loc2   = resp2.headers.get('location') || '';
      const origin = extractBlogspotUrl(loc2);
      if (origin) return { origins: [origin], canonicalHost: canonical };
    }

    // Case B: Location이 바로 blogspot 주소
    const origin = extractBlogspotUrl(loc);
    if (origin) return { origins: [origin], canonicalHost: host };

    // Case C: 200 응답이 오면 본문에서 추출 시도
    if (resp.status === 200) {
      const resp3 = await fetch('http://ghs.google.com/', {
        method:  'GET',
        headers: { host: host, 'user-agent': 'Mozilla/5.0' },
        redirect: 'follow',
      });
      const text   = await resp3.text().catch(() => '');
      const origin2 = extractBlogspotFromContent(text);
      if (origin2) return { origins: [origin2], canonicalHost: host };
    }
  } catch (_) {}

  // ── 방법 2: blogspot.com 피드 API 활용 ──
  // 커스텀 도메인으로 Blogger atom feed 요청 →
  // redirect:follow로 최종 URL이 blogspot이면 추출
  try {
    const feedUrl = 'https://' + host + '/feeds/posts/default?alt=json&max-results=1';
    const resp = await fetch(feedUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    // 최종 URL이 blogspot이면 추출
    if (resp.url && /\.blogspot\.com/i.test(resp.url)) {
      const fh = new URL(resp.url).hostname;
      if (/^[a-z0-9-]+\.blogspot\.com$/i.test(fh)) {
        return { origins: ['https://' + fh], canonicalHost: host };
      }
    }
    // 응답 본문 JSON에서 추출
    const text   = await resp.text().catch(() => '');
    const origin = extractBlogspotFromContent(text);
    if (origin) return { origins: [origin], canonicalHost: host };
  } catch (_) {}

  // ── 방법 3: sitemap.xml ──
  try {
    const resp = await fetch('https://' + host + '/sitemap.xml', {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const text   = await resp.text().catch(() => '');
    const origin = extractBlogspotFromContent(text);
    if (origin) return { origins: [origin], canonicalHost: host };
  } catch (_) {}

  return null;
}

// Location이 같은 루트 도메인 계열이면 호스트 반환
function extractSameRootHost(location, originalHost) {
  if (!location) return null;
  try {
    const lh   = new URL(location).hostname;
    const root = h => h.split('.').slice(-3).join('.');
    if (lh !== originalHost && (
      lh.endsWith('.' + originalHost) ||
      originalHost.endsWith('.' + lh) ||
      root(lh) === root(originalHost)
    )) return lh;
  } catch (_) {}
  return null;
}

// URL 문자열에서 blogspot.com 호스트 추출
function extractBlogspotUrl(str) {
  if (!str) return null;
  const m = str.match(/https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i);
  return m ? 'https://' + m[1] : null;
}

// HTML/JSON/XML 본문에서 blogspot.com 참조 추출
function extractBlogspotFromContent(content) {
  if (!content) return null;
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /<link[^>]+rel=["']EditURI["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /<loc>\s*https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /<link>\s*https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /"(?:id|url|href|alternate)"\s*:\s*"https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m && m[1]) return 'https://' + m[1];
  }
  return null;
}

// ─────────────────────────────────────────────
// 로드 밸런서
// ─────────────────────────────────────────────
async function lbSelect(origins, host, request, env) {
  if (origins.length === 1) return origins[0];  // 단일이면 즉시 반환

  const algo = (env.LB_ALGO || LB_ALGO_DEFAULT).trim();
  try {
    switch (algo) {
      case 'round_robin':       return await lbRoundRobin(origins, host, env);
      case 'weighted_rr':       return await lbWeightedRR(origins, host, env);
      case 'least_connections': return await lbLeastConn(origins, env);
      case 'least_bandwidth':   return await lbLeastBw(origins, env);
      case 'ip_hash':           return lbIpHash(origins, request);
      case 'geo':               return await lbGeo(origins, request, env);
      case 'least_rtt':
      default:                  return await lbLeastRtt(origins, env);
    }
  } catch (_) {
    return origins[0];  // 어떤 LB 예외도 첫 번째 origin으로 폴백
  }
}

// 1. 라운드 로빈
async function lbRoundRobin(origins, host, env) {
  const key = kvRr(host);
  const cur = parseInt((await env.SLUG_KV.get(key)) || '0', 10);
  env.SLUG_KV.put(key, String(cur + 1)).catch(() => {});
  return origins[cur % origins.length];
}

// 2. 가중 라운드 로빈
async function lbWeightedRR(origins, host, env) {
  let weights = {};
  try { weights = JSON.parse(env.LB_WEIGHTS || '{}'); } catch (_) {}
  const pool = [];
  for (const o of origins) {
    const w = Math.max(1, parseInt(weights[o] || '1', 10));
    for (let i = 0; i < w; i++) pool.push(o);
  }
  const key = kvRr(host) + ':w';
  const cur = parseInt((await env.SLUG_KV.get(key)) || '0', 10);
  env.SLUG_KV.put(key, String(cur + 1)).catch(() => {});
  return pool[cur % pool.length];
}

// 3. 최소 RTT (EWMA)
async function lbLeastRtt(origins, env) {
  const scores = await Promise.all(origins.map(async o => {
    try {
      const raw = await env.SLUG_KV.get(kvRtt(o), { type: 'json' });
      return { o, v: raw && raw.rtt != null ? raw.rtt : 9999 };
    } catch (_) { return { o, v: 9999 }; }
  }));
  scores.sort((a, b) => a.v - b.v);
  return scores[0].o;
}

// 4. 최소 연결 수 (대역폭으로 연결 수 근사)
async function lbLeastConn(origins, env) {
  return lbLeastBw(origins, env);
}

// 5. IP Hash
function lbIpHash(origins, request) {
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
  let h = 0;
  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) >>> 0;
  return origins[h % origins.length];
}

// 6. 최소 대역폭
async function lbLeastBw(origins, env) {
  const scores = await Promise.all(origins.map(async o => {
    try {
      const v = parseInt((await env.SLUG_KV.get(kvBw(o))) || '0', 10);
      return { o, v };
    } catch (_) { return { o, v: 0 }; }
  }));
  scores.sort((a, b) => a.v - b.v);
  return scores[0].o;
}

// 7. 지역 라우팅
async function lbGeo(origins, request, env) {
  const region = popRegion(request.headers.get('cf-ray') || '');
  if (region) {
    try {
      const map = JSON.parse(env.LB_GEO_MAP || '{}');
      if (map[region] && origins.includes(map[region])) return map[region];
    } catch (_) {}
  }
  return lbLeastRtt(origins, env);
}

// RTT EWMA 기록
async function lbRecordRtt(origin, rttMs, env) {
  try {
    const prev = await env.SLUG_KV.get(kvRtt(origin), { type: 'json' });
    const ewma = prev && prev.rtt != null
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await env.SLUG_KV.put(kvRtt(origin), JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

// 실패 시 RTT 최대값 기록 (해당 origin 기피)
async function lbRecordFailure(origin, env) {
  try {
    await env.SLUG_KV.put(kvRtt(origin), JSON.stringify({ rtt: 99999, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

// 대역폭 기록
async function lbRecordBandwidth(origin, bytes, env) {
  try {
    const prev = parseInt((await env.SLUG_KV.get(kvBw(origin))) || '0', 10);
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await env.SLUG_KV.put(kvBw(origin), String(next), { expirationTtl: 86400 });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 라우트 판별
// ─────────────────────────────────────────────
function isPassthrough(path, url) {
  if (path.startsWith('/feeds/'))  return true;
  if (url.searchParams.has('alt')) return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─────────────────────────────────────────────
// 슬러그 canonical 리다이렉트
// ─────────────────────────────────────────────
async function checkSlugRedirect(path, url, env) {
  if (!isPostPath(path)) return null;
  try {
    const canonical = await env.SLUG_KV.get('canonical:' + path);
    if (canonical && canonical !== path) {
      const dest = new URL(url.toString());
      dest.pathname = canonical;
      return Response.redirect(dest.toString(), 301);
    }
  } catch (_) {}
  return null;
}

function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

// ─────────────────────────────────────────────
// HTML 변환 파이프라인
// ─────────────────────────────────────────────
function transformHtml(html, ctx, url) {
  let o = html;
  o = stripMobileParam(o);
  o = enforceHttps(o);
  o = injectMetaDescription(o, ctx);
  o = injectCanonical(o, ctx, url);
  o = injectSchemaMarkup(o, ctx, url);
  o = injectSeoTags(o, ctx, url);
  o = injectPerformanceOptimizations(o);
  return o;
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
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p)) return 'post';
  if (/^\/p\//.test(p))                        return 'page';
  if (p.startsWith('/search/label/'))           return 'label';
  if (p.startsWith('/search'))                  return 'search';
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
  const og = (p, c) => { if (c && !new RegExp(`property=["']${p}["']`).test(html)) tags.push(`<meta property="${p}" content="${escapeAttr(c)}">`); };
  const tw = (n, c) => { if (c && !new RegExp(`name=["']${n}["']`).test(html))     tags.push(`<meta name="${n}" content="${escapeAttr(c)}">`); };
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
  let o = html.replace(/(<head[^>]*>)/i, `$1\n${tags}`);
  o = o.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');
  o = o.replace(/(<script(?![^>]*(defer|async|type=["']application\/ld\+json["']|type=["']text\/template["']))[^>]*src=["'][^"']+["'][^>]*)>/gi, '$1 defer>');
  return o;
}

// ─────────────────────────────────────────────
// Cache Reserve
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const s = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (s.toString() ? '?' + s : '');
}

async function getCacheReserve(key, env) {
  try {
    const meta = await env.CACHE_RESERVE_KV.get('meta:' + key, { type: 'json' });
    if (!meta || Date.now() - meta.ts > CACHE_TTL * 1000) {
      if (meta) {
        env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
        env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
      }
      return null;
    }
    const body = await env.CACHE_RESERVE_KV.get('body:' + key);
    return body ? { body, headers: meta.headers } : null;
  } catch (_) { return null; }
}

async function setCacheReserve(key, body, headers, env) {
  try {
    const opts = { expirationTtl: CACHE_TTL * 2 };
    await env.CACHE_RESERVE_KV.put('meta:' + key, JSON.stringify({ ts: Date.now(), headers: Object.fromEntries(headers.entries()) }), opts);
    await env.CACHE_RESERVE_KV.put('body:' + key, body, opts);
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 KV
// ─────────────────────────────────────────────
async function updateSlugKV(ctx, url, env) {
  if (!['post', 'page'].includes(ctx.type) || !ctx.title) return;
  const path = url.pathname, slug = generateSlug(ctx.title);
  try {
    const existing = await env.SLUG_KV.get('slug:' + path, { type: 'json' });
    const now = Date.now();
    if (!existing) {
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ title: ctx.title, slug, path, createdAt: now, checkedAt: now }));
    } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
      const newSlug = generateSlug(ctx.title);
      if (newSlug !== existing.slug) {
        const op = path.replace(/[^/]+\.html$/, existing.slug + '.html');
        const np = path.replace(/[^/]+\.html$/, newSlug   + '.html');
        if (op !== np) await env.SLUG_KV.put('canonical:' + op, np);
      }
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ ...existing, slug: newSlug, checkedAt: now }));
    }
  } catch (_) {}
}

async function runSlugAudit(env) {
  try {
    const list = await env.SLUG_KV.list({ prefix: 'slug:' });
    const now  = Date.now();
    for (const key of list.keys) {
      try {
        const data = await env.SLUG_KV.get(key.name, { type: 'json' });
        if (!data || now - data.checkedAt < SLUG_CHECK_MS) continue;
        const newSlug = generateSlug(data.title);
        if (newSlug !== data.slug) {
          const op = data.path.replace(/[^/]+\.html$/, data.slug   + '.html');
          const np = data.path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (op !== np) await env.SLUG_KV.put('canonical:' + op, np);
        }
        await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, slug: newSlug, checkedAt: now }));
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 생성 (다국어)
// ─────────────────────────────────────────────
function generateSlug(title) {
  if (!title) return 'untitled';
  let s = title.trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/_+/g, '-')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/[^\p{L}\p{N}\-]/gu, '-')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (/[^\x00-\x7F]/.test(s))
    s = encodeURIComponent(s).replace(/%20/g, '-').replace(/%2F/gi, '-');
  return s || 'post';
}

// ─────────────────────────────────────────────
// 응답 헤더
// ─────────────────────────────────────────────
function buildResponseHeaders() {
  const h = new Headers();
  h.set('content-type',           'text/html; charset=utf-8');
  h.set('cache-control',          `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}, stale-while-revalidate=60`);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options',        'SAMEORIGIN');
  h.set('referrer-policy',        'strict-origin-when-cross-origin');
  h.set('vary',                   'Accept-Encoding');
  return h;
}

function buildCachedHeaders(saved) {
  const h = new Headers(saved || {});
  h.set('x-cache',       'HIT');
  h.set('cache-control', `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`);
  return h;
}

// ─────────────────────────────────────────────
// 안내 페이지 (탐지 실패 시 항상 200 OK)
// ─────────────────────────────────────────────
function notice(lines) {
  const comment = (lines && lines.length)
    ? '\n<!--\n' + lines.join('\n').replace(/-->/g, '--&gt;') + '\n-->'
    : '';
  return new Response(
    `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="robots" content="noindex">
<title>사이트 준비 중</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#fafafa}
.b{text-align:center;padding:2rem}h1{font-size:1.2rem}p{color:#666;font-size:.9rem}</style>
</head><body><div class="b">
<h1>사이트를 준비하고 있습니다</h1>
<p>잠시 후 다시 시도해 주세요.</p>
</div>${comment}</body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } }
  );
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

function extractTagContent(html, re) { return (html.match(re) || ['',''])[1].trim(); }

function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildMetaDescription(bodyText, title) {
  let t = bodyText.replace(title, '').trim();
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
function extractLogoUrl(html)     {
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
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRe(str)   { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
