import { useEffect, useState } from 'react';
import { shareConfigApi, ApiError, type ShareConfig, type ShareNetwork } from '../lib/api';

const NETWORK_LABELS: Record<ShareNetwork, string> = {
  facebook: '페이스북',
  twitter: 'X (트위터)',
  kakaotalk: '카카오톡',
  naver: '네이버',
  band: '밴드',
  line: '라인',
};

const ALL_NETWORKS = Object.keys(NETWORK_LABELS) as ShareNetwork[];

export default function ShareButtonSettings() {
  const [config, setConfig] = useState<ShareConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    shareConfigApi.get()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : '설정을 불러오지 못했습니다.'); });
    return () => { cancelled = true; };
  }, []);

  function toggleNetwork(network: ShareNetwork) {
    if (!config) return;
    const networks = config.networks.includes(network)
      ? config.networks.filter((n) => n !== network)
      : [...config.networks, network];
    setConfig({ ...config, networks });
  }

  async function handleSave() {
    if (!config) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const saved = await shareConfigApi.save(config);
      setConfig(saved);
      setNotice('저장되었습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return <div className="share-skeleton" aria-hidden="true" />;
  }

  return (
    <div className="share-settings">
      <div className="share-head">
        <h2>SNS 공유 버튼</h2>
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

      <div className="network-grid">
        {ALL_NETWORKS.map((network) => (
          <label key={network} className="network-item">
            <input
              type="checkbox"
              checked={config.networks.includes(network)}
              onChange={() => toggleNetwork(network)}
            />
            <span>{NETWORK_LABELS[network]}</span>
          </label>
        ))}
      </div>

      {config.networks.includes('kakaotalk') && (
        <label className="field">
          <span>카카오 JavaScript 키</span>
          <input
            type="text"
            value={config.kakaoJsKey}
            onChange={(e) => setConfig({ ...config, kakaoJsKey: e.target.value })}
            placeholder="카카오 개발자센터에서 발급한 JavaScript 키"
          />
          <small>카카오톡 공유를 사용하려면 <a href="https://developers.kakao.com" target="_blank" rel="noopener noreferrer">카카오 개발자센터</a>에서 앱을 등록하고 JavaScript 키를 발급받으세요.</small>
        </label>
      )}

      <label className="field">
        <span>버튼 위치</span>
        <select value={config.position} onChange={(e) => setConfig({ ...config, position: e.target.value as 'top' | 'bottom' })}>
          <option value="bottom">본문 아래</option>
          <option value="top">본문 위</option>
        </select>
      </label>

      <button type="button" onClick={handleSave} disabled={saving} className="save-btn">
        {saving ? '저장 중…' : '저장'}
      </button>

      <style>{`
        .share-skeleton {
          height: 200px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .share-settings {
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
          padding: 22px 24px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          max-width: 560px;
        }
        .share-head { display: flex; align-items: center; justify-content: space-between; }
        .share-head h2 { font-size: 16px; }
        .toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bp-text-mute, #6B6E7A); }
        .network-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .network-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          padding: 8px 10px;
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-sm, 6px);
        }
        .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bp-text-mute, #6B6E7A); }
        .field input, .field select {
          font-size: 14px;
          padding: 9px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
        }
        .field small { font-weight: 400; color: var(--bp-text-mute, #6B6E7A); }
        .field small a { color: var(--bp-info, #4E8CF2); }
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
