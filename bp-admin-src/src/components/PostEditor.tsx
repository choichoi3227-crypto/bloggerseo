import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bloggerApi, aiWriterApi, ApiError, type PostGenerationType } from '../lib/api';
import AiThumbnailPanel from './AiThumbnailPanel';
import QuickButtonInserter from './QuickButtonInserter';
import RichTextEditor, { type RichTextEditorHandle } from './RichTextEditor';

interface Props {
  /** 수정 모드일 때 기존 글 ID. 없으면 새 글 작성 모드. */
  postId?: string;
}

const POST_TYPE_OPTIONS: { value: PostGenerationType; label: string }[] = [
  { value: 'informational', label: '정보성' },
  { value: 'utility', label: '유틸리티 (프로그램/서비스)' },
  { value: 'policy_guide', label: '정책·공공 정보' },
  { value: 'review_comparison', label: '리뷰·비교' },
];

export default function PostEditor({ postId }: Props) {
  const isEditMode = !!postId;

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [labelsInput, setLabelsInput] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState<'draft' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // AI 초안 생성
  const [aiTopic, setAiTopic] = useState('');
  const [aiType, setAiType] = useState<PostGenerationType>('informational');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(!isEditMode);

  // 선택 텍스트 확장
  const [expanding, setExpanding] = useState(false);
  const editorRef = useRef<RichTextEditorHandle>(null);

  useEffect(() => {
    if (!isEditMode) return;
    let cancelled = false;
    bloggerApi.getPost(postId!)
      .then((post) => {
        if (cancelled) return;
        setTitle(post.title || '');
        setContent(post.content || '');
        setLabelsInput((post.labels || []).join(', '));
        setStatus(post.status);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : '글을 불러오지 못했습니다.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [postId]);

  function parseLabels(): string[] {
    return labelsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleGenerateDraft() {
    if (!aiTopic.trim()) {
      setError('AI로 생성할 주제를 입력해 주세요.');
      return;
    }
    setError(null);
    setNotice(null);
    setAiGenerating(true);
    try {
      const result = await aiWriterApi.generatePost(aiTopic.trim(), aiType);
      editorRef.current?.insertHtml(result.html);
      if (!title.trim()) setTitle(aiTopic.trim());
      if (!labelsInput.trim() && result.metaInfo.focusKeyword) {
        setLabelsInput(result.metaInfo.focusKeyword);
      }
      setNotice('AI 초안이 생성되어 본문에 추가되었습니다. 내용을 검토한 뒤 저장하세요.');
      setAiPanelOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'AI 초안 생성 중 오류가 발생했습니다.');
    } finally {
      setAiGenerating(false);
    }
  }

  async function handleExpandSelection() {
    const selectedText = editorRef.current?.getSelectedText() || '';
    if (!selectedText.trim()) {
      setError('먼저 본문에서 확장할 문장을 드래그해 선택해 주세요.');
      return;
    }
    setError(null);
    setExpanding(true);
    try {
      const result = await aiWriterApi.expandText({
        selectedText,
        fullContent: editorRef.current?.getPlainText() || '',
        postTitle: title,
      });
      editorRef.current?.replaceSelection(result.text);
      setNotice('선택한 문장이 확장되었습니다.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '텍스트 확장 중 오류가 발생했습니다.');
    } finally {
      setExpanding(false);
    }
  }

  async function handleSave(publish: boolean, e?: FormEvent) {
    e?.preventDefault();
    if (!title.trim()) {
      setError('제목을 입력해 주세요.');
      return;
    }
    setError(null);
    setNotice(null);
    setSaving(publish ? 'publish' : 'draft');

    try {
      const labels = parseLabels();

      if (isEditMode) {
        await bloggerApi.updatePost(postId!, { title, content, labels });
        if (publish && status !== 'LIVE') {
          await bloggerApi.publishPost(postId!);
          setStatus('LIVE');
        }
        setNotice(publish ? '발행되었습니다.' : '저장되었습니다.');
      } else {
        const created = await bloggerApi.createPost({ title, content, labels, isDraft: !publish });
        // 새 글이 만들어졌으니 수정 화면으로 이동해 이후 저장은 PATCH로 이어지게 한다.
        window.location.href = `/bp-admin/posts/edit?id=${encodeURIComponent(created.id)}&created=1${publish ? '&published=1' : ''}`;
        return;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '저장 중 오류가 발생했습니다.');
    } finally {
      setSaving(null);
    }
  }

  async function handleDelete() {
    if (!postId) return;
    if (!window.confirm('이 글을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    try {
      await bloggerApi.deletePost(postId);
      window.location.href = '/bp-admin/posts';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '삭제하지 못했습니다.');
    }
  }

  function handleInsertImage(imgTag: string) {
    editorRef.current?.insertHtml(imgTag);
    setNotice('썸네일이 본문에 삽입되었습니다.');
  }

  function handleInsertButton(buttonHtml: string) {
    editorRef.current?.insertHtml(buttonHtml);
    setNotice('버튼이 본문에 삽입되었습니다.');
  }

  if (loading) {
    return <div className="editor-skeleton" aria-hidden="true" />;
  }

  return (
    <form className="editor" onSubmit={(e) => handleSave(false, e)}>
      {notice && <p className="notice notice-success">{notice}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <div className="ai-panel">
        <button
          type="button"
          className="ai-panel-toggle"
          onClick={() => setAiPanelOpen((v) => !v)}
        >
          ✨ AI로 초안 생성 {aiPanelOpen ? '숨기기' : '열기'}
        </button>

        {aiPanelOpen && (
          <div className="ai-panel-body">
            <div className="ai-panel-row">
              <input
                type="text"
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                placeholder="주제를 입력하세요 (예: 전세자금대출 한도)"
                className="ai-topic-input"
              />
              <select value={aiType} onChange={(e) => setAiType(e.target.value as PostGenerationType)}>
                {POST_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="ai-generate-btn"
                onClick={handleGenerateDraft}
                disabled={aiGenerating}
              >
                {aiGenerating ? '생성 중… (최대 2~3분)' : '초안 생성'}
              </button>
            </div>
            <small>AI가 SEO 최적화된 초안을 생성해 본문에 추가합니다. 생성 후 반드시 내용을 검토하고 사실관계를 확인하세요.</small>
          </div>
        )}
      </div>

      <AiThumbnailPanel onInsertImage={handleInsertImage} defaultTopic={aiTopic || title} />
      <QuickButtonInserter onInsertButton={handleInsertButton} />

      <label className="field">
        <span>제목</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="글 제목을 입력하세요"
          required
        />
      </label>

      <label className="field">
        <span>라벨 (쉼표로 구분)</span>
        <input
          type="text"
          value={labelsInput}
          onChange={(e) => setLabelsInput(e.target.value)}
          placeholder="예: 여행, 맛집, 서울"
        />
      </label>

      <div className="field">
        <div className="field-label-row">
          <span>본문</span>
          <button
            type="button"
            className="expand-btn"
            onClick={handleExpandSelection}
            disabled={expanding}
          >
            {expanding ? '확장 중…' : '✨ 선택 문장 AI 확장'}
          </button>
        </div>
        <RichTextEditor
          ref={editorRef}
          content={content}
          onChange={setContent}
          placeholder="본문을 입력하거나, 워드/한글/네이버블로그 등에서 복사한 글을 붙여넣어 보세요. 자동으로 서식이 정리됩니다."
        />
        <small>문장을 드래그해 선택한 뒤 위 "선택 문장 AI 확장" 버튼을 누르면 3~4문장으로 풀어씁니다.</small>
      </div>

      <div className="editor-actions">
        {isEditMode && (
          <button type="button" className="delete-btn" onClick={handleDelete}>
            삭제
          </button>
        )}
        <div className="spacer" />
        <button type="submit" className="draft-btn" disabled={saving !== null}>
          {saving === 'draft' ? '저장 중…' : '임시저장'}
        </button>
        <button
          type="button"
          className="publish-btn"
          disabled={saving !== null}
          onClick={() => handleSave(true)}
        >
          {saving === 'publish' ? '발행 중…' : status === 'LIVE' ? '변경사항 발행' : '발행하기'}
        </button>
      </div>

      <style>{`
        .editor-skeleton {
          height: 480px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .editor {
          display: flex;
          flex-direction: column;
          gap: 16px;
          background: var(--bp-surface, #fff);
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-md, 10px);
          padding: 24px;
        }
        .ai-panel {
          border: 1px solid rgba(242,193,78,0.4);
          background: rgba(242,193,78,0.06);
          border-radius: var(--bp-radius-sm, 6px);
          padding: 4px;
        }
        .ai-panel-toggle {
          width: 100%;
          text-align: left;
          background: transparent;
          border: none;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 600;
          color: var(--bp-text, #1B1D23);
        }
        .ai-panel-body {
          padding: 4px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .ai-panel-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .ai-topic-input {
          flex: 1;
          min-width: 200px;
          font-size: 14px;
          padding: 9px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
        }
        .ai-panel-row select {
          font-size: 13px;
          padding: 9px 10px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          background: #fff;
        }
        .ai-generate-btn {
          background: var(--bp-accent, #F2C14E);
          color: var(--bp-accent-ink, #3A2C00);
          font-weight: 600;
          font-size: 13px;
          padding: 9px 16px;
          border: none;
          border-radius: var(--bp-radius-sm, 6px);
          white-space: nowrap;
        }
        .ai-generate-btn:disabled { opacity: 0.6; }
        .ai-panel small { color: var(--bp-text-mute, #6B6E7A); font-size: 12px; }
        .field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--bp-text-mute, #6B6E7A);
        }
        .field-label-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .expand-btn {
          background: transparent;
          border: 1px solid var(--bp-border, #E4E3DD);
          color: var(--bp-text, #1B1D23);
          font-size: 12px;
          font-weight: 600;
          padding: 5px 10px;
          border-radius: var(--bp-radius-sm, 6px);
        }
        .expand-btn:disabled { opacity: 0.6; }
        .field input {
          font-size: 14px;
          font-family: inherit;
          padding: 10px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          color: var(--bp-text, #1B1D23);
        }
        .field small { font-weight: 400; color: var(--bp-text-mute, #6B6E7A); }
        .notice {
          margin: 0;
          font-size: 13px;
          padding: 10px 12px;
          border-radius: var(--bp-radius-sm, 6px);
        }
        .notice-success { background: rgba(47,174,102,0.12); color: #1F7A47; }
        .notice-error { background: rgba(214,69,69,0.1); color: var(--bp-danger, #D64545); }
        .editor-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .spacer { flex: 1; }
        .editor-actions button {
          padding: 10px 18px;
          border-radius: var(--bp-radius-sm, 6px);
          font-size: 14px;
          font-weight: 600;
          border: none;
        }
        .delete-btn { background: transparent; color: var(--bp-danger, #D64545); border: 1px solid rgba(214,69,69,0.3) !important; }
        .draft-btn { background: var(--bp-canvas, #F7F7F5); color: var(--bp-text, #1B1D23); border: 1px solid var(--bp-border, #E4E3DD) !important; }
        .publish-btn { background: var(--bp-accent, #F2C14E); color: var(--bp-accent-ink, #3A2C00); }
        .editor-actions button:disabled { opacity: 0.6; }
      `}</style>
    </form>
  );
}
