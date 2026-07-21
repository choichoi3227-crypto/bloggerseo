/**
 * AI 썸네일 생성 엔진
 * ─────────────────────────────────────────────────────────────────────
 * aibp-pro의 2단계 이미지 생성 파이프라인(Phase A: 주제 리서치 →
 * Phase B: SDXL 프롬프트 생성)을 이식하되, 실제 이미지 렌더링은
 * 원본의 외부 Cloudflare Worker + Pollinations 대신 이 프로젝트
 * 자체의 env.AI 바인딩(Cloudflare Workers AI, stable-diffusion-xl)을
 * 직접 사용한다. 이렇게 하면:
 *   - 별도 Worker 배포/URL 설정이 필요 없다 (원본은
 *     aibp_cf_worker_url 옵션으로 외부 Worker를 호출해야 했음).
 *   - 같은 리전에서 실행되어 왕복 지연시간이 줄어든다.
 *   - Workers AI 무료 티어(일 100,000 호출)로 별도 이미지 API 비용이
 *     들지 않는다.
 *
 * 파이프라인:
 *   1. Phase A (Gemini): 주제를 한국 맥락에서 조사해 실제 의미·시각
 *      요소·오역 위험을 파악 (예: "토스"는 핀테크 앱이지 동사가 아님)
 *   2. Phase B (Gemini): 조사 결과 + 스타일 디렉티브로 SDXL 프롬프트 생성
 *   3. 렌더링 (Workers AI): env.AI.run()으로 실제 이미지 생성
 *
 * "AI 스키마 마크업" 기능은 이식하지 않았다 — src/ai-writer.js 상단
 * 주석에 이유 설명(src/schema.js가 이미 동일 기능 제공).
 */

import { callGeminiApi, extractText } from './ai-writer.js';

const NO_PEOPLE = 'no people, no person, no human, no face, no portrait, no character, no figure, no body parts, no hands, no eyes, no silhouette of person';

const STYLE_DIRECTIVES = {
  poster: {
    label: '포스터',
    core: 'clean professional POSTER background, flat solid color blocks or very simple smooth gradient, bold harmonious color palette, large EMPTY CENTER SPACE for title text, minimal composition, no complex shapes, no busy patterns',
    subject: 'single simple geometric accent element at edge only — keep center completely clear for text',
    color: 'harmonious two-tone palette: deep navy + warm cream, or rich burgundy + soft gold, or forest green + white',
    quality: '(masterpiece:1.4), (best quality:1.3), sharp clean edges, professional poster quality',
    avoid: `complex lines, diagonal intersecting lines, chaotic abstract shapes, busy patterns, noisy background, watercolor, ${NO_PEOPLE}`,
  },
  minimal: {
    label: '미니멀',
    core: 'pure SOLID SINGLE COLOR background, no gradient, no pattern, no texture, completely flat and clean, Bauhaus zen simplicity, large empty center space',
    subject: 'nothing at center — absolutely flat solid background only',
    color: 'single rich solid background color: deep navy blue, or charcoal dark gray, or deep forest green, or rich burgundy',
    quality: '(masterpiece:1.4), (best quality:1.3), perfectly flat solid color, no noise, no grain',
    avoid: `gradient, texture, pattern, multiple colors, bright white background, complex shapes, neon, ${NO_PEOPLE}`,
  },
  photo_realistic: {
    label: '사실적 사진',
    core: 'ultra-photorealistic DSLR photography, shot on Sony A7R5, 50mm f/1.4 lens, shallow depth of field, cinematic natural lighting, editorial quality',
    subject: 'the exact real-world object, place, or scene the topic refers to — photographed authentically',
    color: 'true-to-life color grading, warm filmic tone, rich shadows, luminous highlights',
    quality: '(RAW photo:1.4), (photorealistic:1.4), (hyperrealistic:1.3), 8k uhd, DSLR, award-winning',
    avoid: 'illustration, cartoon, anime, painting, CGI, artificial look, plastic, oversaturated',
  },
  typography: {
    label: '타이포그래피',
    core: 'PURE SOLID BLACK background, completely dark #000000, no gradients, no light, no bright areas, absolute darkness, clean matte black surface, empty center reserved for bold typography overlay',
    subject: 'nothing — pure black void only, center must be completely dark and clear',
    color: 'pure black only, #000000, absolutely no other colors, no gradients, solid darkness',
    quality: '(masterpiece:1.4), (best quality:1.3), pure black, solid dark background, no light leaks',
    avoid: `bright areas, gradients, colors, patterns, textures, light sources, ${NO_PEOPLE}`,
  },
  branding: {
    label: '브랜딩',
    core: 'high-end advertising campaign BACKGROUND, luxury brand aesthetic, clean sophisticated layout with large CENTER space, premium brand design, aspirational atmosphere',
    subject: 'abstract brand-style background elements — premium textures, subtle patterns placed at edges only, center reserved for title',
    color: 'premium palette: deep charcoal + pure white + metallic gold, or all-white with bold color edge accent',
    quality: '(masterpiece:1.4), (best quality:1.3), (commercial quality:1.2), pristine, premium brand feel',
    avoid: `amateur, stock-photo feel, cluttered center, neon overload, ${NO_PEOPLE}`,
  },
};

const DEFAULT_NEGATIVE_PROMPT =
  '(text:1.5), (letters:1.5), (words:1.5), (writing:1.5), (font:1.4), (watermark:1.4), (bad quality:1.4), (worst quality:1.5), blurry, distorted, deformed, ugly, low resolution';

export class ThumbnailError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function stripJsonFence(text) {
  return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/m);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ── Phase A: 주제 리서치 (한국 맥락 오역 방지) ───────────────────────────
async function researchTopic(env, topic) {
  const prompt = `당신은 한국 미디어·문화·서비스·브랜드에 정통한 비주얼 콘텐츠 전문가입니다.
아래 키워드를 심층 조사하여 최고 품질 이미지 생성에 필요한 정보를 추출하세요.

[키워드]: ${topic}

【오역 방지 — 한국 특수 맥락 필수 확인】
- "알약" → 한국 보안SW (약이 아님)
- "토스" → 핀테크앱 (동사 아님)
- "카카오" → IT대기업 (열매 아님)
- "네이버" → 검색엔진 (이웃 아님)
- "배민" → 배달앱
- "당근" → 중고거래앱 (채소 아님)
- "쿠팡" → 이커머스
위 패턴처럼 한국 고유 맥락이 있으면 반드시 적용하세요.

【분석 항목】
1. 이 키워드가 한국 독자에게 실제로 의미하는 것
2. 최고 품질 이미지로 표현할 때 사용해야 할 구체적 시각 요소
3. 가장 임팩트 있는 단일 핵심 장면/오브젝트
4. 색상 분위기 (따뜻한/차가운/중성, 대표 색상)
5. 잘못 그릴 경우 발생할 오류

【JSON 출력 (코드블록 없이)】
{
  "actual_meaning": "실제 의미 (1문장, 정확하게)",
  "visual_context": "이미지화 대상 (구체적 장면/오브젝트, 영문 묘사 포함)",
  "hero_shot": "가장 임팩트 있는 단 하나의 시각 장면 (영어로)",
  "color_mood": "색상 분위기 (영어로, 예: warm golden tones, cool tech blues)",
  "key_visuals": ["영어 시각요소1", "영어 시각요소2", "영어 시각요소3", "영어 시각요소4"],
  "wrong_interpretation": "잘못 해석 시 오류 (간결하게, 없으면 빈 문자열)"
}`;

  try {
    const data = await callGeminiApi(env, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 700, topP: 0.75 },
      tools: [{ google_search: {} }],
    }, { timeoutMs: 35_000, model: 'gemini-2.5-flash-lite' });

    const raw = extractText(data);
    const parsed = safeJsonParse(stripJsonFence(raw));
    return parsed || {};
  } catch {
    // 리서치 실패해도 이미지 생성은 topic 그대로 진행할 수 있어야 하므로
    // 여기서는 에러를 던지지 않고 빈 결과로 폴백한다.
    return {};
  }
}

// ── Phase B: SDXL 프롬프트 생성 ──────────────────────────────────────────
async function buildImagePrompt(env, topic, style, research) {
  const dir = STYLE_DIRECTIVES[style] || STYLE_DIRECTIVES.poster;

  const actualMeaning = research.actual_meaning || topic;
  const visualContext = research.visual_context || topic;
  const heroShot = research.hero_shot || '';
  const colorMood = research.color_mood || '';
  const keyVisuals = Array.isArray(research.key_visuals) ? research.key_visuals.join(', ') : '';
  const wrongInterp = research.wrong_interpretation || '';

  const promptInstruction = `당신은 Stable Diffusion XL 전문 프롬프트 엔지니어로, Imagen·DALL-E 3 동급의 결과를 SDXL에서 구현합니다.
아래 조사 데이터를 바탕으로 [${dir.label}] 스타일의 완벽한 블로그 썸네일 프롬프트를 작성하세요.

━━━ 주제 조사 결과 ━━━
• 원본 키워드: ${topic}
• 실제 의미: ${actualMeaning}
• 시각화 대상: ${visualContext}
• 히어로 장면: ${heroShot}
• 색상 분위기: ${colorMood}
• 핵심 시각 요소: ${keyVisuals}
• 오역 방지: ${wrongInterp}

━━━ 스타일 스펙 [${dir.label}] ━━━
• 핵심 디렉션: ${dir.core}
• 주제 표현법: ${dir.subject}
• 색상 팔레트: ${dir.color}

━━━ SDXL 프롬프트 작성 규칙 ━━━
① 주제 정확도: "${actualMeaning}"를 오해 없이 표현하는 시각 요소를 최우선 배치
② 구도 명시: 반드시 16:9 widescreen landscape orientation 명시
③ 품질 태그: (masterpiece:1.4), (best quality:1.3) 등 SDXL 가중치 문법 사용
④ 글자·문자 완전 금지: "no text", "no letters", "no writing", "text-free" 반드시 포함
⑤ 인물·얼굴 완전 금지(photo_realistic 제외): "no people, no person, no face, no human" 반드시 포함
⑥ 텍스트 삽입 공간 확보: "clear center area for text overlay" 포함

━━━ 출력 형식 (순수 JSON만, 마크다운 없이) ━━━
{
  "prompt": "완성된 영어 SDXL 프롬프트 (200단어 이내, 쉼표 구분)",
  "neg_prompt": "네거티브 프롬프트 (텍스트·워터마크·저품질 관련 토큰 포함)"
}`;

  const data = await callGeminiApi(env, {
    contents: [{ parts: [{ text: promptInstruction }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
  }, { timeoutMs: 35_000, model: 'gemini-2.5-flash-lite' });

  const raw = extractText(data);
  const parsed = safeJsonParse(stripJsonFence(raw));

  if (parsed && parsed.prompt) {
    return {
      prompt: parsed.prompt,
      negPrompt: parsed.neg_prompt || DEFAULT_NEGATIVE_PROMPT,
      styleLabel: dir.label,
    };
  }

  // 파싱 실패 시 디렉티브 필드를 직접 조합해 최소한의 프롬프트를 보장한다.
  const fallbackPrompt = [
    dir.core, dir.subject, dir.color, dir.quality,
    '16:9 widescreen landscape orientation', 'no text, no letters, no writing, text-free',
    'clear center area for text overlay',
  ].join(', ');

  return { prompt: fallbackPrompt, negPrompt: `${dir.avoid}, ${DEFAULT_NEGATIVE_PROMPT}`, styleLabel: dir.label };
}

/**
 * 주제 + 스타일로 SDXL 프롬프트를 생성한다 (이미지 렌더링 전 단계).
 * 프론트엔드가 프롬프트를 먼저 확인/수정하고 싶을 때 이 단계만 별도 호출 가능.
 */
export async function generateImagePrompt(env, topic, style = 'poster') {
  if (!topic || !topic.trim()) {
    throw new ThumbnailError('주제가 없습니다.', 400);
  }
  const research = await researchTopic(env, topic);
  return buildImagePrompt(env, topic, style, research);
}

/**
 * 실제 이미지를 Cloudflare Workers AI(SDXL)로 렌더링한다.
 * @returns {Promise<{imageBytes: Uint8Array, mime: string}>}
 */
export async function renderThumbnailImage(env, prompt, negPrompt) {
  if (!env.AI) {
    throw new ThumbnailError('Workers AI 바인딩(env.AI)이 설정되지 않았습니다. wrangler.toml의 [ai] 섹션을 확인하세요.', 500);
  }
  if (!prompt || !prompt.trim()) {
    throw new ThumbnailError('이미지 프롬프트가 없습니다.', 400);
  }

  let result;
  try {
    result = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
      prompt: prompt.trim(),
      negative_prompt: (negPrompt || DEFAULT_NEGATIVE_PROMPT).trim(),
      num_steps: 20,
    });
  } catch (err) {
    throw new ThumbnailError(`이미지 생성 실패: ${err.message}`, 502);
  }

  // env.AI.run의 text-to-image 모델은 ReadableStream(PNG 바이너리)을 반환한다.
  const imageBytes = result instanceof Uint8Array
    ? result
    : new Uint8Array(await new Response(result).arrayBuffer());

  if (imageBytes.byteLength < 1000) {
    throw new ThumbnailError('이미지 데이터가 너무 작습니다. 다시 시도해주세요.', 502);
  }

  return { imageBytes, mime: 'image/png' };
}

/**
 * 전체 파이프라인 원스톱 실행: 리서치 → 프롬프트 생성 → 이미지 렌더링.
 */
export async function generateThumbnail(env, topic, style = 'poster') {
  const { prompt, negPrompt, styleLabel } = await generateImagePrompt(env, topic, style);
  const { imageBytes, mime } = await renderThumbnailImage(env, prompt, negPrompt);
  return { imageBytes, mime, prompt, negPrompt, styleLabel };
}

export { STYLE_DIRECTIVES };
