import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type PulseState = 'ok' | 'degraded' | 'down' | 'loading';

interface SystemStatus {
  worker: PulseState;
  cache: PulseState;
  blogger: PulseState;
}

const LABELS: Record<keyof SystemStatus, string> = {
  worker: 'Worker',
  cache: 'Cache',
  blogger: 'Blogger',
};

/**
 * 사이드바 상단에 항상 보이는 3점 상태 표시기.
 * 이 관리자 화면의 "시그니처 요소" — Blogger 프록시 + 자체 캐시 엔진이라는
 * bloggerseo 아키텍처의 핵심을 시각적으로 항상 드러낸다.
 * client:idle 로 로드되므로 초기 페이지 렌더를 막지 않는다.
 */
export default function StatusPulse() {
  const [status, setStatus] = useState<SystemStatus>({
    worker: 'loading',
    cache: 'loading',
    blogger: 'loading',
  });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await api.get<SystemStatus>('/status/pulse');
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus({ worker: 'down', cache: 'down', blogger: 'down' });
      }
    }

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="pulse">
      {(Object.keys(LABELS) as (keyof SystemStatus)[]).map((key) => (
        <div className="pulse-row" key={key}>
          <span className={`dot dot-${status[key]}`} aria-hidden="true" />
          <span className="pulse-label">{LABELS[key]}</span>
        </div>
      ))}

      <style>{`
        .pulse {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 8px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(241,241,238,0.08);
          border-radius: var(--bp-radius-md, 10px);
        }
        .pulse-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--bp-text-inv-mute, #9296AC);
        }
        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .dot-ok { background: #2FAE66; box-shadow: 0 0 0 3px rgba(47,174,102,0.18); }
        .dot-degraded { background: #E0A82E; box-shadow: 0 0 0 3px rgba(224,168,46,0.18); }
        .dot-down { background: #D64545; box-shadow: 0 0 0 3px rgba(214,69,69,0.18); }
        .dot-loading {
          background: #6B6E7A;
          animation: pulse-fade 1.4s ease-in-out infinite;
        }
        @keyframes pulse-fade {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
