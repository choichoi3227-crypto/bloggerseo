import { useEffect, useImperativeHandle, forwardRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import ImageExtension from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { sanitizePastedHtml, detectPasteSource, type PasteSource } from '../lib/paste-sanitizer';

export interface RichTextEditorHandle {
  /** 커서 위치(또는 선택 영역을 교체)에 HTML을 삽입한다. AI 썸네일/버튼 삽입 등에서 사용. */
  insertHtml: (html: string) => void;
  /** 현재 선택된 일반 텍스트를 반환한다(비어 있으면 빈 문자열). AI 문장 확장 등에서 사용. */
  getSelectedText: () => string;
  /** 현재 선택 영역을 새 텍스트로 교체한다. */
  replaceSelection: (text: string) => void;
  /** 에디터 전체의 순수 텍스트(HTML 태그 제외)를 반환한다. */
  getPlainText: () => string;
}

interface Props {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

/**
 * 워드프레스 블록 에디터에 준하는 위지윅 경험을 제공하는 리치 텍스트
 * 에디터. Blogger Data API는 결국 HTML 문자열을 받으므로, 이 컴포넌트는
 * "화면에서는 위지윅으로 편집하되 내부적으로는 HTML을 유지"하는 방식으로
 * 동작한다(Tiptap이 표준적으로 쓰는 패턴).
 *
 * 외부에서 복사한 콘텐츠(워드/한글/네이버블로그/구글독스)를 붙여넣으면
 * editorProps.transformPastedHTML 훅이 자동으로 감지해 정제한다
 * (src/lib/paste-sanitizer.ts 참고).
 */
const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { content, onChange, placeholder },
  ref,
) {
  const [pasteNotice, setPasteNotice] = useState<PasteSource | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      ImageExtension,
      Placeholder.configure({
        placeholder: placeholder || '본문을 입력하거나, 다른 곳에서 복사한 글을 붙여넣어 보세요.',
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      transformPastedHTML(html) {
        const source = detectPasteSource(html);
        if (source !== 'plain') {
          setPasteNotice(source);
          setTimeout(() => setPasteNotice(null), 4000);
        }
        return sanitizePastedHtml(html);
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor]);

  useImperativeHandle(ref, () => ({
    insertHtml: (html: string) => {
      editor?.chain().focus().insertContent(html).run();
    },
    getSelectedText: () => {
      if (!editor) return '';
      const { from, to } = editor.state.selection;
      return editor.state.doc.textBetween(from, to, ' ');
    },
    replaceSelection: (text: string) => {
      editor?.chain().focus().insertContent(text).run();
    },
    getPlainText: () => editor?.getText() || '',
  }), [editor]);

  if (!editor) {
    return <div className="rte-skeleton" aria-hidden="true" />;
  }

  return (
    <div className="rte-wrapper">
      <Toolbar editor={editor} />

      {pasteNotice && (
        <p className="rte-paste-notice">
          {SOURCE_LABELS[pasteNotice]}에서 복사한 내용을 자동으로 정리했습니다.
        </p>
      )}

      <EditorContent editor={editor} className="rte-content" />

      <style>{`
        .rte-skeleton {
          height: 400px;
          border-radius: var(--bp-radius-md, 10px);
          background: linear-gradient(90deg, #f2f2ef 25%, #eae9e4 37%, #f2f2ef 63%);
          background-size: 400% 100%;
          animation: shimmer 1.4s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        .rte-wrapper {
          border: 1px solid var(--bp-border, #E4E3DD);
          border-radius: var(--bp-radius-sm, 6px);
          overflow: hidden;
        }
        .rte-paste-notice {
          margin: 0;
          padding: 8px 14px;
          font-size: 12px;
          background: rgba(78,140,242,0.1);
          color: #2A5AA8;
        }
        .rte-content {
          padding: 16px;
          min-height: 320px;
          max-height: 640px;
          overflow-y: auto;
          font-size: 15px;
          line-height: 1.7;
          color: var(--bp-text, #1B1D23);
        }
        .rte-content .ProseMirror { outline: none; min-height: 300px; }
        .rte-content .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          color: var(--bp-text-mute, #6B6E7A);
          float: left;
          height: 0;
          pointer-events: none;
        }
        .rte-content .ProseMirror h2 { font-size: 22px; font-weight: 700; margin: 20px 0 8px; }
        .rte-content .ProseMirror h3 { font-size: 18px; font-weight: 700; margin: 16px 0 6px; }
        .rte-content .ProseMirror h4 { font-size: 16px; font-weight: 700; margin: 14px 0 6px; }
        .rte-content .ProseMirror p { margin: 0 0 12px; }
        .rte-content .ProseMirror ul, .rte-content .ProseMirror ol { padding-left: 24px; margin: 0 0 12px; }
        .rte-content .ProseMirror blockquote {
          border-left: 3px solid var(--bp-border, #E4E3DD);
          padding-left: 14px;
          color: var(--bp-text-mute, #6B6E7A);
          margin: 0 0 12px;
        }
        .rte-content .ProseMirror img { max-width: 100%; border-radius: 6px; }
        .rte-content .ProseMirror a { color: var(--bp-info, #4E8CF2); }
        .rte-content .ProseMirror table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
        .rte-content .ProseMirror td, .rte-content .ProseMirror th {
          border: 1px solid var(--bp-border, #E4E3DD); padding: 6px 10px;
        }
        .rte-content .ProseMirror hr { border: none; border-top: 1px solid var(--bp-border, #E4E3DD); margin: 20px 0; }
      `}</style>
    </div>
  );
});

export default RichTextEditor;

const SOURCE_LABELS: Record<PasteSource, string> = {
  word: 'MS Word',
  hwp: '한글(HWP)',
  'naver-blog': '네이버 블로그',
  'google-docs': '구글 문서',
  'unknown-rich': '외부 편집기',
  plain: '',
};

function Toolbar({ editor }: { editor: Editor }) {
  const [, forceRerender] = useState(0);

  useEffect(() => {
    const rerender = () => forceRerender((n) => n + 1);
    editor.on('selectionUpdate', rerender);
    editor.on('transaction', rerender);
    return () => {
      editor.off('selectionUpdate', rerender);
      editor.off('transaction', rerender);
    };
  }, [editor]);

  function setLink() {
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('링크 URL을 입력하세요', previousUrl || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  const buttons: { label: string; title: string; active?: boolean; onClick: () => void }[] = [
    { label: 'H2', title: '제목 2', active: editor.isActive('heading', { level: 2 }), onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'H3', title: '제목 3', active: editor.isActive('heading', { level: 3 }), onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: 'B', title: '굵게', active: editor.isActive('bold'), onClick: () => editor.chain().focus().toggleBold().run() },
    { label: 'I', title: '기울임', active: editor.isActive('italic'), onClick: () => editor.chain().focus().toggleItalic().run() },
    { label: 'U', title: '밑줄', active: editor.isActive('underline'), onClick: () => editor.chain().focus().toggleUnderline().run() },
    { label: 'S', title: '취소선', active: editor.isActive('strike'), onClick: () => editor.chain().focus().toggleStrike().run() },
    { label: '•', title: '글머리 목록', active: editor.isActive('bulletList'), onClick: () => editor.chain().focus().toggleBulletList().run() },
    { label: '1.', title: '번호 목록', active: editor.isActive('orderedList'), onClick: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '"', title: '인용구', active: editor.isActive('blockquote'), onClick: () => editor.chain().focus().toggleBlockquote().run() },
    { label: '링크', title: '링크', active: editor.isActive('link'), onClick: setLink },
    { label: '—', title: '구분선', onClick: () => editor.chain().focus().setHorizontalRule().run() },
    { label: '↺', title: '실행취소', onClick: () => editor.chain().focus().undo().run() },
    { label: '↻', title: '다시실행', onClick: () => editor.chain().focus().redo().run() },
  ];

  return (
    <div className="rte-toolbar">
      {buttons.map((btn) => (
        <button
          key={btn.title}
          type="button"
          title={btn.title}
          className={`rte-btn ${btn.active ? 'is-active' : ''}`}
          onClick={btn.onClick}
        >
          {btn.label}
        </button>
      ))}

      <style>{`
        .rte-toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 2px;
          padding: 6px;
          background: var(--bp-canvas, #F7F7F5);
          border-bottom: 1px solid var(--bp-border, #E4E3DD);
        }
        .rte-btn {
          min-width: 30px;
          height: 30px;
          padding: 0 8px;
          font-size: 13px;
          font-weight: 600;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 4px;
          color: var(--bp-text, #1B1D23);
        }
        .rte-btn:hover { background: var(--bp-surface, #fff); border-color: var(--bp-border, #E4E3DD); }
        .rte-btn.is-active { background: var(--bp-accent, #F2C14E); color: var(--bp-accent-ink, #3A2C00); }
      `}</style>
    </div>
  );
}
