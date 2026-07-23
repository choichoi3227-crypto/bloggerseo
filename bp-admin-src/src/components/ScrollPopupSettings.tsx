import { useEffect, useState } from 'react';
import { scrollPopupApi, ApiError, type ScrollPopupConfig } from '../lib/api';

export default function ScrollPopupSettings() {
  const [config, setConfig] = useState<ScrollPopupConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    scrollPopupApi.get()
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
      const saved = await scrollPopupApi.save(config);
      setConfig(saved);
      setNotice('저장되었습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return <div className="scroll-skeleton" aria-hidden="true" />;
  }

  return (
    <div className="scroll-settings">
      <div className="scroll-head">
        <h2>스크롤 팝업</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          <span>사용</span>
        </label>
      </div>

      {notice && <p className="notice notice-success">{notice}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <label className="field">
        <span>팝업 내용 (HTML)</span>
        <textarea
          value={config.content}
          onChange={(e) => setConfig({ ...config, content: e.target.value })}
          rows={6}
          placeholder="예: <h3>이벤트 안내</h3><p>지금 가입하면 할인쿠폰을 드려요.</p>"
        />
      </label>

      <div className="row">
        <label className="field">
          <span>트리거 스크롤 비율 (%)</span>
          <input
            type="number"
            min={1}
            max={100}
            value={config.scrollPercentage}
            onChange={(e) => setConfig({ ...config, scrollPercentage: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span>애니메이션</span>
          <select
            value={config.animation}
            onChange={(e) => setConfig({ ...config, animation: e.target.value as ScrollPopupConfig['animation'] })}
          >
            <option value="fade">페이드</option>
            <option value="slide">슬라이드</option>
            <option value="zoom">줌</option>
          </select>
        </label>
      </div>

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={config.repeatOncePerMonth}
          onChange={(e) => setConfig({ ...config, repeatOncePerMonth: e.target.checked })}
        />
        <span>한 방문자에게 30일에 한 번만 표시 (끄면 스크롤할 때마다 계속 표시)</span>
      </label>

      <button type="button" onClick={handleSave} disabled={saving} className="save-btn">
        {saving ? '저장 중…' : '저장'}
      </button>

      <style>{`
        .scroll-skeleton {
          height: 280px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .scroll-settings {
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
          padding: 22px 24px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          max-width: 560px;
        }
        .scroll-head { display: flex; align-items: center; justify-content: space-between; }
        .scroll-head h2 { font-size: 16px; }
        .toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bp-text-mute, #6B6E7A); }
        .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bp-text-mute, #6B6E7A); }
        .field input, .field select, .field textarea {
          font-size: 14px;
          font-family: inherit;
          padding: 9px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
        }
        .field textarea { font-family: var(--bp-font-mono, monospace); font-size: 13px; resize: vertical; }
        .row { display: flex; gap: 12px; }
        .row .field { flex: 1; }
        .checkbox-field {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--bp-text-mute, #6B6E7A);
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
