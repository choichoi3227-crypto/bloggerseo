/**
 * Blogspot SEO & Performance Optimization Worker
 * ─────────────────────────────────────────────────
 * - blogspot.com 원본 탐지 없음
 * - 리다이렉트 추적 없음 (redirect: 'manual')
 * - cf.resolveOverride: 'ghs.google.com' 으로 DNS 우회
 * - CNAME 검증 실패해도 차단하지 않음 (soft 검증)
 * - 525 등 SSL 에러 방지
 */

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
const CACHE_TTL       = 30 * 60;
const CNAME_CACHE_TTL = 24 * 3600 * 1000;
const SLUG_CHECK_MS   = 6 * 30 * 24 * 3600 * 1000;
const LB_RTT_DECAY    = 0.25;
const LB_RTT_TTL      = 60;
const GHS_TARGET      = 'ghs.google.com';
const DOH_URL         = 'https://1.1.1.1/dns-query';

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
      return errResp(502, 'Worker exception: ' + String(e && e.message || e));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlugAudit(env));
  },
};

async function handleFetch(request, env, ctx) {
  const url  = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;

  // ── 디버그 엔드포인트 /__blogger_debug ────────
  if (path === '/__blogger_debug') {
    return bloggerDebug(url, env);
  }

  // ── 캐시 전체 purge: /__purge_all ────────────
  if (path === '/__purge_all') {
    return purgeAll(env);
  }

  // ── CNAME 검증 (soft: 실패해도 차단 안 함, 로그만) ──
  ctx.waitUntil(warmCnameCache(host, env));

  // ── 1. 정적 자산 / Feed / Sitemap 직통 ──────
  if (isPassthrough(path, url)) {
    return proxyPass(url, request, env);
  }

  // ── 2. 캐시 우회 판별 ────────────────────────
  // - GET/HEAD 이외 메서드 (POST 등)
  // - ?purge=1 파라미터
  // - Cache-Control: no-cache 요청 헤더
  // - Blogger 관리/동적 경로 (/b/, /ncr, ?blogedit 등)
  const bypassCache = shouldBypassCache(request, url, path);

  // purge 모드: KV에서 해당 키 삭제 후 origin에서 새로 가져옴
  if (bypassCache && url.searchParams.get('purge') === '1') {
    const cacheKey = buildCacheKey(url);
    await deleteCacheReserve(cacheKey, env);
    // purge 파라미터 제거한 URL로 리다이렉트
    const clean = new URL(url.toString());
    clean.searchParams.delete('purge');
    return Response.redirect(clean.toString(), 302);
  }

  // 캐시 우회: origin 직통
  if (bypassCache) {
    return proxyPass(url, request, env);
  }

  // ── 3. 슬러그 라우팅 ──────────────────────────
  const slugRoute = await resolveSlugRoute(path, url, env);

  if (slugRoute.type === 'redirect') {
    // 원본 blogspot 경로 → 제목 슬러그 경로로 301
    const dest = new URL(url.toString());
    dest.pathname = slugRoute.titlePath;
    return Response.redirect(dest.toString(), 301);
  }

  // alias 경로(제목 슬러그)로 들어온 요청:
  // KV에서 찾은 원본 경로로 내부 fetch하되 응답 URL은 슬러그 그대로 유지
  const fetchUrl = slugRoute.type === 'alias'
    ? (() => { const u = new URL(url.toString()); u.pathname = slugRoute.originPath; return u; })()
    : url;

  // ── 4. KV Cache Reserve ──────────────────────
  const cacheKey = buildCacheKey(url);  // 캐시 키는 슬러그 URL 기준
  const cached   = await getCacheReserve(cacheKey, env);
  if (cached) {
    return new Response(cached.body, { status: 200, headers: buildCachedHeaders(cached.headers) });
  }

  // ── 5. Origin Fetch ──────────────────────────
  let originResp;
  const t0 = Date.now();
  try {
    originResp = await bloggerFetch(fetchUrl, 'GET', request.headers);
  } catch (e) {
    return errResp(502, 'Fetch failed: ' + e.message);
  }
  const rtt = Date.now() - t0;
  ctx.waitUntil(lbRecordRtt(host, rtt, env));

  // 3xx: 리다이렉트 그대로 반환 (루프 방지)
  if (originResp.status >= 300 && originResp.status < 400) {
    return stripInternalHeaders(originResp);
  }

  if (originResp.status >= 500) return errResp(originResp.status, 'Origin error ' + originResp.status);
  if (!isHtml(originResp) || !originResp.ok) return stripInternalHeaders(originResp);

  // ── 6. HTML 파이프라인 ────────────────────────
  const html = await originResp.text();
  let result, pageCtx;
  try {
    pageCtx = extractPageContext(html, url);
    result  = transformHtml(html, pageCtx, url);
  } catch (_) {
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ── 7. 비동기 후처리 ──────────────────────────
  const respHeaders = buildResponseHeaders();
  ctx.waitUntil(updateSlugKV(pageCtx, url, env));
  ctx.waitUntil(setCacheReserve(cacheKey, result, respHeaders, env));
  ctx.waitUntil(lbRecordBandwidth(host, result.length, env));

  return new Response(result, { status: 200, headers: respHeaders });
}

// ─────────────────────────────────────────────
// 캐시 우회 판별
// ─────────────────────────────────────────────
function shouldBypassCache(request, url, path) {
  // GET/HEAD 이외 메서드
  if (!['GET', 'HEAD'].includes(request.method)) return true;
  // purge 파라미터
  if (url.searchParams.get('purge') === '1') return true;
  // 브라우저 강력 새로고침 (Cache-Control: no-cache)
  if (request.headers.get('cache-control') === 'no-cache') return true;
  // Blogger 관리/동적 경로
  if (path.startsWith('/b/'))          return true;  // Blogger 관리 패널
  if (path.startsWith('/admin'))       return true;
  if (path === '/ncr')                 return true;
  // 동적 쿼리 파라미터
  if (url.searchParams.has('blogedit'))  return true;
  if (url.searchParams.has('postID'))    return true;
  if (url.searchParams.has('action'))    return true;
  if (url.searchParams.has('widgetType')) return true;
  // 댓글/검색
  if (path.startsWith('/search') && url.searchParams.has('q')) return true;
  return false;
}

// ─────────────────────────────────────────────
// 전체 캐시 purge
// ─────────────────────────────────────────────
async function purgeAll(env) {
  if (!env.CACHE_RESERVE_KV) {
    return new Response('CACHE_RESERVE_KV not bound', { status: 500 });
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
    return errResp(500, 'Purge failed: ' + e.message);
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
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < CNAME_CACHE_TTL) return;
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
  const resp = await fetch(
    `${DOH_URL}?name=${encodeURIComponent(host)}&type=CNAME`,
    { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 300, cacheEverything: true } }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !Array.isArray(data.Answer)) return null;
  const rec = data.Answer.find(r => r.type === 5);
  return rec ? String(rec.data) : null;
}

// ─────────────────────────────────────────────
// Blogger fetch
//
// 커스텀 도메인 URL 그대로 fetch.
// cf.resolveOverride: 'ghs.google.com' 으로
// DNS 해석만 ghs IP로 우회.
// SNI와 Host 헤더는 커스텀 도메인 그대로 유지
// → SSL 정상 (525 없음)
// → Blogger가 Host로 블로그 식별
// → blogspot.com 탐지/추적 없음
// → redirect: 'manual' 로 리다이렉트 루프 방지
// ─────────────────────────────────────────────
async function bloggerFetch(url, method, reqHeaders) {
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

  return fetch(targetUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : null,
    redirect: 'manual',   // 리다이렉트 추적 안 함 → 루프 없음
    cf: {
      resolveOverride: GHS_TARGET,  // DNS만 ghs IP로 우회, SNI/Host는 커스텀도메인 유지
    },
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
    errorMsg = String(e.message);
  }

  let cnameOk = null;
  if (env.SLUG_KV) {
    try {
      const raw = await env.SLUG_KV.get(kvCname(host));
      if (raw) cnameOk = JSON.parse(raw).ok;
    } catch (_) {}
  }

  const info = {
    host,
    resolveOverride: GHS_TARGET,
    ghsStatus: status,
    ok,
    cnamePointsToGhs: cnameOk,
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
// ─────────────────────────────────────────────
async function proxyPass(url, request, env) {
  try {
    const resp = await bloggerFetch(url, request.method, request.headers);
    // 정적 자산 리다이렉트도 그대로 통과
    return stripInternalHeaders(resp);
  } catch (e) {
    return errResp(502, 'Proxy fetch failed: ' + e.message);
  }
}

function stripInternalHeaders(resp) {
  const h = new Headers(resp.headers);
  h.delete('cf-cache-status');
  h.delete('cf-ray');
  h.delete('nel');
  h.delete('report-to');
  h.delete('server');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function errResp(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type':  'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-error':       message,
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
  if (/^\/sitemap(-[^/]+)?\.xml$/i.test(path)) return true;
  if (url.searchParams.has('alt'))              return true;
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|xml|txt|json)$/i.test(path)) return true;
  return false;
}

function isHtml(resp) {
  return (resp.headers.get('content-type') || '').includes('text/html');
}

// ─────────────────────────────────────────────
// Cache Reserve (KV)
// ─────────────────────────────────────────────
function buildCacheKey(url) {
  const s = new URLSearchParams([...url.searchParams].sort());
  return url.origin + url.pathname + (s.toString() ? '?' + s : '');
}

async function getCacheReserve(key, env) {
  if (!env.CACHE_RESERVE_KV) return null;
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

async function deleteCacheReserve(key, env) {
  if (!env.CACHE_RESERVE_KV) return;
  try {
    await env.CACHE_RESERVE_KV.delete('meta:' + key).catch(() => {});
    await env.CACHE_RESERVE_KV.delete('body:' + key).catch(() => {});
  } catch (_) {}
}

async function setCacheReserve(key, body, headers, env) {
  if (!env.CACHE_RESERVE_KV) return;
  try {
    const opts = { expirationTtl: CACHE_TTL * 2 };
    await env.CACHE_RESERVE_KV.put('meta:' + key, JSON.stringify({ ts: Date.now(), headers: Object.fromEntries(headers.entries()) }), opts);
    await env.CACHE_RESERVE_KV.put('body:' + key, body, opts);
  } catch (_) {}
}

// ─────────────────────────────────────────────
// 슬러그 라우팅
//
// KV 구조:
//   origin:{originPath}  → { title, titleSlug, titlePath, createdAt, checkedAt }
//     원본 blogspot 경로 → 제목 기반 슬러그 경로 매핑
//
//   alias:{titlePath}    → originPath
//     제목 슬러그 경로 → 원본 경로 역방향 매핑
//
// 동작:
//   원본 경로 요청  → 제목 슬러그 경로로 301 리다이렉트
//   슬러그 경로 요청 → 원본 경로로 내부 fetch (URL은 슬러그로 유지)
// ─────────────────────────────────────────────

function isPostPath(path) {
  return /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(path) || /^\/p\/[^/]+$/.test(path);
}

// 요청 경로의 슬러그 라우팅 타입 반환
//   { type: 'redirect', titlePath }  → 원본 경로, 제목 슬러그로 301
//   { type: 'alias',    originPath } → 슬러그 경로, 원본으로 내부 fetch
//   { type: 'passthrough' }          → 처리 없이 통과
async function resolveSlugRoute(path, url, env) {
  if (!isPostPath(path) || !env.SLUG_KV) return { type: 'passthrough' };

  // 1. alias 경로인지 먼저 확인 (제목 슬러그로 들어온 요청)
  try {
    const originPath = await env.SLUG_KV.get('alias:' + path);
    if (originPath && originPath !== path) {
      return { type: 'alias', originPath };
    }
  } catch (_) {}

  // 2. 원본 경로에 대한 등록된 슬러그가 있는지 확인
  try {
    const rec = await env.SLUG_KV.get('origin:' + path, { type: 'json' });
    if (rec && rec.titlePath && rec.titlePath !== path) {
      return { type: 'redirect', titlePath: rec.titlePath };
    }
  } catch (_) {}

  return { type: 'passthrough' };
}

// HTML fetch 후 슬러그 KV 등록/갱신
async function updateSlugKV(pageCtx, url, env) {
  if (!env.SLUG_KV) return;
  if (!['post', 'page'].includes(pageCtx.type) || !pageCtx.title) return;

  const originPath = url.pathname;
  const titleSlug  = generateSlug(pageCtx.title);
  const titlePath  = originPath.replace(/[^/]+\.html$/, titleSlug + '.html');

  // blogspot이 이미 제목 기반 슬러그로 발급한 경우 처리 불필요
  if (titlePath === originPath) return;

  try {
    const existing = await env.SLUG_KV.get('origin:' + originPath, { type: 'json' });
    const now = Date.now();

    if (!existing) {
      // 최초 등록: origin + alias 모두 저장
      await env.SLUG_KV.put('origin:' + originPath, JSON.stringify({
        title: pageCtx.title, titleSlug, titlePath, createdAt: now, checkedAt: now,
      }));
      await env.SLUG_KV.put('alias:' + titlePath, originPath);
    } else {
      const newSlug      = generateSlug(pageCtx.title);
      const newTitlePath = originPath.replace(/[^/]+\.html$/, newSlug + '.html');

      if (newTitlePath !== existing.titlePath) {
        // 제목 변경: 구 alias 삭제 → 신규 alias 등록
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
        const newTitlePath = originPath.replace(/[^/]+\.html$/, newSlug + '.html');
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
// LB 기록
// ─────────────────────────────────────────────
async function lbRecordRtt(host, rttMs, env) {
  if (!env.SLUG_KV) return;
  try {
    const prev = await env.SLUG_KV.get(kvRtt(host), { type: 'json' });
    const ewma = prev && prev.rtt != null
      ? prev.rtt * (1 - LB_RTT_DECAY) + rttMs * LB_RTT_DECAY
      : rttMs;
    await env.SLUG_KV.put(kvRtt(host), JSON.stringify({ rtt: ewma, ts: Date.now() }), { expirationTtl: LB_RTT_TTL });
  } catch (_) {}
}

async function lbRecordBandwidth(host, bytes, env) {
  if (!env.SLUG_KV) return;
  try {
    const prev = parseInt((await env.SLUG_KV.get(kvBw(host))) || '0', 10);
    const next = (prev + bytes) > 1e12 ? bytes : prev + bytes;
    await env.SLUG_KV.put(kvBw(host), String(next), { expirationTtl: 86400 });
  } catch (_) {}
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
  if (p.startsWith('/search/label/'))          return 'label';
  if (p.startsWith('/search'))                 return 'search';
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
function extractJsonLdDate(html, key) { return (html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || ''; }
function escapeAttr(str) { return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRe(str)   { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
