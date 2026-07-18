/**
 * bp-admin 라우팅
 * ─────────────────────────────────────────────────────────────────────
 * {도메인}/bp-admin 이하 모든 요청을 처리한다.
 *
 *   /bp-admin/api/*      → 이 파일의 handleBpAdminApi() (인증/세션/대시보드 API)
 *   /bp-admin/(그 외)    → Astro 정적 빌드 산출물 (env.BP_ADMIN_ASSETS 바인딩)
 *
 * 정적 자산은 Cloudflare Workers Assets(wrangler.toml의 [assets] 바인딩)로
 * 서빙한다. Assets는 업로드된 정적 파일을 Cloudflare의 엣지 캐시에서 직접
 * 서빙하므로 Worker 코드 실행 없이(요청이 오리진 로직을 아예 타지 않음)
 * 응답하는 경로가 있어 사실상 무제한에 가깝게 확장되고 지연시간도 최소화된다.
 */

import {
  verifyCredentials, createSession, destroySession, resolveSession,
  hasAnyUser, createUser,
  buildSessionCookie, buildExpiredSessionCookie, parseCookies, SESSION_COOKIE_NAME,
} from './bp-admin-auth.js';
import { kvGetJson, listBlockedIps } from './store.js';
import { doRedisAvailable, doRedisClusterStats } from './redis-do.js';
import { cacheReserveStats } from './cache-reserve.js';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function isSecureRequest(url) {
  return url.protocol === 'https:';
}

// 로그인/부트스트랩처럼 세션이 없어도 되는 API는 화이트리스트로 관리한다.
const PUBLIC_API_PATHS = new Set([
  'auth/login',
  'auth/logout',
  'auth/bootstrap-status',
  'auth/bootstrap',
]);

export async function handleBpAdminApi(request, url, env, ctx) {
  const subPath = url.pathname.replace(/^\/bp-admin\/api\/?/, '');
  const method = request.method;
  const secure = isSecureRequest(url);

  // ── 인증이 필요 없는 엔드포인트 ──────────────────────────────────
  if (subPath === 'auth/bootstrap-status' && method === 'GET') {
    const exists = await hasAnyUser(env);
    return json({ needsBootstrap: !exists });
  }

  if (subPath === 'auth/bootstrap' && method === 'POST') {
    // 최초 1회만 허용: 이미 계정이 하나라도 있으면 거부한다. 이렇게 해야
    // 배포 직후 공격자가 먼저 계정을 선점하는 경쟁 조건을 최소화하면서도
    // 별도 시크릿 없이 최초 관리자 계정을 안전하게 만들 수 있다. 실제
    // 운영 환경에서는 최초 배포 직후 즉시 이 엔드포인트를 호출해 계정을
    // 만들 것을 README에 명시해야 한다.
    const exists = await hasAnyUser(env);
    if (exists) {
      return json({ ok: false, message: '이미 관리자 계정이 존재합니다.' }, 409);
    }
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, message: '잘못된 요청 본문입니다.' }, 400); }
    try {
      const user = await createUser(env, { username: body.username, password: body.password, role: 'owner' });
      const sessionId = await createSession(env, user);
      return json({ ok: true, redirectTo: '/bp-admin' }, 200, {
        'set-cookie': buildSessionCookie(sessionId, { secure }),
      });
    } catch (e) {
      return json({ ok: false, message: String(e?.message || e) }, 400);
    }
  }

  if (subPath === 'auth/login' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, message: '잘못된 요청 본문입니다.' }, 400); }
    const user = await verifyCredentials(env, body.username, body.password);
    if (!user) {
      return json({ ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
    }
    const sessionId = await createSession(env, user);
    return json({ ok: true, redirectTo: '/bp-admin' }, 200, {
      'set-cookie': buildSessionCookie(sessionId, { secure }),
    });
  }

  if (subPath === 'auth/logout' && method === 'POST') {
    const cookies = parseCookies(request);
    await destroySession(env, cookies[SESSION_COOKIE_NAME]);
    return json({ ok: true }, 200, {
      'set-cookie': buildExpiredSessionCookie({ secure }),
    });
  }

  // ── 이 아래부터는 인증 필요 ──────────────────────────────────────
  const session = await resolveSession(request, env);
  if (!session) {
    return json({ ok: false, message: '인증이 필요합니다.' }, 401);
  }

  if (subPath === 'auth/session' && method === 'GET') {
    return json({ authenticated: true, username: session.username, role: session.role });
  }

  if (subPath === 'status/pulse' && method === 'GET') {
    return json(await getStatusPulse(env));
  }

  if (subPath === 'dashboard/summary' && method === 'GET') {
    return json(await getDashboardSummary(env));
  }

  return json({ ok: false, message: 'Not found' }, 404);
}

async function getStatusPulse(env) {
  // Worker 자체는 이 코드가 실행되고 있다는 사실 자체로 항상 'ok'.
  const worker = 'ok';

  let cache = 'ok';
  try {
    const stats = await cacheReserveStats(env);
    if (!stats) cache = 'degraded';
  } catch {
    cache = 'degraded';
  }

  let blogger = 'ok';
  try {
    const siteHost = await kvGetJson(env, 'state:site_host');
    if (!siteHost) blogger = 'degraded'; // 아직 도메인 자동감지가 안 됨
  } catch {
    blogger = 'down';
  }

  return { worker, cache, blogger };
}

async function getDashboardSummary(env) {
  const [siteHost, siteTitle, blockedIps, cacheStats, redisStats] = await Promise.all([
    kvGetJson(env, 'state:site_host').catch(() => null),
    kvGetJson(env, 'state:site_title').catch(() => null),
    listBlockedIps(env).catch(() => []),
    cacheReserveStats(env).catch(() => null),
    doRedisAvailable(env) ? doRedisClusterStats(env).catch(() => null) : Promise.resolve(null),
  ]);

  const cacheStatsForHitRate = cacheStats && typeof cacheStats.total === 'number' && cacheStats.total > 0
    ? cacheStats.alive / cacheStats.total
    : null;

  return {
    siteHost: siteHost || null,
    siteTitle: siteTitle || null,
    // 발행글 수: Blogger API 연동 전이므로 아직 정확한 카운트를 낼 수 없다.
    // 다음 단계(Blogger API 연동)에서 실제 값으로 교체한다.
    postsCount: 0,
    cacheHitRate: cacheStatsForHitRate,
    redisShardsActive: redisStats?.shardCount ?? null,
    blockedIpsCount: Array.isArray(blockedIps) ? blockedIps.length : 0,
    lastSitemapAt: null,
    lastRssAt: null,
  };
}

/**
 * /bp-admin (API 제외) 정적 자산 서빙.
 * env.BP_ADMIN_ASSETS 는 wrangler.toml의 [assets] 바인딩.
 */
export async function handleBpAdminStatic(request, url, env) {
  if (!env.BP_ADMIN_ASSETS) {
    return new Response(
      'bp-admin static assets binding (BP_ADMIN_ASSETS) is not configured. ' +
      'Run the Astro build in bp-admin-src/ and deploy with the [assets] binding set in wrangler.toml.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }

  // 로그인 여부 확인 → 미인증 상태로 /bp-admin/* (login 제외) 접근 시
  // 정적 HTML은 내려주되, 각 페이지의 React 위젯들이 API 401을 받아
  // 자동으로 /bp-admin/login으로 리다이렉트한다(components/*.tsx 참고).
  // 다만 최초 진입 시 서버 사이드에서 한 번 더 방어적으로 검사해,
  // 세션이 없는 사용자가 대시보드 HTML 자체를 긁어가는 것도 막는다.
  const isLoginPage = url.pathname === '/bp-admin/login' || url.pathname === '/bp-admin/login.html';
  const isStaticAsset = url.pathname.startsWith('/bp-admin/_astro/') ||
    /\.(css|js|svg|png|ico|woff2?)$/i.test(url.pathname);

  if (!isLoginPage && !isStaticAsset) {
    const session = await resolveSession(request, env);
    if (!session) {
      // 부트스트랩(최초 계정 생성) 여부에 따라 안내를 다르게 할 수도 있지만,
      // 프론트엔드(login.astro)가 bootstrap-status를 조회해 UI를 분기하므로
      // 여기서는 단순히 로그인 페이지로 리다이렉트한다.
      return Response.redirect(url.origin + '/bp-admin/login', 302);
    }
  }

  // Astro의 `base: '/bp-admin'` 설정 때문에 dist/ 산출물 자체가 이미
  // '/bp-admin' 프리픽스를 반영한 경로로 생성된다
  // (예: dist/bp-admin.html, dist/bp-admin/login.html, dist/_astro/*.js —
  // 단 _astro는 프리픽스 없이 루트에 그대로 생성됨. 다만 HTML이 참조하는
  // 스크립트 URL 자체는 '/bp-admin/_astro/...'로 박혀 있으므로 Assets가
  // 그 요청도 처리할 수 있어야 한다. 그래서 여기서는 프리픽스를 제거하지
  //않고 요청을 그대로 Assets 바인딩에 전달한다 — Workers Assets가
  // '/bp-admin/login' → 'dist/bp-admin/login.html'을,
  // '/bp-admin/_astro/x.js' → 'dist/bp-admin/_astro/x.js' 로 찾는데,
  // 실제 _astro 산출물은 dist/_astro/에 있으므로 배포 시 이 폴더를
  // dist/bp-admin/_astro로도 복사(또는 심링크)해 두어야 한다.
  // (배포 스크립트에서 처리, README 참고)
  return env.BP_ADMIN_ASSETS.fetch(request);
}
