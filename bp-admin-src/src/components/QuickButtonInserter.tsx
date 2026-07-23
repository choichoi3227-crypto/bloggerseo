import { useState } from 'react';

interface Props {
  onInsertButton: (html: string) => void;
}

const SIZE_PADDING: Record<string, string> = {
  small: '8px 16px',
  medium: '12px 24px',
  large: '16px 32px',
};

const SIZE_FONT: Record<string, string> = {
  small: '13px',
  medium: '15px',
  large: '18px',
};

/**
 * alpack-2(presslearn)의 "빠른 버튼" 블록 기능을 이식한 CTA 버튼
 * 삽입 도구. 원본은 워드프레스 구텐베르크 블록이었지만, 여기서는
 * 설정값으로 HTML을 즉시 생성해 Blogger 글 본문(HTML)에 삽입하는
 * 방식으로 재구현했다.
 */
export default function QuickButtonInserter({ onInsertButton }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('자세히 보기');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState('#2196F3');
  const [textColor, setTextColor] = useState('#ffffff');
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('center');
  const [openInNewTab, setOpenInNewTab] = useState(true);

  function handleInsert() {
    if (!url.trim()) return;
    const target = openInNewTab ? ' target="_blank" rel="noopener noreferrer"' : '';
    const html = `<div style="text-align:${align};margin:20px 0;">` +
      `<a href="${escapeAttr(url.trim())}"${target} style="display:inline-block;padding:${SIZE_PADDING[size]};` +
      `background-color:${color};color:${textColor};text-decoration:none;border-radius:4px;` +
      `font-weight:bold;font-size:${SIZE_FONT[size]};">${escapeHtml(text || '버튼')}</a></div>`;
    onInsertButton(html);
    setOpen(false);
  }

  return (
    <div className="qb-panel">
      <button type="button" className="qb-toggle" onClick={() => setOpen((v) => !v)}>
        🔘 빠른 버튼 삽입 {open ? '숨기기' : '열기'}
      </button>

      {open && (
        <div className="qb-body">
          <div className="qb-row">
            <label className="qb-field">
              <span>버튼 텍스트</span>
              <input type="text" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <label className="qb-field qb-field-grow">
              <span>링크 URL</span>
              <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
            </label>
          </div>

          <div className="qb-row">
            <label className="qb-field">
              <span>배경색</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
            <label className="qb-field">
              <span>글자색</span>
              <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} />
            </label>
            <label className="qb-field">
              <span>크기</span>
              <select value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
                <option value="small">작게</option>
                <option value="medium">보통</option>
                <option value="large">크게</option>
              </select>
            </label>
            <label className="qb-field">
              <span>정렬</span>
              <select value={align} onChange={(e) => setAlign(e.target.value as typeof align)}>
                <option value="left">왼쪽</option>
                <option value="center">가운데</option>
                <option value="right">오른쪽</option>
              </select>
            </label>
          </div>

          <label className="qb-checkbox">
            <input type="checkbox" checked={openInNewTab} onChange={(e) => setOpenInNewTab(e.target.checked)} />
            <span>새 탭에서 열기</span>
          </label>

          <div className="qb-preview" style={{ textAlign: align }}>
            <a
              href="#preview"
              onClick={(e) => e.preventDefault()}
              style={{
                display: 'inline-block',
                padding: SIZE_PADDING[size],
                backgroundColor: color,
                color: textColor,
                textDecoration: 'none',
                borderRadius: 4,
                fontWeight: 'bold',
                fontSize: SIZE_FONT[size],
              }}
            >
              {text || '버튼'}
            </a>
          </div>

          <button type="button" className="qb-insert-btn" onClick={handleInsert} disabled={!url.trim()}>
            본문에 삽입
          </button>
        </div>
      )}

      <style>{`
        .qb-panel { border: 1px solid var(--bp-border, #E4E3DD); border-radius: var(--bp-radius-sm, 6px); }
        .qb-toggle {
          width: 100%; text-align: left; background: transparent; border: none;
          padding: 10px 12px; font-size: 13px; font-weight: 600; color: var(--bp-text, #1B1D23);
        }
        .qb-body { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
        .qb-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .qb-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--bp-text-mute, #6B6E7A); }
        .qb-field-grow { flex: 1; min-width: 160px; }
        .qb-field input[type="text"], .qb-field select {
          font-size: 13px; padding: 7px 9px; border-radius: var(--bp-radius-sm, 6px); border: 1px solid var(--bp-border, #E4E3DD);
        }
        .qb-field input[type="color"] { width: 40px; height: 32px; padding: 2px; border-radius: var(--bp-radius-sm, 6px); border: 1px solid var(--bp-border, #E4E3DD); }
        .qb-checkbox { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--bp-text-mute, #6B6E7A); }
        .qb-preview { padding: 12px; background: var(--bp-canvas, #F7F7F5); border-radius: var(--bp-radius-sm, 6px); }
        .qb-insert-btn {
          align-self: flex-start; background: var(--bp-accent, #F2C14E); color: var(--bp-accent-ink, #3A2C00);
          font-weight: 600; font-size: 13px; padding: 8px 14px; border: none; border-radius: var(--bp-radius-sm, 6px);
        }
        .qb-insert-btn:disabled { opacity: 0.5; }
      `}</style>
    </div>
  );
}

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(str: string) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
