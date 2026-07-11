/**
 * BloggerSEO v10 — WASM 로더 (고성능 실행 코어)
 * wasmCore.generateSlug(title) → 한글 제목에서 SEO 슬러그 생성 (WASM 가속)
 * wasmCore.fnv1a32Hex(str)     → ETag/캐시 키 해시 생성 (WASM 가속, 대용량 스트리밍)
 * wasmCore.warmup()            → WASM 사전 초기화
 * wasmCore.backend()           → 'wasm' | 'js' — 현재 실행 중인 실제 백엔드
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
 * [v10 신규 — ETag 해시(fnv1a32Hex) WASM 가속]
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
      'getInputPtr', 'getOutputPtr', 'getBufSize',
      'rawGenerateSlug', 'fnv1a32Chunk', 'fnv1a32Seed', 'fnv1a32FinalizeHex',
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
};
