import { useEffect, useState } from 'react';
import { bloggerApi, ApiError, type BloggerPost } from '../lib/api';

function StatusBadge({ status }: { status?: string }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    LIVE: { label: '발행됨', bg: '#E5F5EC', fg: '#1F7A47' },
    DRAFT: { label: '임시저장', bg: '#FBF1DC', fg: '#8A6A16' },
    SCHEDULED: { label: '예약됨', bg: '#E9F0FD', fg: '#2A5AA8' },
  };
  const s = map[status || ''] || { label: status || '알 수 없음', bg: '#EEE', fg: '#666' };
  return (
    <span style={{
      display: 'inline-block', fontSize: 12, fontWeight: 600,
      padding: '3px 9px', borderRadius: 999, background: s.bg, color: s.fg,
    }}>
      {s.label}
    </span>
  );
}

export default function PostList() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [posts, setPosts] = useState<BloggerPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadPosts() {
    setError(null);
    try {
      const status = await bloggerApi.connectionStatus();
      setConnected(status.connected && !!status.blog);
      if (status.connected && status.blog) {
        const data = await bloggerApi.listPosts();
        setPosts(data.items || []);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '글 목록을 불러오지 못했습니다.');
    }
  }

  useEffect(() => { loadPosts(); }, []);

  async function handleConnect() {
    setConnecting(true);
    try {
      await bloggerApi.startOAuth();
    } catch (err) {
      setConnecting(false);
      setError(err instanceof ApiError ? err.message : 'Google 연동을 시작하지 못했습니다.');
    }
  }

  async function handleDelete(postId: string) {
    if (!window.confirm('이 글을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    setDeletingId(postId);
    try {
      await bloggerApi.deletePost(postId);
      setPosts((prev) => prev?.filter((p) => p.id !== postId) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '삭제하지 못했습니다.');
    } finally {
      setDeletingId(null);
    }
  }

  if (connected === null && !error) {
    return <div className="pl-skeleton" aria-hidden="true" />;
  }

  if (connected === false) {
    return (
      <div className="connect-card">
        <strong>Google 계정을 연동해 주세요</strong>
        <p>Blogspot에 직접 로그인하지 않고 여기서 글을 쓰려면, 먼저 블로그가 연결된 Google 계정을 한 번만 연동하면 됩니다.</p>
        <button onClick={handleConnect} disabled={connecting} className="connect-btn">
          {connecting ? '이동 중…' : 'Google 계정 연동하기'}
        </button>
        {error && <p className="error">{error}</p>}
        <style>{`
          .connect-card {
            background: var(--bp-surface, #fff);
            border: 1px solid var(--bp-border, #E4E3DD);
            border-radius: var(--bp-radius-md, 10px);
            padding: 24px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-width: 480px;
          }
          .connect-card strong { font-size: 15px; }
          .connect-card p { margin: 0; font-size: 13px; color: var(--bp-text-mute, #6B6E7A); line-height: 1.5; }
          .connect-btn {
            align-self: flex-start;
            margin-top: 6px;
            background: var(--bp-accent, #F2C14E);
            color: var(--bp-accent-ink, #3A2C00);
            font-weight: 600;
            font-size: 14px;
            padding: 10px 16px;
            border: none;
            border-radius: var(--bp-radius-sm, 6px);
          }
          .connect-btn:disabled { opacity: 0.6; }
          .error { color: var(--bp-danger, #D64545); font-size: 13px; margin: 0; }
        `}</style>
      </div>
    );
  }

  if (error) {
    return <p className="list-error" role="alert">{error}</p>;
  }

  if (!posts) {
    return <div className="pl-skeleton" aria-hidden="true" />;
  }

  if (posts.length === 0) {
    return (
      <p className="empty">아직 작성된 글이 없습니다. 상단의 "새 글 작성" 버튼으로 첫 글을 써보세요.</p>
    );
  }

  return (
    <div className="post-table">
      {posts.map((post) => (
        <div className="post-row" key={post.id}>
          <div className="post-main">
            <a className="post-title" href={`/bp-admin/posts/edit?id=${encodeURIComponent(post.id)}`}>{post.title || '(제목 없음)'}</a>
            <div className="post-meta">
              <StatusBadge status={post.status} />
              {post.labels && post.labels.length > 0 && (
                <span className="post-labels">{post.labels.join(', ')}</span>
              )}
            </div>
          </div>
          <div className="post-actions">
            <a href={`/bp-admin/posts/edit?id=${encodeURIComponent(post.id)}`}>편집</a>
            <button
              onClick={() => handleDelete(post.id)}
              disabled={deletingId === post.id}
              className="danger"
            >
              {deletingId === post.id ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </div>
      ))}

      <style>{`
        .pl-skeleton {
          height: 200px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .list-error, .empty {
          padding: 18px 20px;
          border-radius: var(--bp-radius-md, 10px);
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          color: var(--bp-text-mute, #6B6E7A);
          font-size: 14px;
        }
        .post-table {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .post-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
        }
        .post-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .post-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--bp-text, #1B1D23);
          text-decoration: none;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .post-title:hover { color: var(--bp-info, #4E8CF2); }
        .post-meta { display: flex; align-items: center; gap: 8px; }
        .post-labels { font-size: 12px; color: var(--bp-text-mute, #6B6E7A); }
        .post-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 13px;
          flex-shrink: 0;
        }
        .post-actions a { color: var(--bp-info, #4E8CF2); text-decoration: none; font-weight: 500; }
        .post-actions button.danger {
          background: none;
          border: none;
          color: var(--bp-danger, #D64545);
          font-size: 13px;
          font-weight: 500;
          padding: 0;
        }
        .post-actions button.danger:disabled { opacity: 0.5; }
      `}</style>
    </div>
  );
}
