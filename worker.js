/**
 * Blogspot SEO & Performance Optimization Worker
 * ------------------------------------------------
 * 설정 불필요 — Blogspot 원본 주소 자동 감지
 *
 * 동작 원리:
 *   1) KV(SLUG_KV)에 캐시된 origin(blogspot.com 백엔드) 사용 (가장 빠름)
 *   2) 없으면 커스텀 도메인 응답/ghs.google.com에서 실제 blogspot.com을 추출
 *      (도메인명 추측은 절대 하지 않음 — 항상 응답 안의 실제 참조만 사용)
 *   3) 추출된 origin을 KV에 영구 저장 (이후 요청은 1번 경로)
 *
 * 중요 — 사용자에게는 항상 커스텀 도메인만 노출됨:
 *   - 워커는 사용자의 "개인(커스텀) 도메인"에서 요청을 받는다.
 *   - blogspot.com은 콘텐츠를 가져오기 위한 내부 백엔드 주소일 뿐,
 *     절대 브라우저 주소창에 노출되면 안 된다.
 *   - 원본(Blogger)에 요청할 때 Host 헤더를 커스텀 도메인으로 유지해야
 *     Blogger가 "정식 도메인"으로 리다이렉트시키지 않는다.
 *   - 혹시 원본이 3xx를 주더라도 sanitizeOriginResponse가 Location을
 *     커스텀 도메인 기준으로 재작성해 blogspot.com이 노출되지 않게 한다.
 */

const CACHE_TTL     = 30 * 60;
const SLUG_CHECK_MS = 6 * 30 * 24 * 3600 * 1000;
const ORIGIN_KV_KEY = '__blogspot_origin__';

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── 프로브 가드 (무한 루프 절대 방지) ────
    // resolveOrigin의 detectFromSelf가 "이 커스텀 도메인 자신"에게 직접
    // fetch를 보내 Blogger의 진짜 응답을 엿보려고 시도한다. 만약 그 도메인이
    // 같은 zone에서 이 워커로 라우팅되어 있다면, 그 fetch는 워커 자신의
    // fetch() 핸들러로 다시 들어온다. 이 경우 resolveOrigin → fetch →
    // resolveOrigin → fetch → ... 무한 재귀가 발생할 수 있으므로,
    // detectFromSelf는 요청에 X-Origin-Probe 헤더를 반드시 심어 보내고,
    // 여기서 그 헤더를 발견하면 즉시 502를 돌려주어 재귀를 1회 안에 끊는다.
    // (이 502는 detectFromSelf 입장에서 "자기 호출이었다"는 명확한 신호이며,
    //  반대로 이 헤더 없이 정상 HTML이 오면 "Blogger가 직접 응답했다"는 뜻이다.)
    if (request.headers.get('x-origin-probe') === '1') {
      return new Response('probe-loop-detected', { status: 502 });
    }

    // ── 원본 자동 감지 ───────────────────────
    const resolved = await resolveOrigin(request, url, env);
    const origin   = resolved.origin;
    if (!origin) {
      const debugInfo = (resolved.debug || []).join(' / ');
      return new Response(
        'Blogspot 원본을 자동 감지할 수 없습니다. 도메인이 Blogspot에 연결되어 있는지 확인하세요.\n\n[디버그] ' + debugInfo,
        { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    // ── 1. 정적 자산 / Feed → 원본 직통 ─────
    if (isPassthrough(path, url)) {
      const resp = await proxyToOrigin(request, url, origin);
      return sanitizeOriginResponse(resp, url, origin);
    }

    // ── 2. 슬러그 canonical 리다이렉트 ──────
    const slugRedirect = await checkSlugRedirect(path, url, env);
    if (slugRedirect) return slugRedirect;

    // ── 3. Cache Reserve 조회 ───────────────
    const cacheKey = buildCacheKey(url);
    const cached   = await getCacheReserve(cacheKey, env);
    if (cached) {
      return new Response(cached.body, {
        status:  200,
        headers: buildCachedHeaders(cached.headers),
      });
    }

    // ── 4. Blogspot 원본 직접 Fetch ─────────
    const rawOriginResp = await proxyToOrigin(request, url, origin);
    const originResp    = sanitizeOriginResponse(rawOriginResp, url, origin);
    if (!isHtml(originResp) || !originResp.ok) return originResp;

    // ── 5. HTML 파이프라인 ──────────────────
    const html    = await originResp.text();
    const pageCtx = extractPageContext(html, url);
    const result  = transformHtml(html, pageCtx, url);

    // ── 6. 비동기 후처리 ────────────────────
    const respHeaders = buildResponseHeaders();
    ctx.waitUntil(updateSlugKV(pageCtx, url, env));
    ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));

    return new Response(result, { status: 200, headers: respHeaders });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env));
  },
};

// ─────────────────────────────────────────────
// Blogspot 원본 자동 감지
// ─────────────────────────────────────────────
async function resolveOrigin(request, url, env) {
  const debug = [];

  // 0) wrangler.toml의 vars에 BLOGSPOT_ORIGIN을 직접 지정한 경우 (가장 빠르고 확실함)
  const configured = (env.BLOGSPOT_ORIGIN || '').trim();
  if (configured) {
    const normalized = normalizeBlogspotOrigin(configured);
    if (normalized) {
      try { await env.SLUG_KV.put(ORIGIN_KV_KEY, normalized); } catch (_) {}
      return { origin: normalized, debug };
    }
    debug.push('BLOGSPOT_ORIGIN 값이 올바르지 않음: "' + configured + '" (예: xxxx.blogspot.com 또는 https://xxxx.blogspot.com)');
  }

  // 1) KV 캐시 확인 (가장 빠른 경로, 이후 모든 요청은 여기서 끝남)
  try {
    const cached = await env.SLUG_KV.get(ORIGIN_KV_KEY);
    if (cached) return { origin: cached, debug };
  } catch (e) { debug.push('KV get 실패: ' + e.message); }

  const customHost = url.hostname;

  // 2) 커스텀 도메인 자신에게 직접 요청 (X-Origin-Probe 헤더로 무한 루프 방지).
  //    같은 zone에서 이 워커로 라우팅되어 있다면 위쪽 프로브 가드가 즉시
  //    502를 돌려주므로 안전하게 "자기 호출이었다"고 판별하고 다음 단계로 넘어간다.
  //    반대로 Blogger가 직접 응답하면(이 도메인이 다른 라우팅을 거치는 경우,
  //    또는 일부 환경에서 워커 라우팅 전에 오리진으로 먼저 가는 경우) 그 응답
  //    안에서 실제 blogspot.com 참조를 추출한다.
  try {
    const r = await detectFromSelf(customHost);
    if (r.origin) {
      await env.SLUG_KV.put(ORIGIN_KV_KEY, r.origin);
      return { origin: r.origin, debug };
    }
    debug.push('Self: ' + r.reason);
  } catch (e) { debug.push('Self 예외: ' + e.message); }

  // 3) Blogger 공식 API (byurl) — API 키 없으면 403으로 실패함 (참고용 백업)
  try {
    const r = await detectFromBloggerApi(customHost);
    if (r.origin) {
      await env.SLUG_KV.put(ORIGIN_KV_KEY, r.origin);
      return { origin: r.origin, debug };
    }
    debug.push('BloggerAPI: ' + r.reason);
  } catch (e) { debug.push('BloggerAPI 예외: ' + e.message); }

  // 4) ghs.google.com — Cloudflare 환경에서 막히는 경우가 많음 (참고용 백업)
  try {
    const r = await detectFromGhs(customHost);
    if (r.origin) {
      await env.SLUG_KV.put(ORIGIN_KV_KEY, r.origin);
      return { origin: r.origin, debug };
    }
    debug.push('GHS: ' + r.reason);
  } catch (e) { debug.push('GHS 예외: ' + e.message); }

  debug.push('해결: wrangler.toml [vars]에 BLOGSPOT_ORIGIN = "xxxx.blogspot.com" 을 추가하고 재배포하세요.');
  return { origin: null, debug };
}

// customHost로 직접 요청해서, 응답 안에서 실제 blogspot.com 참조를 찾는다.
// X-Origin-Probe 헤더를 반드시 동반하여, 이 요청이 같은 워커로 되돌아올 경우
// 위쪽 가드가 즉시 502(probe-loop-detected)를 주고 무한 재귀를 끊는다.
//
// redirect:'manual'을 사용한다 — 'follow'를 쓰면 fetch가 내부적으로
// 리다이렉트를 자동으로 계속 따라가다가 무한/과도한 리다이렉트 체인에
// 걸려 "Too many redirects" 예외로 죽어버릴 수 있다(예: 워커 앞단의
// www/https 강제 리다이렉트 규칙과 얽히는 경우). manual로 받아서
// 단계마다 직접 검사하면 최대 5단계로 안전하게 제한할 수 있다.
async function detectFromSelf(customHost) {
  const targetUrls = [
    'https://' + customHost + '/',
    'https://' + customHost + '/sitemap.xml',
    'https://' + customHost + '/feeds/posts/default',
    'https://' + customHost + '/feeds/posts/default?alt=rss',
    'https://' + customHost + '/feeds/posts/default?alt=json&max-results=1',
    'https://' + customHost + '/atom.xml',
    'https://' + customHost + '/rss.xml',
  ];

  const reasons = [];

  for (const startUrl of targetUrls) {
    try {
      const r = await followManually(startUrl);
      if (r.origin) return r;
      reasons.push(r.reason);
    } catch (e) {
      reasons.push('fetch 예외(' + startUrl + '): ' + e.message);
    }
  }
  return { origin: null, reason: reasons.join(' | ') };
}

// redirect:'manual'로 최대 5단계까지 직접 리다이렉트를 따라가며,
// 각 단계에서 (1) 워커 자기 호출 여부 (2) blogspot.com 직행 여부
// (3) 응답 본문 안의 blogspot.com 참조를 검사한다.
async function followManually(startUrl) {
  let currentUrl = startUrl;
  const chain = [];

  for (let i = 0; i < 5; i++) {
    let resp;
    try {
      resp = await fetch(currentUrl, {
        method:   'GET',
        redirect: 'manual',
        headers:  { 'user-agent': 'Mozilla/5.0', 'x-origin-probe': '1' },
      });
    } catch (e) {
      return { origin: null, reason: `[${chain.join(' -> ')}] fetch 예외: ${e.message}` };
    }

    chain.push(`${currentUrl} -> ${resp.status} loc="${resp.headers.get('location') || ''}"`);

    // 워커 자기 호출 감지
    if (resp.status === 502) {
      const text = await resp.text().catch(() => '');
      if (text === 'probe-loop-detected') {
        return { origin: null, reason: `자기 자신(워커) 라우팅 감지 [${chain.join(' | ')}]` };
      }
    }

    // 3xx면 Location을 따라 다음 단계로
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location') || '';
      if (!loc) return { origin: null, reason: `[${chain.join(' | ')}] 3xx인데 Location 없음` };
      try {
        const nextUrl = new URL(loc, currentUrl).toString();
        const nextHost = new URL(nextUrl).hostname;
        if (/\.blogspot\.com$/i.test(nextHost)) {
          return { origin: 'https://' + nextHost, reason: null };
        }
        // 자기 자신과 완전히 동일한 URL로의 리다이렉트는 Cloudflare 레벨의
        // 설정 문제(예: Redirect Rule이 같은 호스트를 다시 가리킴)이지,
        // Blogger 응답이 아니다. 더 따라가도 의미가 없으니 즉시 종료한다.
        if (nextUrl === currentUrl) {
          return { origin: null, reason: `[${chain.join(' | ')}] 자기참조 301 — Cloudflare Redirect Rule/Always-HTTPS 설정 충돌 의심 (Blogger 응답 아님)` };
        }
        currentUrl = nextUrl;
        continue;
      } catch (e) {
        return { origin: null, reason: `[${chain.join(' | ')}] Location 파싱 실패: ${loc}` };
      }
    }

    // 최종 응답(2xx/4xx 등) — 본문에서 blogspot.com 참조 탐색
    const text = await resp.text().catch(() => '');
    const origin = extractBlogspotOriginFromContent(text);
    if (origin) return { origin, reason: null };

    return { origin: null, reason: `[${chain.join(' | ')}] 본문에서 blogspot.com 참조 없음 (len=${text.length})` };
  }

  return { origin: null, reason: `리다이렉트 5단계 초과 — chain=[${chain.join(' | ')}]` };
}

// "xxxx.blogspot.com", "https://xxxx.blogspot.com", "https://xxxx.blogspot.com/" 등
// 다양한 입력 형태를 'https://xxxx.blogspot.com' 형태로 정규화.
function normalizeBlogspotOrigin(value) {
  let v = value.trim();
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const host = new URL(v).hostname;
    if (/^[a-zA-Z0-9-]+\.blogspot\.com$/i.test(host)) return 'https://' + host;
  } catch (_) {}
  return null;
}

// Blogger 공식 API로 커스텀 도메인이 연결된 실제 blogspot.com 블로그를 조회.
async function detectFromBloggerApi(customHost) {
  const apiUrl = 'https://www.googleapis.com/blogger/v3/blogs/byurl?url='
    + encodeURIComponent('https://' + customHost + '/');
  try {
    const resp = await fetch(apiUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { origin: null, reason: `status=${resp.status} body=${body.slice(0, 200)}` };
    }
    const data = await resp.json();
    const blogUrl = data && data.url;
    if (!blogUrl) return { origin: null, reason: 'url 필드 없음: ' + JSON.stringify(data).slice(0, 200) };
    const host = new URL(blogUrl).hostname;
    if (/\.blogspot\.com$/i.test(host)) return { origin: 'https://' + host, reason: null };
    return { origin: null, reason: 'blogspot.com 아님: ' + host };
  } catch (e) {
    return { origin: null, reason: 'fetch 예외: ' + e.message };
  }
}

// ghs.google.com에 Host 헤더로 요청해서 실제 매핑된 blogspot 호스트를 찾는다.
// 중요: HTTPS로 시도하면 SNI가 ghs.google.com인데 Host 헤더는 customHost라서
// Cloudflare 엣지에서 SNI/Host 불일치로 TLS 핸드셰이크 자체가 거부되어
// 525(SSL handshake failed)가 난다. HTTP(평문, 80번 포트)는 TLS 단계가 없어
// 이 문제를 피할 수 있다 — Blogger 커스텀 도메인 CNAME 설정 자체가 원래
// ghs.google.com으로의 평문 HTTP 요청을 전제로 하던 방식이라 호환된다.
async function detectFromGhs(customHost) {
  let lastReason = '';

  // 1) HTTP, manual redirect: Location 헤더에서 추출 (TLS 문제 없음)
  try {
    const resp = await fetch('http://ghs.google.com/', {
      method:   'GET',
      redirect: 'manual',
      headers:  { host: customHost, 'user-agent': 'Mozilla/5.0' },
    });
    const location = resp.headers.get('location') || '';
    const m = location.match(/https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i);
    if (m) return { origin: 'https://' + m[1], reason: null };
    lastReason = `http manual status=${resp.status} location="${location}"`;
  } catch (e) {
    lastReason = 'http manual fetch 예외: ' + e.message;
  }

  // 2) HTTP, follow redirect: 최종 HTML 본문에서 추출
  try {
    const resp = await fetch('http://ghs.google.com/', {
      method:   'GET',
      redirect: 'follow',
      headers:  { host: customHost, 'user-agent': 'Mozilla/5.0' },
    });
    try {
      const finalHost = new URL(resp.url).hostname;
      if (/\.blogspot\.com$/i.test(finalHost)) return { origin: 'https://' + finalHost, reason: null };
    } catch (_) {}
    const html = await resp.text();
    const origin = extractBlogspotOriginFromContent(html);
    if (origin) return { origin, reason: null };
    lastReason += ` | http follow status=${resp.status} finalUrl=${resp.url} bodyLen=${html.length}`;
  } catch (e) {
    lastReason += ' | http follow fetch 예외: ' + e.message;
  }

  // 3) HTTPS 백업 (환경에 따라 525로 막힐 수 있음 — 그래도 시도는 해본다)
  try {
    const resp = await fetch('https://ghs.google.com/', {
      method:   'GET',
      redirect: 'manual',
      headers:  { host: customHost, 'user-agent': 'Mozilla/5.0' },
    });
    const location = resp.headers.get('location') || '';
    const m = location.match(/https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)/i);
    if (m) return { origin: 'https://' + m[1], reason: null };
    lastReason += ` | https manual status=${resp.status} location="${location}"`;
  } catch (e) {
    lastReason += ' | https manual fetch 예외: ' + e.message;
  }

  return { origin: null, reason: lastReason };
}

// HTML/XML/JSON 본문 안에서 신뢰할 수 있는 blogspot.com 참조를 추출.
// canonical / feed 링크 / EditURI / og:url / sitemap <loc> / Atom <id>,<link>
// / RSS <link> 등 Blogger가 자기 자신을 가리키는 자리에서만 추출하여
// 무관한 외부 링크를 배제한다.
function extractBlogspotOriginFromContent(content) {
  const patterns = [
    // HTML <head>
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    /<link[^>]+rel=["']service\.post["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    /<link[^>]+rel=["']EditURI["'][^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["']/i,
    // sitemap.xml: <loc>https://xxxx.blogspot.com/...</loc>
    /<loc>\s*https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^<]*<\/loc>/i,
    // Atom feed: <id>...</id>, <link rel="alternate" href="...">
    /<id>\s*(?:tag:blogger\.com,1999:blog-\d+\.[^,]+|https?:\/\/)?([a-zA-Z0-9-]+\.blogspot\.com)/i,
    /<link[^>]+href=["']https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"']*["'][^>]*\/?>/i,
    // RSS: <link>https://xxxx.blogspot.com/...</link>
    /<link>\s*https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^<]*<\/link>/i,
    // JSON(byurl, feed alt=json 등)
    /"(?:id|url)"\s*:\s*"https?:\/\/([a-zA-Z0-9-]+\.blogspot\.com)[^"]*"/i,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m && m[1]) return 'https://' + m[1];
  }
  return null;
}


// ─────────────────────────────────────────────
// 원본으로 프록시
// ─────────────────────────────────────────────
// 중요: Host 헤더를 blogspot.com으로 바꾸면 안 된다.
// Blogger(GHS)는 Host 헤더로 "이 요청이 어느 도메인으로 들어왔는지"를 판단해서,
// 그 블로그의 정식(커스텀) 도메인과 다르면 자신의 정식 도메인으로 301/302
// 리다이렉트를 내려준다. targetUrl을 *.blogspot.com으로 fetch하면서
// Host까지 blogspot.com으로 덮어쓰면 Blogger 입장에서는 "blogspot.com 주소로
// 직접 들어왔다"고 인식하고, 정식 도메인(커스텀 도메인)이 따로 있으니
// 그쪽으로 리다이렉트 → 결과적으로 응답 본문/위치가 blogspot.com을 가리켜
// 브라우저가 그쪽으로 이동해버린다.
// 해결: Host 헤더는 원래 커스텀 도메인(request의 Host)을 그대로 유지한 채,
// 실제 네트워크 연결만 blogspot.com(origin)으로 보낸다.
function proxyToOrigin(request, url, origin) {
  const targetUrl   = origin + url.pathname + url.search;
  const headers     = new Headers(request.headers);
  const customHost  = url.hostname; // 사용자의 실제(커스텀) 도메인

  // Host는 커스텀 도메인 그대로 — blogspot.com으로 절대 덮어쓰지 않는다.
  headers.set('host', customHost);
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');

  return fetch(targetUrl, {
    method:   request.method,
    headers,
    body:     ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    // 원본에서 리다이렉트가 오더라도 우리가 직접 처리(아래 originResp 검사)하도록
    // manual로 받아서, blogspot.com으로의 리다이렉트를 그대로 흘려보내지 않는다.
    redirect: 'manual',
  });
}

// ─────────────────────────────────────────────
// 원본 응답 정리: blogspot.com을 절대 노출하지 않는다
// ─────────────────────────────────────────────
// proxyToOrigin은 redirect:'manual'로 fetch하므로, Blogger가 자체적으로
// 정식 도메인(blogspot.com)으로 리다이렉트를 내려주는 경우 그 Response가
// 그대로 여기로 들어온다. 이 Location 헤더를 커스텀 도메인 기준으로
// 재작성해서 브라우저가 절대 blogspot.com으로 이동하지 않도록 한다.
function sanitizeOriginResponse(resp, url, origin) {
  const status = resp.status;
  if (status >= 300 && status < 400) {
    const location = resp.headers.get('location') || '';
    if (location) {
      const rewritten = rewriteToCustomDomain(location, url, origin);
      const headers = new Headers(resp.headers);
      headers.set('location', rewritten);
      return new Response(null, { status, headers });
    }
  }
  return resp;
}

// blogspot.com(혹은 원본 origin) 절대/상대 URL을 커스텀 도메인 기준으로 변환
function rewriteToCustomDomain(targetUrl, url, origin) {
  try {
    const originHost = new URL(origin).host;
    const abs = new URL(targetUrl, origin); // 상대 경로도 처리
    if (abs.host === originHost) {
      abs.protocol = url.protocol;
      abs.host     = url.host;
    }
    return abs.toString();
  } catch (_) {
    return targetUrl;
  }
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
  let out = html;
  out = injectMetaDescription(out, ctx);
  out = injectCanonical(out, ctx, url);
  out = injectSchemaMarkup(out, ctx, url);
  out = injectSeoTags(out, ctx, url);
  out = injectPerformanceOptimizations(out);
  return out;
}

// ─────────────────────────────────────────────
// 페이지 컨텍스트 추출
// ─────────────────────────────────────────────
function extractPageContext(html, url) {
  const ctx = {
    type:        detectPageType(url),
    title:       '',
    description: '',
    imageUrl:    '',
    author:      '',
    publishDate: '',
    updateDate:  '',
    tags:        [],
    postUrl:     url.toString(),
    siteName:    extractSiteName(html),
    logoUrl:     extractLogoUrl(html),
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
  if (p === '/' || p === '')                       return 'home';
  if (/\/\d{4}\/\d{2}\/[^/]+\.html$/.test(p))     return 'post';
  if (/^\/p\//.test(p))                            return 'page';
  if (p.startsWith('/search/label/'))               return 'label';
  if (p.startsWith('/search'))                      return 'search';
  return 'other';
}

// ─────────────────────────────────────────────
// 메타 설명 (RankMath 방식, 160자)
// ─────────────────────────────────────────────
function injectMetaDescription(html, ctx) {
  if (!ctx.description) return html;
  const desc = escapeAttr(ctx.description.slice(0, 160));
  if (/<meta[^>]+name=["']description["'][^>]*>/i.test(html)) {
    return html
      .replace(/(<meta[^>]+name=["']description["'][^>]*content=["'])[^"']*(['"][^>]*>)/i, `$1${desc}$2`)
      .replace(/(<meta[^>]+content=["'])[^"']*(['"][^>]+name=["']description["'][^>]*>)/i, `$1${desc}$2`);
  }
  return html.replace(/(<head[^>]*>)/i, `$1\n<meta name="description" content="${desc}">`);
}

// ─────────────────────────────────────────────
// Canonical
// ─────────────────────────────────────────────
function injectCanonical(html, ctx, url) {
  if (/<link[^>]+rel=["']canonical["'][^>]*>/i.test(html)) return html;
  return html.replace(/(<head[^>]*>)/i, `$1\n<link rel="canonical" href="${escapeAttr(url.origin + url.pathname)}">`);
}

// ─────────────────────────────────────────────
// SEO 태그
// ─────────────────────────────────────────────
function injectSeoTags(html, ctx, url) {
  const tags = [];
  if (!/<meta[^>]+name=["']robots["'][^>]*>/i.test(html))
    tags.push('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">');
  if (!/<meta[^>]+property=["']og:title["'][^>]*>/i.test(html) && ctx.title)
    tags.push(`<meta property="og:title" content="${escapeAttr(ctx.title)}">`);
  if (!/<meta[^>]+property=["']og:description["'][^>]*>/i.test(html) && ctx.description)
    tags.push(`<meta property="og:description" content="${escapeAttr(ctx.description.slice(0, 200))}">`);
  if (!/<meta[^>]+property=["']og:url["'][^>]*>/i.test(html))
    tags.push(`<meta property="og:url" content="${escapeAttr(url.origin + url.pathname)}">`);
  if (!/<meta[^>]+property=["']og:type["'][^>]*>/i.test(html))
    tags.push(`<meta property="og:type" content="${ctx.type === 'post' ? 'article' : 'website'}">`);
  if (!/<meta[^>]+property=["']og:site_name["'][^>]*>/i.test(html) && ctx.siteName)
    tags.push(`<meta property="og:site_name" content="${escapeAttr(ctx.siteName)}">`);
  if (!/<meta[^>]+property=["']og:image["'][^>]*>/i.test(html) && ctx.imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeAttr(ctx.imageUrl)}">`);
    tags.push('<meta property="og:image:width" content="1200">');
    tags.push('<meta property="og:image:height" content="630">');
  }
  if (!/<meta[^>]+name=["']twitter:card["'][^>]*>/i.test(html))
    tags.push(`<meta name="twitter:card" content="${ctx.imageUrl ? 'summary_large_image' : 'summary'}">`);
  if (!/<meta[^>]+name=["']twitter:title["'][^>]*>/i.test(html) && ctx.title)
    tags.push(`<meta name="twitter:title" content="${escapeAttr(ctx.title)}">`);
  if (!/<meta[^>]+name=["']twitter:description["'][^>]*>/i.test(html) && ctx.description)
    tags.push(`<meta name="twitter:description" content="${escapeAttr(ctx.description.slice(0, 200))}">`);
  if (!/<meta[^>]+name=["']twitter:image["'][^>]*>/i.test(html) && ctx.imageUrl)
    tags.push(`<meta name="twitter:image" content="${escapeAttr(ctx.imageUrl)}">`);
  if (!tags.length) return html;
  return html.replace('</head>', tags.join('\n') + '\n</head>');
}

// ─────────────────────────────────────────────
// Schema 마크업 (RankMath 방식)
// ─────────────────────────────────────────────
function injectSchemaMarkup(html, ctx, url) {
  if (html.includes('"BreadcrumbList"')) return html;
  const schemas = [];
  if (ctx.type === 'home') {
    schemas.push(buildWebSiteSchema(ctx, url));
    schemas.push(buildOrganizationSchema(ctx, url));
  }
  schemas.push(buildBreadcrumbSchema(ctx, url));
  if (ctx.type === 'post')                          schemas.push(buildArticleSchema(ctx, url));
  if (ctx.type === 'page' || ctx.type === 'other')  schemas.push(buildWebPageSchema(ctx, url));
  const scriptTag = schemas.map(s => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n');
  return html.replace('</head>', scriptTag + '\n</head>');
}

function buildWebSiteSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': url.origin + '/#website', url: url.origin + '/', name: ctx.siteName || ctx.title,
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: url.origin + '/search?q={search_term_string}' }, 'query-input': 'required name=search_term_string' },
  };
}

function buildOrganizationSchema(ctx, url) {
  const s = { '@context': 'https://schema.org', '@type': 'Organization', '@id': url.origin + '/#organization', name: ctx.siteName || ctx.title, url: url.origin + '/' };
  if (ctx.logoUrl) s.logo = { '@type': 'ImageObject', '@id': url.origin + '/#logo', url: ctx.logoUrl, contentUrl: ctx.logoUrl };
  return s;
}

function buildBreadcrumbSchema(ctx, url) {
  const segs  = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  const items = [{ '@type': 'ListItem', position: 1, name: ctx.siteName || '홈', item: url.origin + '/' }];
  let acc     = url.origin;
  segs.forEach((seg, i) => { acc += '/' + seg; items.push({ '@type': 'ListItem', position: i + 2, name: decodeSegmentName(seg), item: acc }); });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}

function buildArticleSchema(ctx, url) {
  const s = {
    '@context': 'https://schema.org', '@type': ['Article', 'BlogPosting'],
    '@id': ctx.postUrl + '#article', url: ctx.postUrl, headline: ctx.title, description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' },
    author: { '@type': 'Person', name: ctx.author || ctx.siteName || 'Author' },
    publisher: { '@type': 'Organization', '@id': url.origin + '/#organization', name: ctx.siteName || '' },
    inLanguage: 'ko-KR',
  };
  if (ctx.imageUrl)    { s.image = { '@type': 'ImageObject', url: ctx.imageUrl }; s.thumbnailUrl = ctx.imageUrl; }
  if (ctx.publishDate) s.datePublished = ctx.publishDate;
  if (ctx.updateDate)  s.dateModified  = ctx.updateDate;
  if (ctx.tags.length) s.keywords      = ctx.tags.join(', ');
  return s;
}

function buildWebPageSchema(ctx, url) {
  return {
    '@context': 'https://schema.org', '@type': 'WebPage',
    '@id': ctx.postUrl + '#webpage', url: ctx.postUrl, name: ctx.title, description: ctx.description,
    isPartOf: { '@id': url.origin + '/#website' }, inLanguage: 'ko-KR',
    ...(ctx.publishDate ? { datePublished: ctx.publishDate } : {}),
    ...(ctx.updateDate  ? { dateModified:  ctx.updateDate  } : {}),
  };
}

// ─────────────────────────────────────────────
// 성능 최적화
// ─────────────────────────────────────────────
function injectPerformanceOptimizations(html) {
  if (html.includes('rel="dns-prefetch"')) return html;
  const perfTags = [
    '<link rel="dns-prefetch" href="//www.blogger.com">',
    '<link rel="dns-prefetch" href="//www.gstatic.com">',
    '<link rel="dns-prefetch" href="//fonts.googleapis.com">',
    '<link rel="dns-prefetch" href="//fonts.gstatic.com">',
    '<link rel="dns-prefetch" href="//pagead2.googlesyndication.com">',
    '<link rel="preconnect" href="https://www.gstatic.com" crossorigin>',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  ].join('\n');
  let out = html.replace(/(<head[^>]*>)/i, `$1\n${perfTags}`);
  out = out.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" decoding="async"');
  out = out.replace(/(<script(?![^>]*(defer|async|type=["']application\/ld\+json["']|type=["']text\/template["']))[^>]*src=["'][^"']+["'][^>]*)>/gi, '$1 defer>');
  return out;
}

// ─────────────────────────────────────────────
// Cache Reserve
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const sorted = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (sorted.toString() ? '?' + sorted : '');
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
    if (!body) return null;
    return { body, headers: meta.headers };
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
  const path = url.pathname, generated = generateSlug(ctx.title);
  try {
    const existing = await env.SLUG_KV.get('slug:' + path, { type: 'json' });
    const now      = Date.now();
    if (!existing) {
      await env.SLUG_KV.put('slug:' + path, JSON.stringify({ title: ctx.title, slug: generated, path, createdAt: now, checkedAt: now }));
    } else if (now - existing.checkedAt > SLUG_CHECK_MS) {
      const newSlug = generateSlug(ctx.title);
      if (newSlug !== existing.slug) {
        const oldPath = path.replace(/[^/]+\.html$/, existing.slug + '.html');
        const newPath = path.replace(/[^/]+\.html$/, newSlug + '.html');
        if (oldPath !== newPath) await env.SLUG_KV.put('canonical:' + oldPath, newPath);
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
          const oldPath = data.path.replace(/[^/]+\.html$/, data.slug + '.html');
          const newPath = data.path.replace(/[^/]+\.html$/, newSlug + '.html');
          if (oldPath !== newPath) await env.SLUG_KV.put('canonical:' + oldPath, newPath);
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
  let slug = title.trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[_]+/g, '-')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/[^\p{L}\p{N}\-]/gu, '-')
    .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (/[^\x00-\x7F]/.test(slug))
    slug = encodeURIComponent(slug).replace(/%20/g, '-').replace(/%2F/gi, '-');
  return slug || 'post';
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
  h.set('x-cache',      'HIT');
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
    html.match(new RegExp(`<meta[^>]+name=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i'))    ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`, 'i'))    ||
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
  let text = bodyText.replace(title, '').trim();
  if (text.length > 160) {
    text = text.slice(0, 160);
    const last = text.lastIndexOf(' ');
    if (last > 100) text = text.slice(0, last);
    text += '…';
  }
  return text;
}

function extractFirstImage(html)  { return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || ''; }
function extractSiteName(html)    { return extractMeta(html, 'og:site_name') || extractTagContent(html, /<title[^>]*>([^<|]+)/i) || ''; }
function extractLogoUrl(html)     {
  return (
    html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) || []
  )[1] || '';
}
function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi; let m;
  while ((m = re.exec(html)) !== null) { const l = m[1].trim(); if (l && !labels.includes(l)) labels.push(l); }
  return labels;
}
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function decodeSegmentName(seg) { try { return decodeURIComponent(seg.replace(/\.html$/, '').replace(/-/g, ' ')); } catch (_) { return seg; } }
function escapeAttr(str) { return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(str)   { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
