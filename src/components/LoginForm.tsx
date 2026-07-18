import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

interface LoginResponse {
  ok: true;
  redirectTo: string;
}

interface BootstrapStatus {
  needsBootstrap: boolean;
}

export default function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const expired = params?.get('expired') === '1';

  useEffect(() => {
    let cancelled = false;
    api.get<BootstrapStatus>('/auth/bootstrap-status')
      .then((res) => { if (!cancelled) setNeedsBootstrap(res.needsBootstrap); })
      .catch(() => { /* 조회 실패 시 일반 로그인 폼으로 안전하게 폴백 */ })
      .finally(() => { if (!cancelled) setCheckingBootstrap(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (needsBootstrap && password.length < 8) {
      setError('비밀번호는 8자 이상이어야 합니다.');
      return;
    }

    setPending(true);
    try {
      const endpoint = needsBootstrap ? '/auth/bootstrap' : '/auth/login';
      const res = await api.post<LoginResponse>(endpoint, { username, password });
      window.location.href = res.redirectTo || '/bp-admin';
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? '아이디 또는 비밀번호가 올바르지 않습니다.' : err.message);
      } else {
        setError('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      setPending(false);
    }
  }

  if (checkingBootstrap) {
    return <div className="login-skeleton" aria-hidden="true" />;
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      {needsBootstrap && (
        <p className="notice notice-info">
          아직 관리자 계정이 없습니다. 최초 관리자 계정을 생성하세요.
        </p>
      )}
      {expired && !needsBootstrap && (
        <p className="notice">세션이 만료되어 다시 로그인해 주세요.</p>
      )}

      <label className="field">
        <span>아이디</span>
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />
      </label>

      <label className="field">
        <span>비밀번호</span>
        <input
          type="password"
          name="password"
          autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {needsBootstrap && <small>8자 이상, 다른 사이트와 다른 비밀번호를 사용하세요.</small>}
      </label>

      {error && <p className="error" role="alert">{error}</p>}

      <button type="submit" className="submit" disabled={pending}>
        {pending ? '확인 중…' : needsBootstrap ? '관리자 계정 만들기' : '로그인'}
      </button>

      <style>{`
        .login-skeleton {
          height: 220px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer {
          0% { background-position: 100% 0; }
          100% { background-position: 0 0; }
        }
        .login-form {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--bp-text-mute, #6B6E7A);
        }
        .field input {
          font-size: 15px;
          padding: 11px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          background: #fff;
          color: var(--bp-text, #1B1D23);
        }
        .field input:focus {
          border-color: var(--bp-info, #4E8CF2);
        }
        .field small {
          font-weight: 400;
          color: var(--bp-text-mute, #6B6E7A);
        }
        .notice {
          margin: 0;
          font-size: 13px;
          padding: 10px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          background: rgba(224,168,46,0.12);
          color: #8A6A16;
        }
        .notice-info {
          background: rgba(78,140,242,0.1);
          color: #2A5AA8;
        }
        .error {
          margin: 0;
          font-size: 13px;
          color: var(--bp-danger, #D64545);
        }
        .submit {
          margin-top: 4px;
          background: var(--bp-accent, #F2C14E);
          color: var(--bp-accent-ink, #3A2C00);
          font-weight: 600;
          font-size: 14px;
          padding: 12px;
          border: none;
          border-radius: var(--bp-radius-sm, 6px);
          transition: background 0.12s ease;
        }
        .submit:hover:not(:disabled) { background: var(--bp-accent-hover, #E0AE3A); }
        .submit:disabled { opacity: 0.6; cursor: default; }
      `}</style>
    </form>
  );
}
