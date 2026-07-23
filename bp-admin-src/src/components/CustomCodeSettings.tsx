import { useEffect, useState } from 'react';
import { customCodeApi, ApiError, type CustomCodeConfig } from '../lib/api';

export default function CustomCodeSettings() {
  const [config, setConfig] = useState<CustomCodeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    customCodeApi.get()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : '설정을 불러오지 못했습니다.'); });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    if (!config) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const saved = await customCodeApi.save(config);
      setConfig(saved);
      setNotice('저장되었습니다. 반영까지 최대 1~2분이 걸릴 수 있습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return <div className="cc-skeleton" aria-hidden="true" />;
  }

  return (
    <div className="cc-settings">
      <div className="cc-head">
        <h2>헤더/바디/푸터 코드 삽입</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          <span>사용</span>
        </label>
      </div>
      <p className="cc-desc">
        GA4, 네이버 웹마스터도구 인증 태그, 각종 추적/광고 스크립트를 직접 삽입할 수 있습니다.
        입력한 코드는 그대로 페이지에 삽입되니 신뢰할 수 있는 코드만 넣어주세요.
      </p>

      {notice && <p className="notice notice-success">{notice}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <label className="field">
        <span>Head 코드 (&lt;/head&gt; 직전에 삽입)</span>
        <textarea
          value={config.headCode}
          onChange={(e) => setConfig({ ...config, headCode: e.target.value })}
          rows={4}
          placeholder='<meta name="google-site-verification" content="...">'
        />
      </label>

      <label className="field">
        <span>Body 시작 코드 (&lt;body&gt; 직후에 삽입)</span>
        <textarea
          value={config.bodyOpenCode}
          onChange={(e) => setConfig({ ...config, bodyOpenCode: e.target.value })}
          rows={3}
          placeholder="예: GTM noscript 태그"
        />
      </label>

      <label className="field">
        <span>Body 종료 전 코드 (우선순위 높음)</span>
        <textarea
          value={config.beforeClosingBodyCode}
          onChange={(e) => setConfig({ ...config, beforeClosingBodyCode: e.target.value })}
          rows={3}
        />
      </label>

      <label className="field">
        <span>Footer 코드 (&lt;/body&gt; 직전, 우선순위 낮음)</span>
        <textarea
          value={config.footerCode}
          onChange={(e) => setConfig({ ...config, footerCode: e.target.value })}
          rows={3}
          placeholder="예: GA4 스크립트"
        />
      </label>

      <button type="button" onClick={handleSave} disabled={saving} className="save-btn">
        {saving ? '저장 중…' : '저장'}
      </button>

      <style>{`
        .cc-skeleton {
          height: 380px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .cc-settings {
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
          padding: 22px 24px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-width: 640px;
        }
        .cc-head { display: flex; align-items: center; justify-content: space-between; }
        .cc-head h2 { font-size: 16px; }
        .toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bp-text-mute, #6B6E7A); }
        .cc-desc { margin: 0 0 4px; font-size: 12px; color: var(--bp-text-mute, #6B6E7A); line-height: 1.5; }
        .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bp-text-mute, #6B6E7A); }
        .field textarea {
          font-size: 12px;
          font-family: var(--bp-font-mono, monospace);
          padding: 9px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          resize: vertical;
        }
        .notice { margin: 0; font-size: 13px; padding: 10px 12px; border-radius: var(--bp-radius-sm, 6px); }
        .notice-success { background: rgba(47,174,102,0.12); color: #1F7A47; }
        .notice-error { background: rgba(214,69,69,0.1); color: var(--bp-danger, #D64545); }
        .save-btn {
          align-self: flex-start;
          background: var(--bp-accent, #F2C14E);
          color: var(--bp-accent-ink, #3A2C00);
          font-weight: 600;
          font-size: 14px;
          padding: 9px 18px;
          border: none;
          border-radius: var(--bp-radius-sm, 6px);
        }
        .save-btn:disabled { opacity: 0.6; }
      `}</style>
    </div>
  );
}
