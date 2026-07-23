/**
 * 붙여넣기 콘텐츠 자동 정제(paste sanitizer)
 * ─────────────────────────────────────────────────────────────────────
 * 사용자가 MS Word, 한글(HWP → 웹 복사), 네이버 블로그, 구글 문서 등
 * 외부에서 글을 복사해 에디터에 붙여넣으면, 그 HTML에는 편집기 자체
 * 동작에는 필요 없는 잡다한 마크업이 대량으로 딸려온다:
 *   - MS Office: <o:p>, mso-* 인라인 스타일, 조건부 주석(<!--[if ...]-->)
 *   - 네이버 블로그: se-* 클래스가 붙은 겹겹의 <div>/<span>, 고정 px 폰트 크기
 *   - 구글 문서: <span style="font-weight:400"> 같은 불필요한 래핑
 * 이 모듈은 그런 소스를 감지하고, Tiptap의 paste 파이프라인에 넘기기
 * 전에 순수한 시맨틱 HTML(문단/제목/목록/굵게/링크/이미지)만 남도록
 * 정제한다.
 *
 * 감지는 Tiptap의 editorProps.transformPastedHTML에서 이루어지며,
 * 이 함수가 반환한 HTML 문자열이 실제로 에디터에 삽입된다.
 */

/** 출처를 추정한다 — UI에 "OO에서 복사한 내용을 정리했습니다" 안내를 보여주기 위함 */
export type PasteSource = 'word' | 'hwp' | 'naver-blog' | 'google-docs' | 'unknown-rich' | 'plain';

export function detectPasteSource(html: string): PasteSource {
  if (/<meta[^>]+Generator[^>]+Microsoft Word/i.test(html) || /mso-/i.test(html) || /<o:p\b/i.test(html)) {
    return 'word';
  }
  if (/class=["'][^"']*(hwp|hwpEditor)/i.test(html)) {
    return 'hwp';
  }
  if (/class=["'][^"']*se-(main-container|module|text)/i.test(html)) {
    return 'naver-blog';
  }
  if (/id=["']docs-internal-guid/i.test(html) || /class=["'][^"']*google-docs/i.test(html)) {
    return 'google-docs';
  }
  // 복잡한 인라인 스타일이 과도하게 많으면(외부 리치 에디터 특유의 패턴) 출처 불명 리치 텍스트로 취급
  const styleAttrCount = (html.match(/style="/gi) || []).length;
  if (styleAttrCount > 5) return 'unknown-rich';
  return 'plain';
}

const BLOCK_TAGS_TO_PARAGRAPH = new Set(['div', 'section', 'article']);

// div/section 등을 평탄화할 때, 이미 블록 레벨 자식(p, h1-h4, ul 등)이
// 있으면 <p>로 다시 감싸지 않고 그 자식들을 그대로 승격시킨다. 그렇지
// 않으면(순수 인라인 콘텐츠만 있으면) <p>로 감싼다. 이 판별이 없으면
// <div><p>...</p></div> 같은 흔한 구조가 <p><p>...</p></p>로 중첩되어
// 유효하지 않은 HTML이 만들어진다.
const BLOCK_LEVEL_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'table', 'hr', 'pre',
  'div', 'section', 'article',
]);

function hasBlockLevelChild(el: Element): boolean {
  return Array.from(el.children).some((child) => BLOCK_LEVEL_TAGS.has(child.tagName.toLowerCase()));
}

/**
 * HTML 문자열을 정제한다. DOMParser를 사용해 실제 DOM 트리로 파싱한 뒤
 * 화이트리스트 기반으로 태그/속성을 걸러내고 다시 직렬화한다.
 */
export function sanitizePastedHtml(html: string): string {
  // 출처 판별(detectPasteSource)은 UI 안내 문구("OO에서 복사한 내용을
  // 정리했습니다")를 보여줄 때만 참고용으로 쓰고, 정제 자체는 출처와
  // 무관하게 항상 수행한다. 정제 로직은 이미 안전하게 설계되어 있어
  // (허용 태그만 남기고 위험 요소를 제거하되 텍스트/구조는 보존) 이미
  // 깨끗한 HTML을 넣어도 내용이 손상되지 않으므로, 굳이 "출처가
  // plain처럼 보인다"는 휴리스틱 판단에 따라 정제를 건너뛰면 오히려
  // div 중첩처럼 스타일 속성이 적은 지저분한 마크업을 놓칠 위험이 있다.
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return html;

  stripComments(root);
  cleanNode(root, doc);

  return root.innerHTML.trim();
}

function stripComments(node: Node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT);
  const toRemove: Node[] = [];
  let current = walker.nextNode();
  while (current) {
    toRemove.push(current);
    current = walker.nextNode();
  }
  toRemove.forEach((c) => c.parentNode?.removeChild(c));
}

// 내용째로 완전히 삭제해야 하는 태그(unwrap하면 코드/스타일이 텍스트로 노출됨)
const DANGEROUS_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript']);

// 허용 태그(Blogger 본문 컨텍스트 + 에디터 툴바가 다루는 범위와 일치시킴)
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'img',
  'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'code', 'pre', 'span',
]);

// 태그별 허용 속성(그 외 속성/모든 style·class는 제거)
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt'],
};

/**
 * node의 모든 자손을 화이트리스트 규칙에 따라 정제한다.
 *
 * 설계: "부모가 자식 목록을 순회하며, 각 자식 노드 자체가 규칙에
 * 맞는지 판정하고 필요하면 교체한 뒤, 그 결과물의 자식들에 대해
 * 동일한 처리를 재귀 적용"하는 구조다. unwrap(태그 제거)으로 새로
 * 승격된 노드도 "새로 나타난 자식"과 동일하게 취급해 처리 큐에 다시
 * 넣어야 하므로, 단순 배열 순회가 아니라 큐(대기열) 방식을 쓴다.
 */
function cleanNode(node: Element, doc: Document) {
  // 처리 대기열: 아직 "자기 자신이 적합한 태그인지" 판정받지 않은 자식들.
  const queue: Node[] = Array.from(node.childNodes);

  while (queue.length > 0) {
    const child = queue.shift()!;

    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.parentNode?.removeChild(child);
      continue;
    }

    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    // script/style/기타 실행 가능한 태그는 내용째로 완전히 삭제한다.
    // (unwrap은 "태그만 벗기고 내용은 보존"하는 동작이라 스크립트 코드가
    // 그대로 텍스트로 노출되어 버린다 — 반드시 통째로 제거해야 한다.)
    if (DANGEROUS_TAGS.has(tag)) {
      el.remove();
      continue;
    }

    // MS Office 전용 태그(o:p, w:*, v:* 네임스페이스 등)는 내용만 남기고 태그 제거
    if (tag.includes(':') || tag === 'o:p') {
      const promoted = unwrapElement(el, doc);
      queue.unshift(...promoted); // 승격된 노드들도 다시 판정 대상에 포함
      continue;
    }

    if (BLOCK_TAGS_TO_PARAGRAPH.has(tag)) {
      if (hasBlockLevelChild(el)) {
        // 이미 문단/제목/목록 등 블록 요소를 담고 있으므로 div 껍데기만
        // 벗겨내고 내부 블록 요소들을 다시 판정 대상에 넣는다.
        const promoted = unwrapElement(el, doc);
        queue.unshift(...promoted);
      } else {
        // 순수 인라인 콘텐츠(텍스트, span 등)만 있으면 하나의 <p>로 승격.
        const p = doc.createElement('p');
        while (el.firstChild) p.appendChild(el.firstChild);
        el.replaceWith(p);
        cleanNode(p, doc); // p의 자식들(인라인 요소)은 이 시점에 바로 정제
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // 허용되지 않은 태그(span의 대부분, font, mso 관련 wrapper 등)는
      // 내용만 남기고 태그 자체는 제거한다.
      const promoted = unwrapElement(el, doc);
      queue.unshift(...promoted);
      continue;
    }

    // span은 굵게/기울임 표현이 인라인 style로만 되어 있는 경우가 많아
    // (예: <span style="font-weight:bold">) 의미 있는 스타일만 태그로 승격하고
    // span 자체는 제거한다.
    if (tag === 'span') {
      promoteInlineStyleToSemanticTag(el, doc);
      continue;
    }

    // 여기 도달했다면 el 자신은 허용 태그로 확정됐다. 속성을 화이트리스트만
    // 남기고, el의 자식들은 별도로(재귀) 정제한다.
    const allowedAttrs = ALLOWED_ATTRS[tag] || [];
    for (const attr of Array.from(el.attributes)) {
      if (!allowedAttrs.includes(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
    if (tag === 'a' && el.getAttribute('target') === '_blank') {
      el.setAttribute('rel', 'noopener noreferrer');
    }

    cleanNode(el, doc);
  }
}

function unwrapElement(el: Element, doc: Document): Node[] {
  const promoted: Node[] = Array.from(el.childNodes);
  const fragment = doc.createDocumentFragment();
  while (el.firstChild) fragment.appendChild(el.firstChild);
  el.replaceWith(fragment);
  return promoted;
}

/**
 * <span style="font-weight:bold">텍스트</span> 같은 구조를
 * <strong>텍스트</strong>로 승격시키고 span 자체는 제거한다.
 * Word/구글독스가 굵게·기울임·밑줄을 태그가 아니라 인라인 스타일로
 * 표현하는 경우가 많아 이 변환이 없으면 서식이 전부 사라진다.
 */
function promoteInlineStyleToSemanticTag(span: Element, doc: Document) {
  const style = span.getAttribute('style') || '';
  const isBold = /font-weight:\s*(bold|[6-9]00)/i.test(style);
  const isItalic = /font-style:\s*italic/i.test(style);
  const isUnderline = /text-decoration:[^;]*underline/i.test(style);

  // span의 자식들을 먼저 재귀적으로 정제한다(내부에 또 다른 span/div가
  // 있을 수 있으므로).
  const contentHost = doc.createElement('div');
  while (span.firstChild) contentHost.appendChild(span.firstChild);
  cleanNode(contentHost, doc);

  // 정제된 내용을 굵게 > 기울임 > 밑줄 순서로 필요한 만큼만 감싼다.
  // 각 단계는 "지금까지 만든 내용물을 새 wrapper 하나로 감싼다"는
  // 동일한 패턴이라 분기 없이 순차 처리할 수 있다.
  let innerNodes: Node[] = Array.from(contentHost.childNodes);

  function wrapAll(tagName: string, nodes: Node[]): Node[] {
    const wrapper = doc.createElement(tagName);
    nodes.forEach((n) => wrapper.appendChild(n));
    return [wrapper];
  }

  if (isUnderline) innerNodes = wrapAll('u', innerNodes);
  if (isItalic) innerNodes = wrapAll('em', innerNodes);
  if (isBold) innerNodes = wrapAll('strong', innerNodes);

  const fragment = doc.createDocumentFragment();
  innerNodes.forEach((n) => fragment.appendChild(n));
  span.replaceWith(fragment);
}
