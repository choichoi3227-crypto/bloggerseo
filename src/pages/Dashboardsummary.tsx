import { useEffect, useState } from 'react';
import { api, ApiError, type DashboardSummary as SummaryData } from '../lib/api';

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <span className="card-value">{value}</span>
      {hint && <span className="card-hint">{hint}</span>}
      <style>{`
        .card {
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .card-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--bp-text-mute, #6B6E7A);
        }
        .card-value {
          font-family: var(--bp-font-mono, monospace);
          font-size: 24px;
          font-weight: 500;
          color: var(--bp-text, #1B1D23);
        }
        .card-hint {
          font-size: 12px;
          color: var(--bp-text-mute, #6B6E7A);
        }
      `}</style>
    </div>
  );
}

export default function DashboardSummary() {
  const [data, setData] = useState<SummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<SummaryData>('/dashboard/summary')
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : '요약 정보를 불러오지 못했습니다.');
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return <p className="summary-error" role="alert">{error}</p>;
  }

  if (!data) {
    return (
      <div className="summary-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card skeleton" />
        ))}
        <style>{`
          .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
          .skeleton {
            height: 78px;
            background: var(--bp-surface, #fff);
            border: 1px solid var(--bp-border, #E4E3DD);
            border-radius: var(--bp-radius-md, 10px);
            opacity: 0.5;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="summary-grid">
      <Card
        label="연결된 사이트"
        value={data.siteHost || '미감지'}
        hint={data.siteTitle || undefined}
      />
      <Card
        label="발행된 글"
        value={String(data.postsCount)}
      />
      <Card
        label="캐시 히트율"
        value={data.cacheHitRate != null ? `${Math.round(data.cacheHitRate * 100)}%` : '—'}
        hint={data.redisShardsActive != null ? `${data.redisShardsActive}개 샤드 활성` : undefined}
      />
      <Card
        label="차단된 IP"
        value={String(data.blockedIpsCount)}
      />
      <style>{`
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
        }
        @media (max-width: 880px) {
          .summary-grid { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>
    </div>
  );
}
