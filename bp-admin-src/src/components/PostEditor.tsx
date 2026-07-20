import { useEffect, useState, type FormEvent } from 'react';
import { bloggerApi, ApiError, type BloggerPost } from '../lib/api';

interface Props {
  /** 수정 모드일 때 기존 글 ID. 없으면 새 글 작성 모드. */
  postId?: string;
}

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

  if (loading) {
    return <div className="editor-skeleton" aria-hidden="true" />;
  }

  return (
    <form className="editor" onSubmit={(e) => handleSave(false, e)}>
      {notice && <p className="notice notice-success">{notice}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}

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

      <label className="field">
        <span>본문 (HTML)</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="본문 내용을 입력하세요. HTML 태그를 직접 쓸 수 있습니다."
          rows={18}
        />
        <small>이미지는 본문 안에 &lt;img src="..."&gt; 형태로 직접 삽입합니다. 다음 단계에서 이미지 업로드 버튼이 추가될 예정입니다.</small>
      </label>

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
        .field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--bp-text-mute, #6B6E7A);
        }
        .field input, .field textarea {
          font-size: 14px;
          font-family: inherit;
          padding: 10px 12px;
          border-radius: var(--bp-radius-sm, 6px);
          border: 1px solid var(--bp-border, #E4E3DD);
          color: var(--bp-text, #1B1D23);
          resize: vertical;
        }
        .field textarea { font-family: var(--bp-font-mono, monospace); font-size: 13px; line-height: 1.6; }
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
