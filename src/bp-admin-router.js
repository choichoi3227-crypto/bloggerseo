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
import {
  buildGoogleAuthUrl, verifyOAuthState, exchangeCodeForTokens,
  hasGoogleConnection, disconnectGoogle, resolveBlogId,
  listPosts, getPost, createPost, updatePost, publishPost, revertPostToDraft, deletePost,
  BloggerApiError,
} from './blogger-api.js';
import { generateBlogContent, expandSelectedText, AiWriterError } from './ai-writer.js';
import { generateImagePrompt, renderThumbnailImage, ThumbnailError, STYLE_DIRECTIVES } from './ai-thumbnail.js';

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

/**
 * Uint8Array를 base64 문자열로 변환한다. String.fromCharCode(...bytes)를
 * 한 번에 스프레드하면 큰 이미지(수백 KB)에서 호출 스택 한계를 넘을 수
 * 있으므로, 8KB씩 청크로 나눠 처리한다.
 */
function arrayBufferToBase64(bytes) {
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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

  if (subPath === 'blogger/oauth/callback' && method === 'GET') {
    // Google이 브라우저를 직접 이 URL로 리다이렉트시키는 요청이라 bp-admin
    // 세션 쿠키가 없을 수도 있다(리다이렉트 체인 도중 SameSite=Strict
    // 쿠키가 최초 요청에는 실리지 않는 브라우저가 있음). 그래서 이 콜백은
    // bp-admin 세션 인증 없이도 동작해야 하며, 대신 OAuth 자체의 state
    // 파라미터(verifyOAuthState)가 CSRF를 막아준다. 응답은 JSON이 아니라
    // /bp-admin/settings로 돌아가는 302여야 브라우저가 자연스럽게 이어진다.
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const settingsUrl = url.origin + '/bp-admin/settings';

    const stateOk = await verifyOAuthState(env, state);
    if (!stateOk || !code) {
      return Response.redirect(settingsUrl + '?googleAuth=invalid_state', 302);
    }
    try {
      const redirectUri = url.origin + (env.GOOGLE_OAUTH_REDIRECT_PATH || '/bp-admin/api/blogger/oauth/callback');
      await exchangeCodeForTokens(env, code, redirectUri);
      return Response.redirect(settingsUrl + '?googleAuth=connected', 302);
    } catch (e) {
      return Response.redirect(settingsUrl + '?googleAuth=error', 302);
    }
  }

  // ── 이 아래부터는 인증 필요 ──────────────────────────────────────
  const session = await resolveSession(request, env);
  if (!session) {
    return json({ ok: false, message: '인증이 필요합니다.' }, 401);
  }

  const response = await handleAuthenticatedApi(request, url, env, ctx, subPath, method, session);

  // 슬라이딩 쿠키 갱신: bp-admin-auth.js의 getSession()이 서버 쪽 세션
  // TTL은 이미 슬라이딩으로 연장했지만(임계값 이하일 때), 브라우저에 심긴
  // 쿠키 자체의 Max-Age는 최초 로그인 시점 기준으로 고정되어 있어 그대로
  // 두면 서버 세션보다 먼저 만료돼 버린다. 인증이 필요한 모든 API 응답에
  // 예외 없이 쿠키를 Max-Age=30일로 다시 실어서, 30일 안에 최소 한 번만
  // 접속하면 로그인이 끊기지 않고 계속 유지되게 한다(추가 KV 쓰기 없이
  // 쿠키 헤더만 재발급하므로 비용이 거의 없다). 응답 객체를 한 곳에서만
  // 감싸므로 새 엔드포인트를 추가해도 쿠키 갱신을 빠뜨릴 일이 없다.
  const cookies = parseCookies(request);
  response.headers.set('set-cookie', buildSessionCookie(cookies[SESSION_COOKIE_NAME], { secure }));
  return response;
}

async function handleAuthenticatedApi(request, url, env, ctx, subPath, method, session) {
  if (subPath === 'auth/session' && method === 'GET') {
    return json({ authenticated: true, username: session.username, role: session.role });
  }

  if (subPath === 'status/pulse' && method === 'GET') {
    return json(await getStatusPulse(env));
  }

  if (subPath === 'dashboard/summary' && method === 'GET') {
    return json(await getDashboardSummary(env));
  }

  // ── Blogger 연동 (OAuth) ────────────────────────────────────────
  if (subPath === 'blogger/connection-status' && method === 'GET') {
    const connected = await hasGoogleConnection(env);
    let blogInfo = null;
    if (connected) {
      try {
        const siteHost = await kvGetJson(env, 'state:site_host');
        blogInfo = await resolveBlogId(env, siteHost ? `https://${siteHost}` : null);
      } catch (e) {
        // blogId 미해결(사이트 도메인 미감지 등)이어도 연동 자체 여부는 보여준다.
      }
    }
    return json({ connected, blog: blogInfo });
  }

  if (subPath === 'blogger/oauth/start' && method === 'GET') {
    if (!env.GOOGLE_OAUTH_CLIENT_ID) {
      return json({ ok: false, message: 'GOOGLE_OAUTH_CLIENT_ID가 설정되지 않았습니다. wrangler secret으로 등록하세요.' }, 500);
    }
    const redirectUri = url.origin + (env.GOOGLE_OAUTH_REDIRECT_PATH || '/bp-admin/api/blogger/oauth/callback');
    const authUrl = await buildGoogleAuthUrl(env, redirectUri);
    return json({ ok: true, authUrl });
  }

  if (subPath === 'blogger/disconnect' && method === 'POST') {
    await disconnectGoogle(env);
    return json({ ok: true });
  }

  // ── 글 관리 (Blogger Data API v3) ────────────────────────────────
  if (subPath === 'posts' && method === 'GET') {
    return withBloggerApi(async (blogId) => {
      const status = url.searchParams.get('status') || undefined;
      const pageToken = url.searchParams.get('pageToken') || undefined;
      const data = await listPosts(env, blogId, { status, pageToken });
      return json(data);
    });
  }

  const postMatch = subPath.match(/^posts\/([^/]+)$/);
  if (postMatch && method === 'GET') {
    return withBloggerApi(async (blogId) => json(await getPost(env, blogId, postMatch[1])));
  }
  if (postMatch && method === 'PATCH') {
    return withBloggerApi(async (blogId) => {
      const body = await safeJson(request);
      if (!body) return json({ ok: false, message: '잘못된 요청 본문입니다.' }, 400);
      return json(await updatePost(env, blogId, postMatch[1], body));
    });
  }
  if (postMatch && method === 'DELETE') {
    return withBloggerApi(async (blogId) => json(await deletePost(env, blogId, postMatch[1])));
  }

  if (subPath === 'posts' && method === 'POST') {
    return withBloggerApi(async (blogId) => {
      const body = await safeJson(request);
      if (!body || !body.title || !body.content) {
        return json({ ok: false, message: 'title과 content는 필수입니다.' }, 400);
      }
      return json(await createPost(env, blogId, body));
    });
  }

  const publishMatch = subPath.match(/^posts\/([^/]+)\/publish$/);
  if (publishMatch && method === 'POST') {
    return withBloggerApi(async (blogId) => json(await publishPost(env, blogId, publishMatch[1])));
  }

  const revertMatch = subPath.match(/^posts\/([^/]+)\/revert$/);
  if (revertMatch && method === 'POST') {
    return withBloggerApi(async (blogId) => json(await revertPostToDraft(env, blogId, revertMatch[1])));
  }

  // ── AI 글쓰기 (Gemini API) ────────────────────────────────────────
  if (subPath === 'ai/generate-post' && method === 'POST') {
    try {
      const body = await safeJson(request);
      if (!body || !body.topic) {
        return json({ ok: false, message: '주제(topic)는 필수입니다.' }, 400);
      }
      const result = await generateBlogContent(env, body.topic, body.type || 'informational');
      return json({ ok: true, ...result });
    } catch (e) {
      return handleAiError(e);
    }
  }

  if (subPath === 'ai/expand-text' && method === 'POST') {
    try {
      const body = await safeJson(request);
      if (!body || !body.selectedText) {
        return json({ ok: false, message: '확장할 텍스트(selectedText)는 필수입니다.' }, 400);
      }
      const result = await expandSelectedText(env, body);
      return json({ ok: true, ...result });
    } catch (e) {
      return handleAiError(e);
    }
  }

  // ── AI 썸네일 생성 ────────────────────────────────────────────────
  if (subPath === 'ai/thumbnail-styles' && method === 'GET') {
    const styles = Object.entries(STYLE_DIRECTIVES).map(([key, v]) => ({ key, label: v.label }));
    return json({ styles });
  }

  if (subPath === 'ai/thumbnail-prompt' && method === 'POST') {
    try {
      const body = await safeJson(request);
      if (!body || !body.topic) {
        return json({ ok: false, message: '주제(topic)는 필수입니다.' }, 400);
      }
      const result = await generateImagePrompt(env, body.topic, body.style || 'poster');
      return json({ ok: true, ...result });
    } catch (e) {
      return handleAiError(e);
    }
  }

  if (subPath === 'ai/thumbnail-render' && method === 'POST') {
    try {
      const body = await safeJson(request);
      if (!body || !body.prompt) {
        return json({ ok: false, message: '프롬프트(prompt)는 필수입니다.' }, 400);
      }
      const { imageBytes, mime } = await renderThumbnailImage(env, body.prompt, body.negPrompt);
      // 이미지 바이너리 응답은 JSON이 아니므로 별도로 반환한다. base64로
      // 감싸 JSON에 실으면 페이로드가 33% 커지지만, bp-admin 프론트엔드가
      // <img src="data:...">로 즉시 미리보기하기엔 이 편이 더 간단하다.
      const base64 = arrayBufferToBase64(imageBytes);
      return json({ ok: true, dataUrl: `data:${mime};base64,${base64}` });
    } catch (e) {
      return handleAiError(e);
    }
  }

  return json({ ok: false, message: 'Not found' }, 404);

  // ── 헬퍼: AI 관련 에러를 적절한 HTTP status로 매핑 ──────────────────
  function handleAiError(e) {
    if (e instanceof AiWriterError || e instanceof ThumbnailError) {
      return json({ ok: false, message: e.message }, e.status || 502);
    }
    return json({ ok: false, message: String(e?.message || e) }, 500);
  }

  // ── 헬퍼: blogId 해결 + BloggerApiError를 적절한 HTTP status로 매핑 ──
  async function withBloggerApi(handler) {
    return resolveBlogIdAndRun(env, handler);
  }
}

async function resolveBlogIdAndRun(env, handler) {
  try {
    const siteHost = await kvGetJson(env, 'state:site_host');
    const blogInfo = await resolveBlogId(env, siteHost ? `https://${siteHost}` : null);
    return await handler(blogInfo.blogId);
  } catch (e) {
    if (e instanceof BloggerApiError) {
      return json({ ok: false, message: e.message }, e.status || 502);
    }
    return json({ ok: false, message: String(e?.message || e) }, 500);
  }
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
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
  const [siteHost, siteTitle, blockedIps, cacheStats, redisStats, googleConnected] = await Promise.all([
    kvGetJson(env, 'state:site_host').catch(() => null),
    kvGetJson(env, 'state:site_title').catch(() => null),
    listBlockedIps(env).catch(() => []),
    cacheReserveStats(env).catch(() => null),
    doRedisAvailable(env) ? doRedisClusterStats(env).catch(() => null) : Promise.resolve(null),
    hasGoogleConnection(env).catch(() => false),
  ]);

  const cacheStatsForHitRate = cacheStats && typeof cacheStats.total === 'number' && cacheStats.total > 0
    ? cacheStats.alive / cacheStats.total
    : null;

  let postsCount = 0;
  if (googleConnected && siteHost) {
    try {
      const blogInfo = await resolveBlogId(env, `https://${siteHost}`);
      // Blogger API는 총 개수 필드를 제공하지 않는다. 여기서는 최초 1페이지
      // (최대 500개)만 조회해 대시보드 요약용 근사치로 사용한다. 글이
      // 500개를 넘는 블로그의 정확한 총계는 posts.astro(글 목록 페이지)에서
      // nextPageToken을 따라가며 완주 집계해야 한다.
      const data = await listPosts(env, blogInfo.blogId, { maxResults: 150 });
      postsCount = Array.isArray(data?.items) ? data.items.length : 0;
    } catch {
      postsCount = 0;
    }
  }

  return {
    siteHost: siteHost || null,
    siteTitle: siteTitle || null,
    postsCount,
    cacheHitRate: cacheStatsForHitRate,
    redisShardsActive: redisStats?.shardCount ?? null,
    blockedIpsCount: Array.isArray(blockedIps) ? blockedIps.length : 0,
    lastSitemapAt: null,
    lastRssAt: null,
    googleConnected,
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

  return env.BP_ADMIN_ASSETS.fetch(request);
}
