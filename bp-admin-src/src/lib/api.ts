/**
 * bp-admin API 클라이언트
 * ────────────────────────────────────────────────────────────────
 * Astro는 정적으로 빌드되므로, 이 파일에서 만드는 fetch 요청은 전부
 * 브라우저에서 실행 시점에 worker.js의 /bp-admin/api/* 엔드포인트로
 * 나간다. 인증은 세션 쿠키(HttpOnly, bp_session) 기반이며, 이 클라이언트는
 * 쿠키를 자동으로 실어 보내는 것 외에 별도 토큰을 다루지 않는다
 * (localStorage/sessionStorage는 절대 사용하지 않음 — 세션은 서버 쿠키로만
 * 관리해 XSS로 인한 토큰 탈취 표면을 없앤다).
 */

export const API_BASE = '/bp-admin/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (res.status === 401) {
    // 세션 만료 → 로그인 화면으로
    if (typeof window !== 'undefined') {
      window.location.href = '/bp-admin/login?expired=1';
    }
    throw new ApiError(401, '세션이 만료되었습니다');
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (isJson && (body as any)?.message) || `요청 실패 (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return body as T;
}

export const api = {
  get:   <T>(path: string) => request<T>(path, { method: 'GET' }),
  post:  <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: data !== undefined ? JSON.stringify(data) : undefined }),
  del:   <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  role?: 'owner' | 'editor';
}

export interface DashboardSummary {
  siteHost: string | null;
  siteTitle: string | null;
  postsCount: number;
  cacheHitRate: number | null;
  redisShardsActive: number | null;
  blockedIpsCount: number;
  lastSitemapAt: string | null;
  lastRssAt: string | null;
  googleConnected?: boolean;
}

// ── Blogger 연동 ────────────────────────────────────────────────────

export interface BloggerConnectionStatus {
  connected: boolean;
  blog: { blogId: string; url: string; name: string } | null;
}

export interface BloggerPost {
  id: string;
  title: string;
  content: string;
  url?: string;
  status?: 'LIVE' | 'DRAFT' | 'SCHEDULED';
  published?: string;
  updated?: string;
  labels?: string[];
}

export interface BloggerPostList {
  items: BloggerPost[];
  nextPageToken?: string;
}

export const bloggerApi = {
  connectionStatus: () => api.get<BloggerConnectionStatus>('/blogger/connection-status'),

  startOAuth: async () => {
    const res = await api.get<{ ok: true; authUrl: string }>('/blogger/oauth/start');
    window.location.href = res.authUrl;
  },

  disconnect: () => api.post<{ ok: true }>('/blogger/disconnect'),

  listPosts: (params?: { status?: string; pageToken?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.pageToken) qs.set('pageToken', params.pageToken);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return api.get<BloggerPostList>(`/posts${suffix}`);
  },

  getPost: (postId: string) => api.get<BloggerPost>(`/posts/${postId}`),

  createPost: (data: { title: string; content: string; labels?: string[]; isDraft?: boolean }) =>
    api.post<BloggerPost>('/posts', data),

  updatePost: (postId: string, data: { title?: string; content?: string; labels?: string[] }) =>
    api.patch<BloggerPost>(`/posts/${postId}`, data),

  publishPost: (postId: string) => api.post<BloggerPost>(`/posts/${postId}/publish`),

  revertPost: (postId: string) => api.post<BloggerPost>(`/posts/${postId}/revert`),

  deletePost: (postId: string) => api.del<{ ok: true }>(`/posts/${postId}`),
};
