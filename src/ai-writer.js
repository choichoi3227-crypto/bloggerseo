/**
 * AI 블로그 글쓰기 엔진
 * ─────────────────────────────────────────────────────────────────────
 * aibp-pro(워드프레스 플러그인)의 AI 콘텐츠 생성 로직을 Cloudflare
 * Workers 환경으로 이식한 모듈. Gemini API(Google Generative Language)를
 * 호출해 SEO 최적화된 블로그 글 초안을 생성한다.
 *
 * 원본 플러그인과의 차이:
 *   - API 키 로테이션(get_next_api_key)은 워드프레스 옵션/transient
 *     기반이었으나, 여기서는 KV(store.js)로 재구현했다.
 *   - "AI 스키마 마크업 생성" 기능은 이식하지 않았다 — bloggerseo에는
 *     이미 src/schema.js가 Article/FAQ/Breadcrumb/Product 스키마를
 *     Workers AI 기반으로 자동 생성하고 있어 완전히 중복된다.
 *   - "SEO 메타 태그 자동 삽입" 기능도 이식하지 않았다 — src/schema.js,
 *     src/seo-features.js가 이미 동일하고 더 폭넓은 기능(hreflang,
 *     breadcrumb, OG, Twitter Card 등)을 제공한다.
 *   - AI 썸네일 생성은 이 파일이 아니라 src/ai-thumbnail.js에서
 *     Cloudflare Workers AI(env.AI, SDXL)로 재구현했다(원본은 외부
 *     Cloudflare Worker + Pollinations를 썼으나, 이 프로젝트 자체가
 *     이미 Workers이므로 env.AI를 직접 쓰는 편이 지연시간과 운영
 *     복잡도 양쪽에서 더 낫다).
 *
 * API 키: GEMINI_API_KEY를 wrangler secret으로 등록해야 한다.
 *   wrangler secret put GEMINI_API_KEY
 * 여러 키를 쉼표로 구분해 등록하면 라운드로빈 + 레이트리밋(429/503)
 * 자동 우회를 지원한다(원본 플러그인의 다중 키 전략과 동일).
 */

import { kvGetJson, kvSetJson } from './store.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class AiWriterError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// ── API 키 로테이션 ────────────────────────────────────────────────────
function parseApiKeys(env) {
  const raw = (env.GEMINI_API_KEY || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const KEY_INDEX_KV_PREFIX = 'aiwriter:keyidx:';

async function getNextApiKey(env, keys, excluded) {
  const available = keys.filter((k) => !excluded.includes(k));
  if (available.length === 0) return null;

  // 라운드로빈 인덱스를 KV에 저장(원본 플러그인의 transient와 동일한 역할).
  // 키 목록 자체를 해시해 인덱스 키를 만들어, 키 목록이 바뀌면 자동으로
  // 새 로테이션이 시작되게 한다.
  const idxKey = KEY_INDEX_KV_PREFIX + (await simpleHash(keys.join(',')));
  const stored = await kvGetJson(env, idxKey);
  const idx = (typeof stored === 'number' ? stored : 0) % available.length;
  await kvSetJson(env, idxKey, (idx + 1) % available.length, 3600);
  return available[idx];
}

async function simpleHash(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Gemini API 호출 (재시도 + 키 로테이션 + 지수 백오프) ────────────────
export async function callGeminiApi(env, body, { timeoutMs = 130_000, model = GEMINI_MODEL } = {}) {
  const keys = parseApiKeys(env);
  if (keys.length === 0) {
    throw new AiWriterError('Gemini API 키가 설정되지 않았습니다. wrangler secret put GEMINI_API_KEY 로 등록하세요.', 500);
  }

  const excluded = [];
  const maxTry = Math.min(keys.length * 2, 6);

  for (let attempt = 0; attempt < maxTry; attempt++) {
    let apiKey = await getNextApiKey(env, keys, excluded);
    if (!apiKey) {
      // 모든 키가 일시 제한 → 잠시 대기 후 초기화
      await sleep(3000);
      excluded.length = 0;
      apiKey = keys[0];
    }

    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      if (attempt < maxTry - 1) { await sleep(1500); continue; }
      throw new AiWriterError(`API 요청 실패: ${err.message}`, 502);
    }

    if (res.status === 200) {
      return res.json();
    }

    if (res.status === 429 || res.status === 503) {
      excluded.push(apiKey);
      const wait = Math.min(2 ** attempt, 16) * 1000;
      await sleep(wait);
      continue;
    }

    const data = await res.json().catch(() => null);
    const message = data?.error?.message || `HTTP ${res.status}`;
    throw new AiWriterError(`Gemini API 오류: ${message}`, 502);
  }

  throw new AiWriterError('API 요청이 여러 번 실패했습니다. 잠시 후 다시 시도해주세요.', 502);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) throw new AiWriterError('API 응답에 텍스트가 없습니다.', 502);
  const texts = parts.map((p) => p.text).filter(Boolean);
  if (texts.length === 0) throw new AiWriterError('API 응답에 텍스트가 없습니다.', 502);
  return texts.join('\n\n');
}

// ── 후처리: 마크다운/H4 정리 ────────────────────────────────────────────
function cleanupHtml(raw) {
  let text = raw;
  text = text.replace(/```[\s\S]*?```/gi, '');
  text = text.replace(/\*\*(.+?)\*\*/gsu, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/gsu, '$1');
  text = text.replace(/\*/g, '');
  // H4 완전 제거: h4 → h3로 상향 변환 (콘텐츠 손실 없이)
  text = text.replace(/<h4([^>]*)>/gi, '<h3$1>');
  text = text.replace(/<\/h4>/gi, '</h3>');
  return text;
}

function stripSeoComments(html) {
  let text = html.replace(/<!--\s*(TITLE|META_DESC|SLUG|FOCUS_KEYWORD):[\s\S]*?-->\s*/gi, '');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractMetaInfo(content) {
  const info = { metaDesc: '', slug: '', focusKeyword: '' };
  const descMatch = content.match(/<!--\s*META_DESC:\s*(.+?)\s*-->/);
  if (descMatch) info.metaDesc = descMatch[1].trim();
  const slugMatch = content.match(/<!--\s*SLUG:\s*(.+?)\s*-->/);
  if (slugMatch) info.slug = slugMatch[1].trim();
  const kwMatch = content.match(/<!--\s*FOCUS_KEYWORD:\s*(.+?)\s*-->/);
  if (kwMatch) info.focusKeyword = kwMatch[1].trim();
  return info;
}

function ensureFirstParagraph(html, metaDesc, topic) {
  const trimmed = html.trim();
  if (!trimmed) return trimmed;
  const firstTagMatch = trimmed.match(/^\s*<(\w+)[^>]*>/i);
  if (!firstTagMatch) return trimmed;
  const tag = firstTagMatch[1].toLowerCase();
  if (tag === 'p') return trimmed;
  if (['h1', 'h2', 'h3', 'h5', 'h6'].includes(tag)) {
    const year = new Date().getFullYear();
    const p = metaDesc
      ? `<p>${escapeHtml(metaDesc)}</p>`
      : topic
        ? `<p>${escapeHtml(`${year}년 ${topic}에 대한 핵심 정보를 완벽하게 정리했습니다.`)}</p>`
        : '<p>이 글에서 핵심 정보를 안내합니다.</p>';
    return `${p}\n${trimmed}`;
  }
  return trimmed;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 허용 태그(참고용 — 실제 sanitize는 응답을 그대로 신뢰하지 않고
//    posts.astro/PostEditor가 최종 저장 전에 사람이 검수하는 것을
//    전제로 한다. 완전 자동 발행 파이프라인에 연결할 경우 이 목록
//    기준의 화이트리스트 sanitizer를 추가해야 한다.) ──────────────────
export const ALLOWED_TAGS_TABLE = [
  'h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'br',
  'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'span',
];
export const ALLOWED_TAGS_NO_TABLE = ALLOWED_TAGS_TABLE.filter((t) => !['table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(t));

// ── 프롬프트 빌더 (원본 플러그인의 4개 글 유형별 가이드 완전 이식) ──────
const POST_TYPES = ['informational', 'utility', 'policy_guide', 'review_comparison'];

const INTROS = [
  '도입부A: 독자가 지금 막 겪는 구체적 상황을 2문장으로 묘사하고 즉시 핵심 정보로 전환',
  '도입부B: 가장 흔한 실수 2가지를 먼저 짚고 올바른 방법으로 자연 전환',
  '도입부C: 핵심 수치(금액/기간/비율)를 첫 문장에 배치 — 역피라미드 결론 먼저',
  '도입부D: 이 글에서 다룰 3가지 핵심 포인트를 첫 단락에 명시하는 약속형',
  '도입부E: 실무 경험자 관점의 1인칭 사례 소개 → E-E-A-T 신뢰 즉시 구축',
  '도입부F: 독자가 검색창에 치는 질문 그 자체로 시작 → 즉시 답변 제공',
  '도입부G: 최신 변화·정책 변경 강조 → 신선도 어필로 클릭 유지',
  '도입부H: 비용 절감·시간 단축·리스크 회피 3가지 실익을 수치와 함께 배치',
  '도입부I: 흔한 오해를 먼저 지적하고 실제와 대비하는 교정 구조',
  '도입부J: 자가진단 체크리스트 3항목으로 시작 → 해당되면 이 글이 필요하다는 흐름',
  '도입부K: 최근 통계·연구 수치로 시작 → 신뢰도와 검색 의도 동시 공략',
  '도입부L: 성공 사례(구체적 숫자)와 실패 사례를 대조하는 스토리텔링',
  '도입부M: 비교 대상 2~3가지를 첫 문단에 나열 → 선택 의도 직격',
  '도입부N: 독자가 얻는 구체적 이득을 약속 형식으로 명시',
  '도입부O: 시간순 흐름 (예전에는~, 지금은~) → 변화 맥락으로 필요성 설득',
  '도입부P: 한 줄 요약(TL;DR) 먼저 제시 후 심화 전개',
  '도입부Q: 독자가 실제로 궁금해하는 생활 밀착형 질문으로 시작',
  '도입부R: 주변 사람 사례를 들어 공감 확보 후 해결책 제시',
  '도입부S: 관련 제도·정책의 핵심 변경 사항을 첫 줄에 배치',
  '도입부T: 이 주제를 모르면 손해 보는 이유를 3줄로 압축해 위기감 조성',
];

const H2_STYLES = [
  '소제목 형식: 질문형 ("왜 ~인가?", "어떻게 ~하나?", "~이 중요한 이유?")',
  '소제목 형식: 숫자 포함형 ("3가지 핵심", "5단계 가이드", "7가지 주의사항")',
  '소제목 형식: 결과 중심형 ("~하면 달라지는 것", "~의 실제 효과", "~로 해결")',
  '소제목 형식: 직접 키워드형 ("~의 모든 것", "~를 위한 핵심", "~완벽 정리")',
];

const TONE_STYLES = [
  '문장: 단문 위주(20~35자), 명확 빠른 호흡, 정보 전달 최우선',
  '문장: 중문 위주(35~60자), 이유·근거를 같은 문장에 포함',
  '문장: 단문·중문 교차, 강조는 단문·설명은 중문, 리듬감',
  '문장: 구어체 혼합(~입니다/~합니다+~이에요/~거든요), 친근·신뢰감',
];

const TYPE_GUIDES = {
  informational: `
【정보성 — SEO Content Specialist 기준 + 애드센스 수익화 최적화】
━━ 제목 전략 ━━
- 연관 키워드 최소 30개를 본문 전체에 자연 분산 배치
- '|' 절대 금지 / 연도 삽입 절대 금지

━━ 메타 디스크립션 ━━
- 공백 포함 120~160자, 메인+서브 키워드 필수 포함
- "~에 대해 알아봅니다" 금지 → 문제 해결 약속형

━━ 본문 구조 (H2/H3만 — H4 완전 금지) ━━
[본론 H2] FAQ 제외 반드시 3개 이상 (FAQ 포함 총 H2 최소 4개)
- 각 H2 직후: 섹션 요약 <p> 1개 (1~2문장)
- 각 H2 내부에 H3 반드시 2~3개
- H3 직후: <p> 1~3문장 → <ul> (li 최소 3개)

━━ strong / <u> ━━
- <strong>: 핵심 수치·키워드·결론에 섹션당 2~4개 (단어·구문 단위)
- <u>: 중요 용어·핵심 개념에 섹션당 1~2개

━━ 표(table) — 정보성 글에서 절대 사용 금지 ━━
비교·요약은 반드시 <ul>/<ol>로만.

━━ 애드센스 수익화 ━━
- 고단가 키워드(금융·보험·건강·법률·부동산) 자연 배치 — 본문 3~5회
- 각 H2가 단일 주제에 집중 → 문맥 매칭 정확도 상승`,

  utility: `
【유틸리티 — 표 2개 필수 + 애드센스 최적화】
독자가 이 글 한 편으로 다운로드·설치·발급·신청을 완전히 끝낼 수 있어야 합니다.

━━ 표 2개 필수 (도입부 직후, 본론 H2 전 배치) ━━
[표1 기본 정보] 카테고리·운영체제·개발사·공식사이트·버전·비용·라이선스
[표2 사양·조건] CPU·메모리·저장공간 또는 자격조건·필요서류·신청기간·비용
(두 표 모두 thead+tbody 구조 / <th> 필수)

━━ 본문 구조 (H2/H3만 — H4 완전 금지) ━━
[본론 H2] FAQ 제외 3개 이상 / 각 H2 내부 H3 2~3개
- H3 직후: <p> 1~3문장 → <ul> 또는 <ol> (li 최소 3개)
- 설치·신청 단계는 <ol> 사용

━━ 쉬운 설명 필수 ━━
전문 용어 사용 즉시 괄호로 쉬운 말 병기.`,

  policy_guide: `
【정책·공공 — 표 선택사항(최대 2개) + 애드센스 최적화】
정확한 공공 정보를 신뢰도 높게 전달합니다.

━━ 표 (선택사항, 최대 2개) ━━
대상/조건/금액/기간 정보가 표가 더 명확할 때만 사용 (thead+tbody, <th> 필수)

━━ 본문 구조 (H2/H3만 — H4 완전 금지) ━━
[본론 H2] FAQ 제외 3개 이상 / 각 H2 내부 H3 2~3개
- H3 직후: <p> 1~3문장 (핵심 정보·수치) → <ul> 또는 <ol>

━━ strong / <u> ━━
- <strong>: 지원 금액·신청 기간·자격 조건 수치에 섹션당 2~4개
- <u>: 중요 정책 용어·기관명에 섹션당 1~2개

━━ 정확성 ━━
허위·과장 표현 금지 / 검증 가능한 수치만.`,

  review_comparison: `
【리뷰·비교 — 구매 전환 극대화 + 애드센스 문맥 매칭】
━━ 제목 전략 ━━
- 비교 대상 + 선정 기준 구조 (연도 삽입 절대 금지, '|' 절대 금지)
- '추천', '비교', '순위', '후기', '가성비' 키워드 포함

━━ 본문 구조 (H2/H3만 — H4 완전 금지) ━━
[본론 H2] FAQ 제외 3개 이상 / 각 H2 내부 H3 2~3개
- H3 직후: <p> 1~3문장 (제품 설명·특징·수치) → <ul> (장점·단점·특징)

⚠️ 리뷰에서 표(table) 절대 금지 — 모든 비교는 <ul>/<ol>로만

━━ strong / <u> ━━
- <strong>: 가격·평점·핵심 기능 수치·최종 추천 제품명에 섹션당 2~4개
- <u>: 제품명·브랜드명에 섹션당 1~2개

━━ 애드센스 문맥 매칭 ━━
- 각 H2가 단일 제품 카테고리에 집중 → 쇼핑 광고 매칭 정확도 상승
- 제품 스펙은 일상 언어로 풀어 설명 (예: '램 16GB = 여러 앱 동시 실행 가능')`,
};

const FAQ_RULE = `
━━ FAQ 섹션 필수 (반드시 4~6개 — 전 유형 공통) ━━
본문 마지막 본론 H2 직후에 반드시 포함.
독자가 실제로 검색하는 질문 형태로 작성.

⚠️ FAQ H2 태그 필수: <h2> 사용 (h3·h4 사용 금지)
⚠️ 각 질문은 반드시 <h3> 사용 — 4개 이상 6개 이하

구조 (반드시 이 태그 그대로 사용):
<h2>자주 묻는 질문</h2>
<h3>질문 내용? (실제 검색어 형태)</h3>
<p>2~4문장 답변. 수치·기간·조건 포함.</p>
(4~6개 반복)
⚠️ FAQ 답변 <p>에 <ul> 사용 금지 — 답변은 반드시 <p>만`;

/**
 * 유사문서(중복 콘텐츠) 방지를 위한 시드 기반 다양화 요소를 뽑는다.
 * 원본 플러그인의 "매 생성마다 완전히 다른 구조" 전략을 그대로 재현.
 */
function pickDiversitySeed(topic) {
  const ts = Date.now();
  const th = crc32(topic);
  const micro = Math.floor(performance.now() * 1000) % 997;
  const randExt = Math.floor(Math.random() * 10000);
  const seedIdx = Math.abs(ts + th + micro + randExt) % INTROS.length;

  return {
    uniqueId: `${ts}-${th}-${micro}-${randExt}`,
    intro: INTROS[seedIdx],
    h2Style: H2_STYLES[Math.abs(th + micro) % H2_STYLES.length],
    toneStyle: TONE_STYLES[Math.abs(th * 3 + micro) % TONE_STYLES.length],
  };
}

function crc32(str) {
  // 간단한 CRC32 근사(다양화 시드용이므로 정확한 표준 구현일 필요는 없다).
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h >>> 0;
}

function buildPrompt(topic, type) {
  const now = new Date();
  const currentDate = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;

  const seed = pickDiversitySeed(topic);
  const guide = TYPE_GUIDES[type] || TYPE_GUIDES.informational;

  return `당신은 SEO Content Specialist입니다. 검색엔진 최적화 + 애드센스 광고 문맥 매칭 + 유사문서·템플릿 0%에 특화된 한국어 블로그 전문 작가입니다. 목표는 검색엔진을 위한 기계적인 글이 아닌, '사용자의 문제를 해결해 주는 글'을 작성하는 것입니다.

오늘 날짜: ${currentDate} / 주제: '${topic}' / 글 유형: ${type}

⚡ 최신 정보 우선: Google Search 결과를 바탕으로 최신 수치·정책·가격을 반영하세요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 절대 준수 — 위반 즉시 재작성
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 한자 0개 / 별표(*) 0개 / 마크다운 문법 0개
- 공백 제외 반드시 700자 이상
- 제목(TITLE)에 '|' 문자 절대 금지
- 본문 내 <h1>, <h4>, <title> 태그 절대 사용 금지
- 이미지 URL: 확인 불가한 URL 금지 — img 태그 생략하고 HTML 주석으로만 표기
- 템플릿식 글쓰기 절대 금지 (매 생성마다 완전히 다른 구조·표현·흐름)

━━ [규칙 1] H2 개수 ━━
- FAQ H2 포함 총 H2 반드시 4개 이상 / 본론 H2 FAQ 제외 3개 이상

━━ [규칙 2] H3 배치 ━━
- 모든 본론 H2에 H3 반드시 2~3개 / FAQ 각 질문도 H3 사용

━━ [규칙 3] H3 직후 구조 ━━
[H3 직후] 반드시 이 순서: ① <p> 1~3문장 → ② <ul>/<ol> (li 최소 3개)
[H2 직후] <p> 1개 (1~2문장 섹션 요약)

━━ [규칙 4] strong 태그 & 밑줄(<u>) ━━
- <strong>: 섹션당 2~4개 (단어·구문 단위만) / <u>: 섹션당 1~2개
- 남용 금지 (전체 텍스트의 10~15% 이내)

━━ [규칙 5] 비자연스러운 어구 완전 금지 ━━
- 반말 절대 금지 (전체 존댓말)
- 인공적 마무리: 이상으로~, 지금까지~, 살펴보았습니다 등 금지
- 구조 안내: 본문에서는~, 다음 섹션에서는~ 등 금지

━━ 기타 공통 규칙 ━━
- HTML 태그만 출력 (마크다운 코드블록 금지)
- itemscope·itemtype·itemprop·<script> 본문 삽입 금지

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 SEO 메타 정보 (첫 3줄 필수 출력)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
첫 줄  : <!-- META_DESC: [120~160자 — 메인키워드+서브키워드+문제해결약속형] -->
둘째 줄: <!-- SLUG: [핵심키워드 하이픈 연결] -->
셋째 줄: <!-- FOCUS_KEYWORD: [3~5개 쉼표 구분] -->
주석 3줄 직후 첫 요소 = 반드시 <p> 태그
⚠️ TITLE 주석 출력 완전 금지 — 제목은 사용자가 직접 작성함

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 유사문서 완전 차단
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[고유 ID] ${seed.uniqueId} / [도입부] ${seed.intro} / [소제목] ${seed.h2Style} / [문장] ${seed.toneStyle}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 글 유형 전용 가이드 [${type}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${guide}
${FAQ_RULE}

지금 바로 작성하세요! (반드시 700자 이상, H4 금지, FAQ 4~6개 필수, 템플릿 금지, 유사문서 금지)`;
}

// ── 공백 제외 글자수 계산 ────────────────────────────────────────────────
function plainCharCount(html) {
  const stripped = html.replace(/<[^>]+>/g, '');
  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  const noSpace = decoded.replace(/[\s\u00A0\u3000]+/g, '');
  return [...noSpace].length; // 유니코드 안전 카운트
}

// ── 메인 진입점: 블로그 글 생성 ──────────────────────────────────────────
/**
 * @param {object} env - Workers 환경 (GEMINI_API_KEY 시크릿 필요)
 * @param {string} topic - 주제 키워드
 * @param {string} type - 'informational' | 'utility' | 'policy_guide' | 'review_comparison'
 * @returns {Promise<{html: string, metaInfo: {metaDesc, slug, focusKeyword}}>}
 */
export async function generateBlogContent(env, topic, type = 'informational') {
  if (!topic || !topic.trim()) {
    throw new AiWriterError('주제를 입력해주세요.', 400);
  }
  if (!POST_TYPES.includes(type)) type = 'informational';

  const prompt = buildPrompt(topic, type);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, topK: 40, topP: 0.9, maxOutputTokens: 8000 },
    tools: [{ google_search: {} }], // Google Search Grounding: 최신 정보 자동 검색
  };

  const data = await callGeminiApi(env, body, { timeoutMs: 160_000 });
  let text = extractText(data);

  const metaInfoRaw = extractMetaInfo(text);
  text = text.replace(/<!--\s*(TITLE|META_DESC|SLUG|FOCUS_KEYWORD):[\s\S]*?-->\s*/gi, '');
  text = cleanupHtml(text);
  let html = stripSeoComments(text);
  html = ensureFirstParagraph(html, metaInfoRaw.metaDesc, topic);

  // 이어쓰기: 공백 제외 700자 미달 시 최대 2회 추가 생성
  const targetChars = 700;
  let charCount = plainCharCount(html);

  for (let i = 0; i < 2 && charCount < targetChars; i++) {
    const strippedTail = html.replace(/<[^>]+>/g, '');
    const tail = strippedTail.slice(-500);
    const remain = targetChars - charCount;
    const tableNote = ['policy_guide', 'utility'].includes(type)
      ? '- <table>: 이 유형(policy_guide/utility)에서만 허용 — H3 직후 1~2개만 사용'
      : '- <table>: 이 유형에서 절대 사용 금지 — 비교·요약은 반드시 <ul>/<ol>로만';

    const continuePrompt = `블로그 글이 공백제외 ${charCount}자입니다. 목표 800자까지 ${remain}자 이상 추가 작성하세요.

━━ 반드시 준수 ━━
- 허용 태그: h2/h3/p/ul/ol/li/strong/u/img (별표·한자·마크다운 금지)
- H1·H4 태그 절대 금지 / <title> 태그 절대 금지
${tableNote}
- <img>: src는 실제 접근 가능한 URL만 (불확실하면 HTML 주석으로 대체)

━━ 구조 규칙 ━━
- H2 섹션 1~2개 추가 (FAQ 포함 총 H2 최소 4개 유지)
- 각 H2 직후 요약 <p> 1개 / 각 H2 안에 H3 2~3개
- 각 H3 직후 <p> 1~3문장 → <ul>/<ol> (li 최소 3개)
- 새로운 관점·심화 정보만 추가 (기존 내용 반복 금지)

이전 글 끝부분:
${tail}

이어서 (HTML만 출력):`;

    let continueData;
    try {
      continueData = await callGeminiApi(env, {
        contents: [{ parts: [{ text: continuePrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
        tools: [{ google_search: {} }],
      }, { timeoutMs: 120_000 });
    } catch {
      break;
    }

    let continueText;
    try {
      continueText = extractText(continueData);
    } catch {
      break;
    }

    continueText = continueText.replace(/<!--[\s\S]*?-->/g, '');
    continueText = cleanupHtml(continueText);
    html = `${html}\n${continueText.trim()}`;
    charCount = plainCharCount(html);
  }

  // 최종 H4 잔존 방어 처리
  html = html.replace(/<h4([^>]*)>/gi, '<h3$1>').replace(/<\/h4>/gi, '</h3>');

  return {
    html,
    metaInfo: {
      metaDesc: metaInfoRaw.metaDesc,
      slug: metaInfoRaw.slug,
      focusKeyword: metaInfoRaw.focusKeyword,
    },
  };
}

/**
 * 선택한 문장을 3~4문장으로 인라인 확장한다 (에디터의 "선택 확장" 기능).
 */
export async function expandSelectedText(env, { selectedText, fullContent = '', postTitle = '' }) {
  if (!selectedText || !selectedText.trim()) {
    throw new AiWriterError('확장할 텍스트를 선택해주세요.', 400);
  }

  let contextBlock = '';
  if (postTitle) contextBlock += `글 제목: ${postTitle}\n`;
  if (fullContent) contextBlock += `전체 글 내용(일부):\n${fullContent.slice(0, 1500)}\n`;

  const prompt = `당신은 한국어 블로그 전문 작가입니다.
아래 [원본 문장]을 3~4개 문장으로 확장하여 반환하세요.

[전체 글 컨텍스트]
${contextBlock}

[원본 문장 — 이 문장을 3~4개 문장으로 확장]
${selectedText}

【핵심 지시사항】
1. 원본 문장의 핵심 내용과 의미를 반드시 유지하세요.
2. 원본 문장을 더 구체적이고 상세하게 풀어서 3~4개 문장으로 확장하세요.
3. 원본 문장의 내용을 첫 문장에 자연스럽게 포함시키세요.
4. 추가 문장들은 구체적인 수치·예시·이유로 원본 내용을 뒷받침하세요.
5. 각 문장은 반드시 20~70자 이내로 작성하세요.

⚠️ 절대 금지
- 원본 문장과 무관한 새로운 주제 도입 금지
- 새로운 H2/H3 섹션 생성 금지 (인라인 확장만)
- 마크다운, 별표(*), 한자 금지
- 마무리·안내 표현('결론적으로', '이상으로' 등) 금지
- 15자 미만/80자 초과 문장 금지, 500자 초과 금지

✅ 출력 형식
- 확장된 3~4개 문장만 출력, HTML 태그 완전 금지, 마크다운 완전 금지
- 줄바꿈 없이 이어지는 하나의 단락, 한국어만 사용

오직 확장된 3~4개 문장만 출력하세요:`;

  const data = await callGeminiApi(env, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 600 },
    tools: [{ google_search: {} }],
  }, { timeoutMs: 60_000 });

  let text = extractText(data);
  text = text.replace(/```[\s\S]*?```/gi, '');
  text = text.replace(/\*\*(.+?)\*\*/gsu, '$1');
  text = text.replace(/\*/g, '');
  text = text.replace(/<[^>]+>/g, ''); // 순수 텍스트만 반환

  return { text: text.trim() };
}
