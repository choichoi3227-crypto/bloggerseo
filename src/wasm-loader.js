/**
 * BloggerSEO v6 — WASM 로더 (v5 호환)
 * wasmCore.generateSlug(title) → 한글 제목에서 SEO 슬러그 생성
 * wasmCore.warmup()            → WASM 사전 초기화
 *
 * [v6.2 수정사항]
 *   - 한글을 로마자로 음역(자모 분해 변환)하지 않음.
 *   - 대신 한글 글자를 슬러그에 그대로 보존하고, 표준 퍼센트 인코딩
 *     (encodeURIComponent, RFC 3986)으로 URL-safe하게 변환.
 *     예) "제주도 여행 코스" → "제주도-여행-코스"
 *         → URL에 쓰일 때 자동으로 "%EC%A0%9C%EC%A3%BC%EB%8F%84-..." 로 인코딩됨.
 *   - 네이버 블로그/티스토리 등 한국 블로그 플랫폼과 동일한 방식.
 *   - 영문/숫자/한글 외 문자(특수문자, 이모지 등)는 제거.
 */

let _wasmInstance = null;
let _initPromise  = null;
let _lastBackend  = 'js';

async function initWasm() {
  // WASM 바이너리가 있으면 로드, 없으면 JS 폴백
  try {
    const { WASM_BASE64 } = await import('../wasm-src/wasm-blob.js');
    if (!WASM_BASE64) throw new Error('WASM_BASE64 missing from wasm-blob.js');
    const bytes = Uint8Array.from(atob(WASM_BASE64), c => c.charCodeAt(0));
    const mod   = await WebAssembly.instantiate(bytes, { env: {
      abort: () => {},
      'Math.random': Math.random,
    }});
    _wasmInstance = mod.instance;
    _lastBackend  = 'wasm';
  } catch (_) {
    _wasmInstance = null;
    _lastBackend  = 'js';
  }
}

// ── 슬러그용 문자 판별 ───────────────────────────────────────────────
// 허용: 영문 소문자, 숫자, 완성형 한글(가~힣), 한글 자모(ㄱ~ㅣ)
function isAllowedChar(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x30 && code <= 0x39) return true;        // 0-9
  if (code >= 0x61 && code <= 0x7a) return true;        // a-z
  if (code >= 0xac00 && code <= 0xd7a3) return true;     // 완성형 한글 (가~힣)
  if (code >= 0x3131 && code <= 0x3163) return true;     // 한글 자모 (ㄱ~ㅣ)
  return false;
}

// ── JS 폴백 슬러그 생성 (WASM 없을 때) ──────────────────────────────
// 한글을 로마자로 바꾸지 않고 그대로 둔다. URL에 쓰일 때는
// encodeURIComponent()가 표준 퍼센트 인코딩(%XX)을 적용한다.
function jsGenerateSlug(title) {
  if (!title || typeof title !== 'string') return 'post';
  let s = title.trim().toLowerCase();

  // 공백류를 하이픈으로, 허용되지 않는 문자는 제거
  s = s
    .replace(/\s+/g, '-')
    .split('')
    .filter(ch => ch === '-' || isAllowedChar(ch))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!s || s.length < 1) return 'post-' + Date.now().toString(36);

  // 슬러그 길이는 "문자 개수"가 아니라 퍼센트 인코딩 후 바이트 길이로 제한
  // (한글 1글자 = encodeURIComponent 기준 9바이트이므로 너무 길어지는 것 방지)
  return truncateForUrl(s, 200);
}

// encodeURIComponent 결과 기준으로 안전하게 자르기
function truncateForUrl(s, maxEncodedLength) {
  let result = '';
  for (const ch of s) {
    const next = result + ch;
    if (encodeURIComponent(next).length > maxEncodedLength) break;
    result = next;
  }
  return result.replace(/-$/, '');
}

export const wasmCore = {
  _lastBackend: 'js',

  async warmup() {
    if (!_initPromise) _initPromise = initWasm();
    await _initPromise;
    this._lastBackend = _lastBackend;
  },

  async generateSlug(title) {
    try {
      await this.warmup();
      if (_wasmInstance?.exports?.generateSlug) {
        // WASM 슬러그 생성 (메모리 관리 포함)
        const encoder = new TextEncoder();
        const bytes   = encoder.encode(title);
        const ptr     = _wasmInstance.exports.__alloc?.(bytes.length + 1, 0) ?? 0;
        if (ptr) {
          const mem = new Uint8Array(_wasmInstance.exports.memory.buffer);
          mem.set(bytes, ptr);
          mem[ptr + bytes.length] = 0;
          const resultPtr = _wasmInstance.exports.generateSlug(ptr);
          if (resultPtr) {
            let result = '';
            let i = resultPtr;
            while (mem[i] !== 0) result += String.fromCharCode(mem[i++]);
            return result || jsGenerateSlug(title);
          }
        }
      }
    } catch (_) {}
    return jsGenerateSlug(title);
  },
};
