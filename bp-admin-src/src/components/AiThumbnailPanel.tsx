import { useEffect, useState } from 'react';
import { aiThumbnailApi, ApiError, type ThumbnailStyle, type ThumbnailStyleOption } from '../lib/api';

interface Props {
  /** 이미지가 생성되면 <img> 태그를 본문에 삽입할 수 있도록 부모에게 알린다. */
  onInsertImage: (imgTag: string) => void;
  /** 에디터의 주제 입력을 재사용하기 위한 기본값 (선택) */
  defaultTopic?: string;
}

export default function AiThumbnailPanel({ onInsertImage, defaultTopic = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState(defaultTopic);
  const [style, setStyle] = useState<ThumbnailStyle>('poster');
  const [styles, setStyles] = useState<ThumbnailStyleOption[]>([]);
  const [generating, setGenerating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [negPrompt, setNegPrompt] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || styles.length > 0) return;
    aiThumbnailApi.listStyles()
      .then((res) => setStyles(res.styles))
      .catch(() => { /* 스타일 목록 실패해도 기본 select 옵션으로 폴백 */ });
  }, [open]);

  async function handleGeneratePrompt() {
    if (!topic.trim()) {
      setError('썸네일 주제를 입력해 주세요.');
      return;
    }
    setError(null);
    setGenerating(true);
    setImageDataUrl(null);
    try {
      const result = await aiThumbnailApi.generatePrompt(topic.trim(), style);
      setPrompt(result.prompt);
      setNegPrompt(result.negPrompt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '프롬프트 생성 중 오류가 발생했습니다.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRender() {
    if (!prompt.trim()) {
      setError('먼저 프롬프트를 생성해 주세요.');
      return;
    }
    setError(null);
    setRendering(true);
    try {
      const result = await aiThumbnailApi.render(prompt, negPrompt);
      setImageDataUrl(result.dataUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '이미지 생성 중 오류가 발생했습니다.');
    } finally {
      setRendering(false);
    }
  }

  function handleInsert() {
    if (!imageDataUrl) return;
    const safeAlt = topic.trim().replace(/"/g, '&quot;');
    onInsertImage(`<img src="${imageDataUrl}" alt="${safeAlt}" />`);
    setImageDataUrl(null);
  }

  const fallbackStyles: ThumbnailStyleOption[] = [
    { key: 'poster', label: '포스터' },
    { key: 'minimal', label: '미니멀' },
    { key: 'photo_realistic', label: '사실적 사진' },
    { key: 'typography', label: '타이포그래피' },
    { key: 'branding', label: '브랜딩' },
  ];
  const styleOptions = styles.length > 0 ? styles : fallbackStyles;

  return (
    <div className="thumb-panel">
      <button type="button" className="thumb-toggle" onClick={() => setOpen((v) => !v)}>
        🎨 AI 썸네일 생성 {open ? '숨기기' : '열기'}
      </button>

      {open && (
        <div className="thumb-body">
          {error && <p className="thumb-error" role="alert">{error}</p>}

          <div className="thumb-row">
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="썸네일 주제 (예: 전세자금대출)"
              className="thumb-topic-input"
            />
            <select value={style} onChange={(e) => setStyle(e.target.value as ThumbnailStyle)}>
              {styleOptions.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <button type="button" onClick={handleGeneratePrompt} disabled={generating} className="thumb-btn">
              {generating ? '생성 중…' : '프롬프트 생성'}
            </button>
          </div>

          {prompt && (
            <div className="thumb-prompt-preview">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="생성된 프롬프트 (직접 수정 가능)"
              />
              <button type="button" onClick={handleRender} disabled={rendering} className="thumb-render-btn">
                {rendering ? '이미지 생성 중… (10~30초)' : '이 프롬프트로 이미지 생성'}
              </button>
            </div>
          )}

          {imageDataUrl && (
            <div className="thumb-result">
              <img src={imageDataUrl} alt="생성된 썸네일 미리보기" />
              <button type="button" onClick={handleInsert} className="thumb-insert-btn">
                본문에 삽입
              </button>
            </div>
          )}

          <small>AI가 만든 이미지는 실제와 다를 수 있습니다. 삽입 전 미리보기로 확인하세요.</small>
        </div>
      )}

      <style>{`
        .thumb-panel {
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-sm, 6px);
        }
        .thumb-toggle {
          width: 100%;
          text-align: left;
          background: transparent;
          border: none;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 600;
          color: var(--bp-text, #1B1D23);
        }
        .thumb-body {
          padding: 4px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .thumb-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .thumb-topic-input {
          flex: 1;
          min-width: 180px;
          font-size: 13px;
          padding: 8px 10px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
        }
        .thumb-row select {
          font-size: 13px;
          padding: 8px 10px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          background: #fff;
        }
        .thumb-btn, .thumb-render-btn, .thumb-insert-btn {
          background: var(--bp-canvas, #F7F7F5);
          border: 1px solid var(--bp-border, #E4E3DD);
          color: var(--bp-text, #1B1D23);
          font-size: 12px;
          font-weight: 600;
          padding: 8px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          white-space: nowrap;
        }
        .thumb-insert-btn { background: var(--bp-accent, #F2C14E); border: none; color: var(--bp-accent-ink, #3A2C00); }
        .thumb-btn:disabled, .thumb-render-btn:disabled { opacity: 0.6; }
        .thumb-prompt-preview {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .thumb-prompt-preview textarea {
          font-size: 12px;
          font-family: var(--bp-font-mono, monospace);
          padding: 8px 10px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          resize: vertical;
        }
        .thumb-result { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
        .thumb-result img {
          max-width: 100%;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
        }
        .thumb-error { margin: 0; font-size: 12px; color: var(--bp-danger, #D64545); }
        .thumb-body small { color: var(--bp-text-mute, #6B6E7A); font-size: 11px; }
      `}</style>
    </div>
  );
}
