/**
 * Blogger API 클라이언트
 * ─────────────────────────────────────────────────────────────────────
 * bp-admin이 Blogspot에 직접 로그인하지 않고 글을 쓰고/수정하고/발행할 수
 * 있게 해주는 핵심 모듈. Google OAuth2 인증 코드 플로우 + Blogger Data
 * API v3(https://www.googleapis.com/blogger/v3) 래퍼로 구성된다.
 *
 * 기존 worker.js의 bloggerFetch()는 공개 HTML 페이지를 그대로 가져와
 * 캐싱/SEO 처리하는 "읽기 전용 프록시"였고 이 모듈과는 목적이 다르다.
 * bloggerFetch는 인증이 필요 없는 공개 페이지만 다루고, 이 모듈은
 * OAuth로 인증된 "쓰기 가능한" 공식 API를 호출한다. 두 경로는 서로
 * 간섭하지 않는다.
 *
 * 토큰 저장: KV(bp-admin-auth.js와 동일한 store.js 헬퍼 사용)
 *   bpadmin:google:tokens → { accessToken, refreshToken, expiresAt }
 *   bpadmin:google:blog   → { blogId, url, name } (최초 1회 자동 감지 후 캐시)
 *
 * refresh_token은 최초 동의(consent) 시 access_type=offline 요청으로만
 * 발급되므로, 이미 연동된 상태에서 재인증하면 Google이 refresh_token을
 * 다시 안 줄 수 있다. 그래서 최초 저장된 refresh_token은 새 값이 없는 한
 * 덮어쓰지 않는다(mergeTokens 참고).
 */

import { kvGetJson, kvSetJson } from './store.js';

const TOKENS_KEY = 'bpadmin:google:tokens';
const BLOG_INFO_KEY = 'bpadmin:google:blog';
const OAUTH_STATE_PREFIX = 'bpadmin:google:oauthstate:';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BLOGGER_API_BASE = 'https://www.googleapis.com/blogger/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/blogger',
];

// ── OAuth 시작/콜백 ────────────────────────────────────────────────────

/**
 * Google 동의 화면으로 리디렉션할 URL을 만든다.
 * state는 CSRF 방지용 1회성 토큰으로, KV에 5분 TTL로 저장해 콜백에서
 * 검증한다(세션 자체는 이미 bp-admin-auth.js가 검사했지만, OAuth
 * 리디렉션 왕복 사이의 CSRF는 별도로 막아야 한다).
 */
export async function buildGoogleAuthUrl(env, redirectUri) {
  const state = crypto.randomUUID();
  await kvSetJson(env, OAUTH_STATE_PREFIX + state, { createdAt: Date.now() }, 300);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // refresh_token을 매번 확실히 받기 위해 강제 재동의
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function verifyOAuthState(env, state) {
  if (!state) return false;
  const record = await kvGetJson(env, OAUTH_STATE_PREFIX + state);
  return !!record;
}

/**
 * 콜백에서 받은 authorization code를 access/refresh token으로 교환한다.
 */
export async function exchangeCodeForTokens(env, code, redirectUri) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google 토큰 교환 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  await saveTokens(env, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // 최초 동의 시에만 존재할 수 있음
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data;
}

async function saveTokens(env, { accessToken, refreshToken, expiresAt }) {
  const existing = await kvGetJson(env, TOKENS_KEY);
  const merged = {
    accessToken,
    // refresh_token은 새로 안 오면 기존 값을 유지한다(위 모듈 설명 참고).
    refreshToken: refreshToken || existing?.refreshToken || null,
    expiresAt,
  };
  await kvSetJson(env, TOKENS_KEY, merged);
  return merged;
}

export async function hasGoogleConnection(env) {
  const tokens = await kvGetJson(env, TOKENS_KEY);
  return !!(tokens && tokens.refreshToken);
}

export async function disconnectGoogle(env) {
  await kvSetJson(env, TOKENS_KEY, null);
  await kvSetJson(env, BLOG_INFO_KEY, null);
}

/**
 * 유효한 access_token을 반환한다. 만료(또는 만료 60초 전)면 refresh_token
 * 으로 자동 갱신한다. refresh_token 자체가 없으면(OAuth 미완료) null.
 */
async function getValidAccessToken(env) {
  const tokens = await kvGetJson(env, TOKENS_KEY);
  if (!tokens || !tokens.refreshToken) return null;

  const stillValid = tokens.accessToken && tokens.expiresAt && Date.now() < tokens.expiresAt - 60_000;
  if (stillValid) return tokens.accessToken;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new BloggerApiError(res.status, `Google 토큰 갱신 실패: ${text}`);
  }

  const data = await res.json();
  const updated = await saveTokens(env, {
    accessToken: data.access_token,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return updated.accessToken;
}

export class BloggerApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function bloggerApiFetch(env, path, init = {}) {
  const accessToken = await getValidAccessToken(env);
  if (!accessToken) {
    throw new BloggerApiError(401, 'Google 계정이 연동되어 있지 않습니다. 먼저 /bp-admin/settings에서 연동하세요.');
  }

  const res = await fetch(`${BLOGGER_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message || `Blogger API 오류 (${res.status})`;
    throw new BloggerApiError(res.status, message);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ── blogId 자동 감지 ──────────────────────────────────────────────────

/**
 * 현재 사이트 도메인으로 Blogger의 blogId를 알아내 KV에 캐시한다.
 * bp-admin-router.js가 이미 감지해 둔 'state:site_host'(개인도메인) 또는
 * 사용자가 명시한 blogspot 서브도메인을 넘겨받는다.
 */
export async function resolveBlogId(env, siteUrl) {
  const cached = await kvGetJson(env, BLOG_INFO_KEY);
  if (cached && cached.blogId) return cached;

  if (!siteUrl) {
    throw new BloggerApiError(400, '사이트 도메인을 아직 감지하지 못했습니다. 먼저 사이트에 한 번 방문해 자동 감지를 완료하세요.');
  }

  const data = await bloggerApiFetch(env, `/blogs/byurl?url=${encodeURIComponent(siteUrl)}`);
  const info = { blogId: data.id, url: data.url, name: data.name };
  await kvSetJson(env, BLOG_INFO_KEY, info);
  return info;
}

// ── 글 CRUD ────────────────────────────────────────────────────────────

/**
 * 글 목록 조회. status: 'LIVE' | 'DRAFT' | 'SCHEDULED' (생략 시 전체)
 */
export async function listPosts(env, blogId, { status, pageToken, maxResults = 20 } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults), fetchImages: 'true' });
  if (status) params.set('status', status);
  if (pageToken) params.set('pageToken', pageToken);
  return bloggerApiFetch(env, `/blogs/${blogId}/posts?${params.toString()}`);
}

export async function getPost(env, blogId, postId) {
  return bloggerApiFetch(env, `/blogs/${blogId}/posts/${postId}`);
}

/**
 * 글 작성. isDraft=true면 임시글로만 저장(Blogspot에 공개되지 않음).
 */
export async function createPost(env, blogId, { title, content, labels, isDraft }) {
  const body = { title, content };
  if (labels && labels.length) body.labels = labels;
  const params = isDraft ? '?isDraft=true' : '';
  return bloggerApiFetch(env, `/blogs/${blogId}/posts${params}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updatePost(env, blogId, postId, { title, content, labels }) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (content !== undefined) body.content = content;
  if (labels !== undefined) body.labels = labels;
  return bloggerApiFetch(env, `/blogs/${blogId}/posts/${postId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function publishPost(env, blogId, postId) {
  return bloggerApiFetch(env, `/blogs/${blogId}/posts/${postId}/publish`, { method: 'POST' });
}

export async function revertPostToDraft(env, blogId, postId) {
  return bloggerApiFetch(env, `/blogs/${blogId}/posts/${postId}/revert`, { method: 'POST' });
}

export async function deletePost(env, blogId, postId) {
  await bloggerApiFetch(env, `/blogs/${blogId}/posts/${postId}`, { method: 'DELETE' });
  return { ok: true };
}

/**
 * 이미지 업로드: Blogger Data API 자체는 별도의 미디어 업로드 엔드포인트가
 * 없다(Blogger가 내부적으로 Picasa/Google Photos 연동을 쓰던 시절과 달리
 * 현재 v3 API는 base64 인라인이나 외부 URL만 허용). 그래서 이미지는
 * <img src="data:image/...;base64,..."> 형태로 content HTML에 직접
 * 삽입하는 방식을 쓴다. 큰 이미지(수 MB 이상)는 base64 인코딩 시 요청
 * 본문이 커지므로, 클라이언트에서 업로드 전 리사이즈/압축을 권장한다.
 */
export function buildInlineImageTag(base64DataUrl, altText = '') {
  const safeAlt = String(altText).replace(/"/g, '&quot;');
  return `<img src="${base64DataUrl}" alt="${safeAlt}" />`;
}
