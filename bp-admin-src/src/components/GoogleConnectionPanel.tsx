import { useEffect, useState } from 'react';
import { bloggerApi, ApiError, type BloggerConnectionStatus } from '../lib/api';

export default function GoogleConnectionPanel() {
  const [status, setStatus] = useState<BloggerConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // OAuth 콜백에서 돌아온 직후라면 쿼리스트링으로 결과가 붙어 있다.
    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('googleAuth');
    if (authResult === 'connected') setNotice('Google 계정이 연동되었습니다.');
    else if (authResult === 'invalid_state') setError('연동 요청이 만료되었거나 유효하지 않습니다. 다시 시도해 주세요.');
    else if (authResult === 'error') setError('Google 연동 중 오류가 발생했습니다.');

    if (authResult) {
      // 쿼리스트링을 깨끗이 지워 새로고침 시 중복 알림이 뜨지 않게 한다.
      window.history.replaceState({}, '', '/bp-admin/settings');
    }

    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const s = await bloggerApi.connectionStatus();
      setStatus(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '연동 상태를 불러오지 못했습니다.');
    }
  }

  async function handleConnect() {
    setBusy(true);
    try {
      await bloggerApi.startOAuth();
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? err.message : '연동을 시작하지 못했습니다.');
    }
  }

  async function handleDisconnect() {
    if (!window.confirm('Google 계정 연동을 해제하시겠습니까? 해제 후에는 다시 연동하기 전까지 글 작성/수정이 불가능합니다.')) return;
    setBusy(true);
    try {
      await bloggerApi.disconnect();
      await loadStatus();
      setNotice('연동이 해제되었습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '연동 해제에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Google 계정 (Blogger API)</h2>
        <p>Blogspot에 직접 로그인하지 않고 글을 쓰고 발행하려면 Google 계정 연동이 필요합니다.</p>
      </div>

      {notice && <p className="notice notice-success">{notice}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      {status === null && !error && <div className="skeleton" aria-hidden="true" />}

      {status && (
        <div className="status-row">
          <div>
            <span className={`dot ${status.connected ? 'dot-ok' : 'dot-off'}`} />
            <strong>{status.connected ? '연동됨' : '연동 안 됨'}</strong>
            {status.blog && <span className="blog-name"> · {status.blog.name}</span>}
          </div>
          {status.connected ? (
            <button onClick={handleDisconnect} disabled={busy} className="disconnect-btn">
              {busy ? '처리 중…' : '연동 해제'}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={busy} className="connect-btn">
              {busy ? '이동 중…' : 'Google 계정 연동하기'}
            </button>
          )}
        </div>
      )}

      <style>{`
        .panel {
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
          padding: 22px 24px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          max-width: 560px;
        }
        .panel-head h2 { font-size: 16px; margin-bottom: 4px; }
        .panel-head p { margin: 0; font-size: 13px; color: var(--bp-text-mute, #6B6E7A); }
        .skeleton {
          height: 48px;
          border-radius: var(--bp-radius-sm, 6px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .status-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .status-row .dot {
          display: inline-block;
          width: 8px; height: 8px;
          border-radius: 50%;
          margin-right: 8px;
        }
        .dot-ok { background: var(--bp-success, #2FAE66); }
        .dot-off { background: var(--bp-text-mute, #6B6E7A); }
        .blog-name { color: var(--bp-text-mute, #6B6E7A); font-weight: 400; font-size: 13px; }
        .connect-btn, .disconnect-btn {
          font-size: 13px;
          font-weight: 600;
          padding: 8px 14px;
          border-radius: var(--bp-radius-sm, 6px);
          border: none;
        }
        .connect-btn { background: var(--bp-accent, #F2C14E); color: var(--bp-accent-ink, #3A2C00); }
        .disconnect-btn { background: transparent; color: var(--bp-danger, #D64545); border: 1px solid rgba(214,69,69,0.3) !important; }
        .notice {
          margin: 0;
          font-size: 13px;
          padding: 10px 12px;
          border-radius: var(--bp-radius-sm, 6px);
        }
        .notice-success { background: rgba(47,174,102,0.12); color: #1F7A47; }
        .notice-error { background: rgba(214,69,69,0.1); color: var(--bp-danger, #D64545); }
      `}</style>
    </div>
  );
}
