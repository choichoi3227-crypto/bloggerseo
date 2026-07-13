/**
 * BloggerSEO v13 — WASM 로더 (고성능 실행 코어, 우선순위 2: WASM 사용 확대)
 * wasmCore.generateSlug(title)         → 한글 제목에서 SEO 슬러그 생성 (WASM 가속)
 * wasmCore.fnv1a32Hex(str)             → ETag/캐시 키 해시 생성 (WASM 가속, 대용량 스트리밍)
 * wasmCore.extractBodyText(html)       → HTML→본문 텍스트 추출 (WASM 가속, O(n) 단일 패스)
 * wasmCore.buildMetaDescription(...)   → CJK-aware meta description 생성 (WASM 가속)
 * wasmCore.sha256Hex(str)              → SHA-256 hex 다이제스트 (WASM 가속)
 * wasmCore.sha256HexShort(str, n)      → SHA-256 hex 앞 n자 (경로/키 생성용)
 * wasmCore.hmacSha256Hex(key, msg)     → HMAC-SHA256 hex (WASM 가속)
 * wasmCore.constantTimeEqual(a, b)     → 타이밍 공격 방지 상수시간 비교 (WASM 가속)
 * wasmCore.base64Encode(bytes)         → Base64 인코딩 (WASM 가속)
 * wasmCore.base64Decode(str)           → Base64 디코딩 (WASM 가속)
 * wasmCore.urlEncode(str)              → percent-encoding (WASM 가속)
 * wasmCore.warmup()                    → WASM 사전 초기화
 * wasmCore.backend()                   → 'wasm' | 'js' — 현재 실행 중인 실제 백엔드
 *
 * [v13 — WASM 사용 확대]
 *   기존에는 슬러그 생성/FNV 해시만 실제로 WASM 버퍼 API에 연결돼 있었고,
 *   github-tenant.js가 호출하던 wasm.sha256HexShort / wasm.hmacSha256Hex /
 *   wasm.constantTimeEqual은 애초에 이 모듈에 정의조차 되어 있지 않아
 *   해당 모듈을 사용하려는 순간 즉시 TypeError로 깨지는 상태였다(에러
 *   방지 장치 섹션에서 별도로 다루는 github-tenant.js 활성화와 별개로,
 *   여기서는 그 의존성 자체를 실제로 채워 넣는다). 또한 매 요청 렌더링
 *   경로의 실질적 핫패스인 본문 텍스트 추출(HTML→텍스트, 정규식 3연쇄)과
 *   meta description 생성도 순수 JS로만 동작하고 있었다.
 *
 *   src/security.js의 sha256Hex(diagnostic/device fingerprint 용도)는
 *   Web Crypto(crypto.subtle.digest)가 이미 네이티브 구현이라 WASM으로
 *   바꿔도 이득이 없어 그대로 두었다 — WASM 확대는 "Workers 런타임이
 *   네이티브로 최적화하지 않은 반복 연산"(문자열 파싱, 상태 머신, 순수
 *   CPU 바운드 해시 등)에 집중한다.
 *
 * [v10 핵심 버그 수정 — "WASM이 로드되고도 한 번도 실행되지 않던 문제"]
 *   기존 코드는 `_wasmInstance.exports.generateSlug`와
 *   `_wasmInstance.exports.__alloc`을 찾았지만, 실제 AssemblyScript
 *   빌드(wasm-src/assembly/index.ts)가 내보내는 함수 이름은
 *   `rawGenerateSlug`(+ `getInputPtr`/`getOutputPtr`/`getBufSize`
 *   버퍼 기반 API)이며 `__alloc`은 애초에 존재하지 않는다(exportRuntime
 *   플래그가 만드는 건 `__new`/`__pin`/`__unpin`이다). 그 결과
 *   `_wasmInstance.exports.generateSlug`는 항상 `undefined`였고
 *   `if (...)` 분기가 매번 거짓이 되어, WASM 모듈이 정상적으로
 *   컴파일·인스턴스화된 뒤에도(= _lastBackend가 'wasm'으로 보고됨)
 *   실제 슬러그 생성은 100% JS 폴백 경로로만 실행되고 있었다.
 *   → 실제 export된 저수준 버퍼 API(getInputPtr/getOutputPtr/
 *     getBufSize/rawGenerateSlug 등)에 맞춰 완전히 새로 연결한다.
 *
 * [v10 — ETag 해시(fnv1a32Hex) WASM 가속]
 *   렌더링된 HTML 전체(수십~수백 KB)에 대해 매 요청마다 계산되는
 *   ETag 해시는 이 Worker의 실질적 핫패스다. WASM 입력 버퍼는
 *   128KB(BUF_SIZE) 고정이므로, 그보다 큰 HTML은 청크 단위로 나눠
 *   fnv1a32Chunk()를 반복 호출해 해시 상태를 이어가는 스트리밍
 *   방식으로 처리한다(청크 경계와 무관하게 항상 전체를 한 번에 처리한
 *   것과 동일한 최종 해시가 나오는 것을 직접 테스트로 검증함).
 *
 * [v6.2 유지 — 한글 슬러그 정책]
 *   한글을 로마자로 음역하지 않고 그대로 보존, URL에서는 표준 퍼센트
 *   인코딩(encodeURIComponent, RFC 3986)으로 안전하게 처리.
 *   예) "제주도 여행 코스" → "제주도-여행-코스"
 *       → URL에 쓰일 때 자동으로 "%EC%A0%9C%EC%A3%BC%EB%8F%84-..." 로 인코딩됨.
 *   네이버 블로그/티스토리 등 한국 블로그 플랫폼과 동일한 방식.
 *   영문/숫자/한글 외 문자(특수문자, 이모지 등)는 제거.
 */

let _wasmInstance = null;
let _initPromise  = null;
let _lastBackend  = 'js';
let _initError    = null;

// AssemblyScript exportRuntime이 만드는 abort(): 메시지/파일명 포인터를
// UTF-16 문자열로 읽어 콘솔에 남긴다. 실제로 호출되면 슬러그/해시 생성
// 로직에 버그가 있다는 뜻이므로, 조용히 삼키지 않고 JS 폴백으로 넘어가되
// 원인 파악을 위해 최소한의 정보는 남긴다.
function abortHandler(msgPtr, filePtr, line, col) {
  _initError = `wasm abort at line ${line}:${col}`;
}

async function initWasm() {
  try {
    const { WASM_BASE64 } = await import('../wasm-src/wasm-blob.js');
    if (!WASM_BASE64) throw new Error('WASM_BASE64 missing from wasm-blob.js');
    const bytes = Uint8Array.from(atob(WASM_BASE64), c => c.charCodeAt(0));
    const mod   = await WebAssembly.instantiate(bytes, {
      env: {
        abort: abortHandler,
        'Math.random': Math.random,
      },
    });
    const exp = mod.instance.exports;

    // 필수 export 존재 여부를 실제로 검증 — 하나라도 없으면 이 인스턴스는
    // 신뢰하지 않고 JS 폴백으로 완전히 전환한다 (조용한 무동작 방지).
    const required = [
      'getInputPtr', 'getInput2Ptr', 'getOutputPtr', 'getBufSize',
      'rawGenerateSlug', 'fnv1a32Chunk', 'fnv1a32Seed', 'fnv1a32FinalizeHex',
      'rawExtractBodyText', 'rawBuildMetaDescription',
      'rawSha256Hex', 'rawHmacSha256Hex', 'rawConstantTimeEqual',
      'rawBase64Encode', 'rawBase64Decode', 'rawUrlEncode',
      'memory',
    ];
    const missing = required.filter(name => typeof exp[name] === 'undefined');
    if (missing.length) {
      throw new Error('wasm missing exports: ' + missing.join(', '));
    }

    _wasmInstance = mod.instance;
    _lastBackend  = 'wasm';
  } catch (e) {
    _wasmInstance = null;
    _lastBackend  = 'js';
    _initError    = _initError || String(e?.message ?? e);
  }
}

// ── 버퍼 I/O 헬퍼 (WASM 선형 메모리 직접 접근) ──────────────────────
function wasmMem() {
  return new Uint8Array(_wasmInstance.exports.memory.buffer);
}

// UTF-8 바이트를 INPUT_BUF에 기록. 버퍼(128KB)보다 크면 안전하게 자른다
// (호출부에서 청크 처리가 필요한 경우는 별도 스트리밍 함수를 쓴다).
function writeInputUtf8(bytes) {
  const ptr     = Number(_wasmInstance.exports.getInputPtr());
  const bufSize = Number(_wasmInstance.exports.getBufSize());
  const mem     = wasmMem();
  const n       = Math.min(bytes.length, bufSize);
  mem.set(bytes.subarray(0, n), ptr);
  return n;
}

// UTF-8 바이트를 INPUT_BUF2에 기록 (2-인자 함수: HMAC key/message, title/body 등)
function writeInput2Utf8(bytes) {
  const ptr     = Number(_wasmInstance.exports.getInput2Ptr());
  const bufSize = Number(_wasmInstance.exports.getBufSize());
  const mem     = wasmMem();
  const n       = Math.min(bytes.length, bufSize);
  mem.set(bytes.subarray(0, n), ptr);
  return n;
}

function readOutputBytes(len) {
  const ptr = Number(_wasmInstance.exports.getOutputPtr());
  const mem = wasmMem();
  return mem.slice(ptr, ptr + len);
}

function readOutputUtf8(len) {
  const ptr = Number(_wasmInstance.exports.getOutputPtr());
  const mem = wasmMem();
  return new TextDecoder().decode(mem.subarray(ptr, ptr + len));
}

// ── 슬러그용 문자 판별 (JS 폴백 전용) ────────────────────────────────
function isAllowedChar(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x30 && code <= 0x39) return true;        // 0-9
  if (code >= 0x61 && code <= 0x7a) return true;        // a-z
  if (code >= 0xac00 && code <= 0xd7a3) return true;     // 완성형 한글 (가~힣)
  if (code >= 0x3131 && code <= 0x3163) return true;     // 한글 자모 (ㄱ~ㅣ)
  return false;
}

// ── JS 폴백 슬러그 생성 (WASM 사용 불가 시에만) ─────────────────────
function jsGenerateSlug(title) {
  if (!title || typeof title !== 'string') return 'post';
  let s = title.trim().toLowerCase();

  s = s
    .replace(/\s+/g, '-')
    .split('')
    .filter(ch => ch === '-' || isAllowedChar(ch))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!s || s.length < 1) return 'post-' + Date.now().toString(36);
  return truncateForUrl(s, 200);
}

function truncateForUrl(s, maxEncodedLength) {
  let result = '';
  for (const ch of s) {
    const next = result + ch;
    if (encodeURIComponent(next).length > maxEncodedLength) break;
    result = next;
  }
  return result.replace(/-$/, '');
}

// ── JS 폴백 FNV-1a 32bit (WASM 사용 불가 시에만) ─────────────────────
function jsFnv1a32Hex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= str.length; h = Math.imul(h, 0x01000193);
  return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

// ── JS 폴백: HTML→본문 텍스트 추출 (WASM 사용 불가 시에만) ───────────
function jsExtractBodyText(html) {
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── JS 폴백: CJK-aware meta description (WASM 사용 불가 시에만) ──────
function jsIsWideChar(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}
function jsBuildMetaDescription(bodyText, title, maxWidth) {
  const limit = maxWidth || 160;
  let t = title ? String(bodyText).replace(title, '').trim() : String(bodyText).trim();
  let width = 0, cutAt = -1, result = '', truncated = false;
  for (let i = 0; i < t.length; i++) {
    const cp = t.charCodeAt(i);
    const w  = jsIsWideChar(cp) ? 2 : 1;
    if (width + w > limit) { truncated = true; break; }
    if (cp === 32 && width > 100) cutAt = i;
    width += w;
    result += t[i];
  }
  if (truncated) {
    if (cutAt >= 0) result = t.slice(0, cutAt);
    result += '…';
  }
  return result;
}

// ── JS 폴백: Base64 (WASM 사용 불가 시에만) — Workers 런타임 btoa/atob 사용 ──
function jsBase64Encode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function jsBase64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── JS 폴백: SHA-256 / HMAC-SHA256 (WASM 사용 불가 시에만) — Web Crypto 사용 ──
async function jsSha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function jsHmacSha256Hex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function jsConstantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // 길이가 달라도 타이밍 흡수를 위해 더미 비교를 수행한 뒤 false 반환
    const maxLen = Math.max(a.length, b.length);
    let dummy = 0;
    for (let i = 0; i < maxLen; i++) dummy |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── JS 폴백: URL 인코딩 (WASM 사용 불가 시에만) ──────────────────────
function jsUrlEncode(str) {
  return encodeURIComponent(str);
}

export const wasmCore = {
  _lastBackend: 'js',

  async warmup() {
    if (!_initPromise) _initPromise = initWasm();
    await _initPromise;
    this._lastBackend = _lastBackend;
  },

  // 현재 실행 중인 실제 백엔드 ('wasm' | 'js') — 진단/패널용
  backend() { return _lastBackend; },
  lastError() { return _initError; },

  async generateSlug(title) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof title === 'string' && title.length > 0) {
        const bytes = new TextEncoder().encode(title);
        // 제목은 통상 수백 바이트를 넘지 않으므로 청크 없이 단일 호출로
        // 충분하다(128KB 버퍼 대비 여유가 매우 큼). 초과분은 안전하게
        // 잘라 쓰기 때문에 오류 대신 항상 유효한 결과를 반환한다.
        const n = writeInputUtf8(bytes);
        const outLen = _wasmInstance.exports.rawGenerateSlug(n);
        if (outLen > 0) {
          const result = readOutputUtf8(outLen);
          if (result) return result; // 'post'/'untitled' 등 안전한 폴백 슬러그도 wasm이 낸 유효한 결과이므로 그대로 신뢰
        }
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsGenerateSlug(title);
  },

  // ETag/캐시 키용 고속 해시. 입력이 WASM 버퍼(128KB)보다 크면 청크로
  // 나눠 스트리밍 방식으로 이어서 해싱한다(worker.js의 렌더링된 HTML
  // 전체를 매 요청 해싱하는 핫패스에서 사용). 이 해시는 ETag/캐시 키
  // 내부 비교 용도로만 쓰이므로 utils.js의 순수 JS 구현과 비트 단위로
  // 동일할 필요는 없다 — "같은 내용 → 항상 같은 해시"만 보장되면 된다
  // (같은 Worker 인스턴스 내에서는 warmup() 이후 백엔드가 고정되므로
  // 요청 간에 알고리즘이 바뀌어 ETag가 뒤섞이는 일은 없다).
  async fnv1a32Hex(str) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof str === 'string') {
        const bytes   = new TextEncoder().encode(str);
        const ptr     = Number(_wasmInstance.exports.getInputPtr());
        const bufSize = Number(_wasmInstance.exports.getBufSize());
        const mem     = wasmMem();
        let hash      = Number(_wasmInstance.exports.fnv1a32Seed());
        for (let off = 0; off < bytes.length; off += bufSize) {
          const chunk = bytes.subarray(off, Math.min(off + bufSize, bytes.length));
          mem.set(chunk, ptr);
          hash = Number(_wasmInstance.exports.fnv1a32Chunk(hash >>> 0, chunk.length));
        }
        const hexLen = _wasmInstance.exports.fnv1a32FinalizeHex(hash >>> 0);
        if (hexLen > 0) return readOutputUtf8(hexLen);
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsFnv1a32Hex(str);
  },

  // ── HTML → 본문 텍스트 추출 (WASM 가속) ────────────────────────────
  // 128KB 버퍼보다 큰 HTML은 안전하게 잘라서 처리한다(블로그 포스트
  // 본문은 통상 이 크기를 넘지 않으며, 넘는 경우도 meta description
  // 생성에는 앞부분 128KB로 충분하다). 초과분이 필요한 극히 드문 경우엔
  // 호출부에서 사전에 텍스트를 나눠 여러 번 호출하거나 JS 폴백을 쓴다.
  async extractBodyText(html) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof html === 'string' && html.length > 0) {
        const bytes = new TextEncoder().encode(html);
        const n = writeInputUtf8(bytes);
        const outLen = _wasmInstance.exports.rawExtractBodyText(n);
        if (outLen >= 0) return readOutputUtf8(outLen);
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsExtractBodyText(html);
  },

  // ── CJK-aware meta description 생성 (WASM 가속) ────────────────────
  async buildMetaDescription(bodyText, title, maxWidth) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof bodyText === 'string') {
        const bodyBytes  = new TextEncoder().encode(bodyText);
        const n = writeInputUtf8(bodyBytes);
        let titleLen = 0;
        if (title && typeof title === 'string') {
          const titleBytes = new TextEncoder().encode(title);
          titleLen = writeInput2Utf8(titleBytes);
        }
        const outLen = _wasmInstance.exports.rawBuildMetaDescription(n, titleLen, maxWidth || 160);
        if (outLen >= 0) return readOutputUtf8(outLen);
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsBuildMetaDescription(bodyText, title, maxWidth);
  },

  // ── SHA-256 (WASM 가속) ─────────────────────────────────────────────
  async sha256Hex(input) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof input === 'string') {
        const bytes = new TextEncoder().encode(input);
        const n = writeInputUtf8(bytes);
        const outLen = _wasmInstance.exports.rawSha256Hex(n);
        if (outLen > 0) return readOutputUtf8(outLen);
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsSha256Hex(input);
  },

  // 경로/키 생성용 — SHA-256 hex 앞 n자만 필요한 경우(예: 파일 경로 안전화)
  async sha256HexShort(input, hexLen) {
    const full = await this.sha256Hex(input);
    return full.slice(0, hexLen || 16);
  },

  // ── HMAC-SHA256 (WASM 가속) ─────────────────────────────────────────
  async hmacSha256Hex(key, message) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof key === 'string' && typeof message === 'string') {
        const keyBytes = new TextEncoder().encode(key);
        const msgBytes = new TextEncoder().encode(message);
        const keyLen = writeInputUtf8(keyBytes);
        const msgLen = writeInput2Utf8(msgBytes);
        const outLen = _wasmInstance.exports.rawHmacSha256Hex(keyLen, msgLen);
        if (outLen > 0) return readOutputUtf8(outLen);
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsHmacSha256Hex(key, message);
  },

  // ── 상수시간 문자열 비교 (WASM 가속, 타이밍 공격 방지) ───────────────
  async constantTimeEqual(a, b) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof a === 'string' && typeof b === 'string') {
        const aBytes = new TextEncoder().encode(a);
        const bBytes = new TextEncoder().encode(b);
        const aLen = writeInputUtf8(aBytes);
        const bLen = writeInput2Utf8(bBytes);
        // 원본 문자열이 버퍼(128KB)보다 길어서 잘렸다면 WASM 비교가
        // 신뢰할 수 없으므로 안전하게 JS 폴백으로 넘어간다.
        if (aLen === aBytes.length && bLen === bBytes.length) {
          return _wasmInstance.exports.rawConstantTimeEqual(aLen, bLen) === 1;
        }
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsConstantTimeEqual(a, b);
  },

  // ── Base64 인코딩/디코딩 (WASM 가속) ─────────────────────────────────
  async base64Encode(bytes) {
    try {
      await this.warmup();
      if (_wasmInstance && bytes instanceof Uint8Array) {
        const n = writeInputUtf8(bytes);
        if (n === bytes.length) {
          const outLen = _wasmInstance.exports.rawBase64Encode(n);
          if (outLen >= 0) return readOutputUtf8(outLen);
        }
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsBase64Encode(bytes);
  },
  async base64Decode(str) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof str === 'string') {
        const bytes = new TextEncoder().encode(str);
        const n = writeInputUtf8(bytes);
        if (n === bytes.length) {
          const outLen = _wasmInstance.exports.rawBase64Decode(n);
          if (outLen >= 0) return readOutputBytes(outLen);
        }
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsBase64Decode(str);
  },

  // ── URL(percent) 인코딩 (WASM 가속) ─────────────────────────────────
  async urlEncode(str) {
    try {
      await this.warmup();
      if (_wasmInstance && typeof str === 'string') {
        const bytes = new TextEncoder().encode(str);
        const n = writeInputUtf8(bytes);
        if (n === bytes.length) {
          const outLen = _wasmInstance.exports.rawUrlEncode(n);
          if (outLen >= 0) return readOutputUtf8(outLen);
        }
      }
    } catch (_) { /* 아래 JS 폴백으로 자연스럽게 이어짐 */ }
    return jsUrlEncode(str);
  },
};
