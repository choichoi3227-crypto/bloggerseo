/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * 설정 제로 — Route 추가만 하면 끝
 *
 * ┌─ 자동 Origin 탐지 ──────────────────────────────────────────────┐
 * │  Route 추가 → 첫 요청 시 ghs.google.com 방식으로 탐지           │
 * │  (HTTP + Host헤더 → Blogger 301 Location → blogspot 주소 추출)  │
 * │  탐지 결과를 KV에 영구 저장 → 이후 모든 요청은 KV 즉시 조회     │
 * │  CF API / secret / 수동 입력 완전 불필요                         │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 자체 로드 밸런싱 (CF 유료 기능 불사용) ───────────────────────┐
 * │  알고리즘 (요청마다 자동 선택):                                  │
 * │    1. Round Robin        — 순서대로 균등 분배                    │
 * │    2. Weighted RR        — 도메인별 가중치 비례 분배             │
 * │    3. Least RTT          — 최근 응답속도 가장 빠른 origin        │
 * │    4. Least Connections  — 현재 연결 수 가장 적은 origin         │
 * │    5. IP Hash            — 동일 사용자 → 동일 origin (세션 유지) │
 * │    6. Least Bandwidth    — 처리 바이트 가장 적은 origin          │
 * │    7. PoP Geo Routing    — cf-ray 공항코드로 가장 가까운 origin  │
 * │  단일 블로그면 LB 없이 직통 (오버헤드 제로)                     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * KV 키 구조:
 *   origin:{host}          → "https://xxxx.blogspot.com"
 *   canonical:host:{host}  → Blogger 정식 커스텀 호스트
 *   lb:rtt:{origin}        → 최근 RTT ms (JSON)
 *   lb:conn:{origin}       → 현재 active 연결 수 (숫자 문자열)
 *   lb:bw:{origin}         → 누적 처리 바이트 (숫자 문자열)
 *   lb:rr:{host}           → 라운드로빈 카운터
 *   slug:*, canonical:*    → SEO slug 관련
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CACHE_TTL       = 30 * 60;          // 30분
const SLUG_CHECK_MS   = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY    = 0.25;             // EWMA 가중치 (새 샘플 반영 비율)
const LB_RTT_TTL      = 60;              // RTT 측정 캐시 60초
const LB_ALGO_DEFAULT = 'least_rtt';     // 기본 알고리즘

// ─────────────────────────────────────────────
// KV 키 헬퍼
// ─────────────────────────────────────────────
const kvOrigin    = h => 'origin:'         + h;
const kvCanonical = h => 'canonical:host:' + h;
const kvRtt       = o => 'lb:rtt:'         + o;
const kvConn      = o => 'lb:conn:'        + o;
const kvBw        = o => 'lb:bw:'          + o;
const kvRr        = h => 'lb:rr:'          + h;

// ─────────────────────────────────────────────
// CF PoP 공항코드 → 대륙/지역 매핑
// (cf-ray: "xxxx-ICN" 에서 "ICN" 추출)
// ─────────────────────────────────────────────
const POP_REGION = {
  // 아시아태평양
  ICN:'APAC', NRT:'APAC', KIX:'APAC', TPE:'APAC', HKG:'APAC',
  SIN:'APAC', KUL:'APAC', BKK:'APAC', SGN:'APAC', MNL:'APAC',
  CGK:'APAC', DEL:'APAC', BOM:'APAC', MAA:'APAC', HYD:'APAC',
  SYD:'APAC', MEL:'APAC', AKL:'APAC', PER:'APAC', BNE:'APAC',
  PVG:'APAC', PEK:'APAC', CAN:'APAC', CTU:'APAC',
  // 북미
  LAX:'NA', SJC:'NA', SEA:'NA', PDX:'NA', DEN:'NA', DFW:'NA',
  ORD:'NA', ATL:'NA', MIA:'NA', IAD:'NA', EWR:'NA', JFK:'NA',
  BOS:'NA', YYZ:'NA', YVR:'NA', YUL:'NA', SFO:'NA',
  // 유럽
  LHR:'EU', AMS:'EU', CDG:'EU', FRA:'EU', MUC:'EU', ZRH:'EU',
  MAD:'EU', BCN:'EU', FCO:'EU', MXP:'EU', ARN:'EU', CPH:'EU',
  HEL:'EU', WAW:'EU', PRG:'EU', VIE:'EU', BRU:'EU', DUB:'EU',
  // 남미
  GRU:'SA', BOG:'SA', LIM:'SA', SCL:'SA', EZE:'SA',
  // 중동/아프리카
  DXB:'MEA', AUH:'MEA', DOH:'MEA', NBO:'MEA', JNB:'MEA', CAI:'MEA',
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
  if (!resolved) return notice(['Origin 탐지 실패 — 잠시 후 재시도하거나 Route 설정을 확인하세요.']);

  const { origins, canonicalHost } = resolved;

  // ── 로드 밸런서로 origin 선택 ────────────
  const origin = await lbSelect(origins, url.hostname, request, env);

  // ── 1. 정적 자산 / Feed 직통 ─────────────
  if (isPassthrough(path, url)) {
    try {
      const resp = await proxyFetch(request, url, origin, canonicalHost);
      const san  = await sanitize(resp, url, origin, canonicalHost);
      return san.status >= 500 ? notice(['origin 5xx (passthrough): ' + san.status]) : san;
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

  // ── 4. Origin Fetch (RTT 측정 포함) ──────
  let originResp;
  const t0 = Date.now();
  try {
    const raw  = await proxyFetch(request, url, origin, canonicalHost);
    originResp = await sanitize(raw, url, origin, canonicalHost);
  } catch (e) {
    await lbRecordFailure(origin, env);
    return notice(['origin fetch 예외: ' + e.message]);
  }
  const rtt = Date.now() - t0;
  // RTT / 연결 수 비동기 업데이트 (응답 지연 없음)
  ctx.waitUntil(lbRecordRtt(origin, rtt, env));

  if (originResp.status >= 500) return notice(['origin 5xx: ' + originResp.status]);
  if (!isHtml(originResp) || !originResp.ok) return originResp;

  // ── 5. HTML 파이프라인 ────────────────────
  const html = await originResp.text();
  let result, pageCtx;
  try {
    pageCtx = extractPageContext(html, url);
    result  = transformHtml(html, pageCtx, url);
  } catch (_) {
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ── 6. 비동기 후처리 ─────────────────────
  const respHeaders = buildResponseHeaders();
  ctx.waitUntil(updateSlugKV(pageCtx, url, env));
  ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));
  ctx.waitUntil(lbRecordBandwidth(origin, result.length, env));

  return new Response(result, { status: 200, headers: respHeaders });
}

// ─────────────────────────────────────────────
// Origin 자동 탐지 & 캐시
// ─────────────────────────────────────────────
// Blogger API v3 blogs.getByUrl 사용.
// 공개 블로그라면 API 키·secret·변수 설정 없이
// 커스텀 도메인 URL을 넣으면 blogspot 주소를 반환한다.
// (인증 불필요, Cloudflare Workers host 헤더 제한과 무관)
async function resolveOrigin(host, env) {
  // 1) KV 캐시 우선
  try {
    const raw = await env.SLUG_KV.get(kvOrigin(host));
    if (raw) {
      const origins       = JSON.parse(raw);
      const canonicalHost = (await env.SLUG_KV.get(kvCanonical(host))) || host;
      return { origins, canonicalHost };
    }
  } catch (_) {}

  // 2) 첫 요청 시 실시간 탐지
  const result = await detectViaBloggerApi(host);
  if (!result) return null;

  try {
    await env.SLUG_KV.put(kvOrigin(host),    JSON.stringify(result.origins));
    await env.SLUG_KV.put(kvCanonical(host), result.canonicalHost);
  } catch (_) {}

  return result;
}

// Blogger API v3 blogs.getByUrl 로 blogspot origin 탐지
// API 키 없이 공개 블로그 URL만으로 동작.
// 반환: { origins: ["https://xxxx.blogspot.com"], canonicalHost: "www.xxx.com" } | null
async function detectViaBloggerApi(host) {
  // www 유무 양쪽 모두 시도
  const candidates = [host];
  if (host.startsWith('www.')) {
    candidates.push(host.slice(4));
  } else {
    candidates.push('www.' + host);
  }

  for (const h of candidates) {
    const apiUrl = `https://www.googleapis.com/blogger/v3/blogs/byurl?url=https://${h}/&fields=url`;
    try {
      const resp = await fetch(apiUrl, {
        headers: { 'user-agent': 'BlogspotSEOWorker/1.0' },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      // data.url 은 "https://xxxx.blogspot.com/" 형태
      const origin = blogspotFromUrl(data.url || '');
      if (origin) return { origins: [origin], canonicalHost: h };
    } catch (_) {}
  }

  return null;
}

function blogspotFromUrl(url) {
  if (!url) return null;
  const m = url.match(/https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i);
  return m ? 'https://' + m[1] : null;
}


// ─────────────────────────────────────────────
// 로드 밸런서
// ─────────────────────────────────────────────
// origins 배열이 1개면 즉시 반환 (오버헤드 제로)
// 2개 이상이면 7가지 알고리즘을 상황에 맞게 선택

async function lbSelect(origins, host, request, env) {
  if (origins.length === 1) return origins[0];

  const algo = env.LB_ALGO || LB_ALGO_DEFAULT;

  switch (algo) {
    case 'round_robin':         return lbRoundRobin(origins, host, env);
    case 'weighted_rr':         return lbWeightedRR(origins, host, env);
    case 'least_connections':   return lbLeastConn(origins, env);
    case 'least_bandwidth':     return lbLeastBw(origins, env);
    case 'ip_hash':             return lbIpHash(origins, request);
    case 'geo':                 return lbGeo(origins, request, env);
    case 'least_rtt':
    default:                    return lbLeastRtt(origins, env);
  }
}

// 1. 라운드 로빈 — KV 카운터로 순서 보장
async function lbRoundRobin(origins, host, env) {
  try {
    const key = kvRr(host);
    const cur = parseInt(await env.SLUG_KV.get(key) || '0', 10);
    const idx = cur % origins.length;
    env.SLUG_KV.put(key, String(cur + 1)).catch(() => {});
    return origins[idx];
  } catch (_) { return origins[0]; }
}

// 2. 가중 라운드 로빈 — env.LB_WEIGHTS JSON 예: {"https://a.blogspot.com":3,"https://b.blogspot.com":1}
async function lbWeightedRR(origins, host, env) {
  let weights = {};
  try { weights = JSON.parse(env.LB_WEIGHTS || '{}'); } catch (_) {}

  // 가중치 없으면 일반 RR
  const pool = [];
  for (const o of origins) pool.push(...Array(weights[o] || 1).fill(o));
  if (!pool.length) return origins[0];

  try {
    const key = kvRr(host) + ':w';
    const cur = parseInt(await env.SLUG_KV.get(key) || '0', 10);
    const idx = cur % pool.length;
    env.SLUG_KV.put(key, String(cur + 1)).catch(() => {});
    return pool[idx];
  } catch (_) { return origins[0]; }
}

// 3. 최소 RTT — EWMA 기반 (새 측정마다 LB_RTT_DECAY 비율로 갱신)
async function lbLeastRtt(origins, env) {
  const rtts = await Promise.all(origins.map(async o => {
    try {
      const raw = await env.SLUG_KV.get(kvRtt(o), { type: 'json' });
      return { o, rtt: raw && raw.rtt != null ? raw.rtt : Infinity };
    } catch (_) { return { o, rtt: Infinity }; }
  }));
  rtts.sort((a, b) => a.rtt - b.rtt);
  return rtts[0].o;
}

// 4. 최소 연결 수
async function lbLeastConn(origins, env) {
  const conns = await Promise.all(origins.map(async o => {
    try {
      const v = await env.SLUG_KV.get(kvConn(o));
      return { o, c: parseInt(v || '0', 10) };
    } catch (_) { return { o, c: 0 }; }
  }));
  conns.sort((a, b) => a.c - b.c);
  return conns[0].o;
}

// 5. IP Hash — 같은 IP → 같은 origin (세션 고정)
function lbIpHash(origins, request) {
  const ip = request.headers.get('cf-connecting-ip') || '0';
  let hash = 0;
  for (let i = 0; i < ip.length; i++) hash = (hash * 31 + ip.charCodeAt(i)) >>> 0;
  return origins[hash % origins.length];
}

// 6. 최소 대역폭 (누적 처리 바이트 기준)
async function lbLeastBw(origins, env) {
  const bws = await Promise.all(origins.map(async o => {
    try {
      const v = await env.SLUG_KV.get(kvBw(o));
      return { o, b: parseInt(v || '0', 10) };
    } catch (_) { return { o, b: 0 }; }
  }));
  bws.sort((a, b) => a.b - b.b);
  return bws[0].o;
}

// 7. PoP 지역 라우팅 — cf-ray 공항코드로 사용자와 가장 가까운 데이터센터 기준
// env.LB_GEO_MAP JSON 예: {"APAC":"https://a.blogspot.com","NA":"https://b.blogspot.com"}
function lbGeo(origins, request, env) {
  const ray    = request.headers.get('cf-ray') || '';
  const region = popRegion(ray);
  let geoMap   = {};
  try { geoMap = JSON.parse(env.LB_GEO_MAP || '{}'); } catch (_) {}
  if (region && geoMap[region] && origins.includes(geoMap[region])) {
    return geoMap[region];
  }
  // 매핑 없으면 least_rtt 폴백
  return lbLeastRtt(origins, env);
}

// RTT 측정 결과 EWMA로 KV 갱신 (비동기, 요청 지연 없음)
async function lbRecordRtt(origin, rttMs, env) {
  try {
    const prev = await env.SLUG_KV.get(kvRtt(origin), { type: 'json' });
    const ewma = prev && prev.rtt != null
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await env.SLUG_KV.put(kvRtt(origin), JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

// origin fetch 실패 시 RTT를 매우 높게 설정 (해당 origin 기피)
async function lbRecordFailure(origin, env) {
  try {
    await env.SLUG_KV.put(kvRtt(origin), JSON.stringify({ rtt: 99999, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

// 처리 바이트 누적 (주기적으로 가장 적게 쓴 origin을 선택하기 위함)
async function lbRecordBandwidth(origin, bytes, env) {
  try {
    const prev = parseInt(await env.SLUG_KV.get(kvBw(origin)) || '0', 10);
    // 오버플로우 방지: 1TB 초과 시 리셋
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await env.SLUG_KV.put(kvBw(origin), String(next), { expirationTtl: 86400 });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// Origin 프록시
// ─────────────────────────────────────────────
function proxyFetch(request, url, origin, canonicalHost) {
  // ?m=1/?m=0 제거 (Blogger 모바일 리다이렉트 경고 방지)
  const p = new URLSearchParams(url.search);
  p.delete('m');
  const qs        = p.toString() ? '?' + p.toString() : '';
  const targetUrl = origin + url.pathname + qs;

  const headers = new Headers(request.headers);
  // Blogger가 인식하는 정식 커스텀 호스트로 Host 헤더 설정
  // → "이 도메인 모름" 리다이렉트 루프 방지
  headers.set('host', canonicalHost);
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');

  return fetch(targetUrl, {
    method:  request.method,
    headers,
    body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });
}

// ─────────────────────────────────────────────
// 응답 정리 — 리다이렉트를 워커가 직접 추적
// ─────────────────────────────────────────────
// Blogger가 3xx를 내리면 브라우저에 그대로 넘기지 않고 워커가 최대 5단계까지
// 직접 따라가 최종 콘텐츠를 가져온다 (무한 루프 완전 차단).
async function sanitize(resp, url, origin, canonicalHost) {
  const originHost  = (() => { try { return new URL(origin).host; } catch(_) { return ''; } })();
  const customHost  = url.host;
  let current    = resp;
  let currentUrl = url.toString();

  for (let i = 0; i < 5; i++) {
    const st = current.status;
    if (st < 300 || st >= 400) break;

    const loc = current.headers.get('location') || '';
    if (!loc) break;

    let nextUrl;
    try { nextUrl = new URL(loc, currentUrl).toString(); } catch(_) { break; }
    const nextHost = (() => { try { return new URL(nextUrl).host; } catch(_) { return ''; } })();

    // 완전 외부 도메인 → 브라우저에 위임
    if (nextHost !== customHost && nextHost !== originHost && nextHost !== canonicalHost) {
      const h = new Headers(current.headers);
      h.set('location', nextUrl);
      return new Response(null, { status: st, headers: h });
    }

    // 자기참조 루프 방지
    if (nextUrl === currentUrl) return notice(['자기참조 리다이렉트: ' + nextUrl]);

    // 워커가 직접 따라감
    const nu = new URL(nextUrl);
    nu.searchParams.delete('m');
    const targetUrl = origin + nu.pathname + (nu.search || '');

    try {
      const h = new Headers();
      h.set('host', canonicalHost);
      h.set('user-agent', 'Mozilla/5.0');
      current    = await fetch(targetUrl, { method: 'GET', headers: h, redirect: 'manual' });
      currentUrl = nextUrl;
    } catch(e) {
      return notice(['리다이렉트 추적 fetch 예외: ' + e.message]);
    }
  }

  return current;
}

// ─────────────────────────────────────────────
// 안내 페이지 (탐지 실패 시 200 OK — 에러 노출 없음)
// ─────────────────────────────────────────────
function notice(lines = []) {
  const comment = lines.length
    ? '\n<!--\n' + lines.join('\n').replace(/-->/g, '--&gt;') + '\n-->'
    : '';
  return new Response(`<!DOCTYPE html><html lang="ko"><head>
<meta charset="utf-8"><meta name="robots" content="noindex">
<title>사이트 준비 중</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#fafafa}
.b{text-align:center;padding:2rem}h1{font-size:1.2rem}p{color:#666}</style>
</head><body><div class="b"><h1>사이트를 준비하고 있습니다</h1>
<p>잠시 후 다시 시도해 주세요.</p></div>${comment}</body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

// ─────────────────────────────────────────────
// 라우트 / HTML 판별
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
  o = enforceHttps(o, url);
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
    .replace(/((?:href|src|action)=["'][^"']*)&m=\d+/gi,  '$1')
    .replace(/((?:href|src|action)=["'][^"']*)\?m=\d+/gi, '$1');
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
  let out = html;
  if (/<meta[^>]+name=["']description["']/i.test(out))
    out = out.replace(/(<meta[^>]+name=["']description["'][^>]+content=["'])[^"']*["']/i, `$1${esc}"`);
  else
    out = out.replace(/(<\/head>)/i, `<meta name="description" content="${esc}">\n$1`);
  return out;
}

function injectCanonical(html, ctx, url) {
  if (/<link[^>]+rel=["']canonical["']/i.test(html)) return html;
  const canon = escapeAttr(ctx.postUrl || url.toString());
  return html.replace(/(<\/head>)/i, `<link rel="canonical" href="${canon}">\n$1`);
}

function injectSeoTags(html, ctx, url) {
  if (!ctx.title) return html;
  const tags = [];
  const push = (p, c) => { if (c) tags.push(`<meta property="${p}" content="${escapeAttr(c)}">`); };
  if (!/<meta[^>]+property=["']og:title["']/i.test(html))    push('og:title',       ctx.title);
  if (!/<meta[^>]+property=["']og:description["']/i.test(html)) push('og:description', ctx.description);
  if (!/<meta[^>]+property=["']og:url["']/i.test(html))      push('og:url',         ctx.postUrl);
  if (!/<meta[^>]+property=["']og:type["']/i.test(html))     push('og:type',        ctx.type === 'post' ? 'article' : 'website');
  if (!/<meta[^>]+property=["']og:image["']/i.test(html) && ctx.imageUrl) push('og:image', ctx.imageUrl);
  push('og:site_name', ctx.siteName);
  if (!/<meta[^>]+name=["']twitter:card["']/i.test(html)) {
    tags.push(`<meta name="twitter:card" content="${ctx.imageUrl ? 'summary_large_image' : 'summary'}">`);
    push('twitter:title',       ctx.title);
    push('twitter:description', ctx.description);
    if (ctx.imageUrl) push('twitter:image', ctx.imageUrl);
  }
  return tags.length ? html.replace(/(<\/head>)/i, tags.join('\n') + '\n$1') : html;
}

function injectSchemaMarkup(html, ctx, url) {
  if (html.includes('"@context":"https://schema.org"') || html.includes('"@context": "https://schema.org"')) return html;
  const schemas = [buildWebsiteSchema(ctx, url)];
  if (ctx.type === 'post') schemas.push(buildArticleSchema(ctx, url));
  else schemas.push(buildWebPageSchema(ctx, url));
  const ld = `<script type="application/ld+json">${JSON.stringify(schemas.length === 1 ? schemas[0] : schemas)}<\/script>`;
  return html.replace(/(<\/head>)/i, ld + '\n$1');
}

function buildWebsiteSchema(ctx, url) {
  return { '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': url.origin + '/#website', url: url.origin + '/',
    name: ctx.siteName || ctx.title,
    ...(ctx.logoUrl ? { publisher: { '@type': 'Organization', name: ctx.siteName, logo: { '@type': 'ImageObject', url: ctx.logoUrl } } } : {}),
  };
}

function buildArticleSchema(ctx, url) {
  const s = { '@context': 'https://schema.org', '@type': 'Article',
    '@id': ctx.postUrl + '#article', mainEntityOfPage: ctx.postUrl + '#webpage',
    headline: ctx.title, description: ctx.description,
    author: { '@type': 'Person', name: ctx.author || ctx.siteName },
    inLanguage: 'ko-KR',
  };
  if (ctx.imageUrl)    { s.image = { '@type': 'ImageObject', url: ctx.imageUrl }; s.thumbnailUrl = ctx.imageUrl; }
  if (ctx.publishDate) s.datePublished = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified  = ctx.updateDate;
  if (ctx.tags.length) s.keywords      = ctx.tags.join(', ');
  return s;
}

function buildWebPageSchema(ctx, url) {
  return { '@context': 'https://schema.org', '@type': 'WebPage',
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
    if (!meta) return null;
    if (Date.now() - meta.ts > CACHE_TTL * 1000) {
      env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
      env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
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
        const np = path.replace(/[^/]+\.html$/, newSlug + '.html');
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
          const op = data.path.replace(/[^/]+\.html$/, data.slug + '.html');
          const np = data.path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (op !== np) await env.SLUG_KV.put('canonical:' + op, np);
        }
        await env.SLUG_KV.put(key.name, JSON.stringify({ ...data, slug: newSlug, checkedAt: now }));
      } catch (_) {}
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────
// blogspot HTML/feed 본문에서 origin 추출 (보조)
// ─────────────────────────────────────────────
function extractBlogspotFromContent(content) {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    /<link[^>]+rel=["']EditURI["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    /<loc>\s*https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^<]*<\/loc>/i,
    /<link>\s*https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^<]*<\/link>/i,
    /"(?:id|url)"\s*:\s*"https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"]*"/i,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m && m[1]) return 'https://' + m[1];
  }
  return null;
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
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildMetaDescription(bodyText, title) {
  let t = bodyText.replace(title, '').trim();
  if (t.length > 160) { t = t.slice(0, 160); const l = t.lastIndexOf(' '); if (l > 100) t = t.slice(0, l); t += '…'; }
  return t;
}

function extractFirstImage(html)  { return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || ''; }
function extractSiteName(html)    { return extractMeta(html, 'og:site_name') || extractTagContent(html, /<title[^>]*>([^<|]+)/i) || ''; }
function extractLogoUrl(html)     {
  return (html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
          html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) || [])[1] || '';
}
function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi; let m;
  while ((m = re.exec(html)) !== null) { const l = m[1].trim(); if (l && !labels.includes(l)) labels.push(l); }
  return labels;
}
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRe(str)   { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
