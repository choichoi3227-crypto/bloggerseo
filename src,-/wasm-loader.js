// ═══════════════════════════════════════════════════════════════════
// [WASM 로더] — bloggerseo.wasm (AssemblyScript) 안전 호출 계층
//
// 설계 원칙:
//   1) WASM 인스턴스화는 워커 인스턴스(콜드/웜) 생명주기 동안 1회만 수행
//      (모듈 스코프 캐싱) — 매 요청마다 재컴파일/재인스턴스화하지 않음.
//   2) 모든 WASM 호출은 try/catch로 감싸고, 실패 시 동일한 결과를 내는
//      JS 구현으로 즉시 폴백한다 — 워커의 핵심 응답 경로는 WASM 유무와
//      무관하게 100% 동일하게 동작해야 한다("워커 전체 코드에 영향 없도록").
//   3) JS와 호스트(워커) 사이의 데이터 교환은 고정 오프셋 raw 버퍼
//      (rawGenerateSlug 등)만 사용 — AssemblyScript GC 문자열 객체의
//      내부 구조에 의존하지 않아 빌드가 바뀌어도 안전.
// ═══════════════════════════════════════════════════════════════════

import { WASM_BASE64 } from '../wasm-src/wasm-blob.js';

let _wasmInstancePromise = null;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function instantiateWasm() {
  const bytes = base64ToBytes(WASM_BASE64);
  const importObject = {
    env: {
      // AssemblyScript 런타임이 어설션/언리치블 발생 시 호출.
      // 워커를 죽이지 않고 예외로만 변환 → 호출부에서 catch해 JS 폴백.
      abort(msgPtr, filePtr, line, col) {
        throw new Error(`wasm-abort@${line}:${col}`);
      },
      trace() {},
      seed() { return Date.now(); },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, importObject);
  return instance;
}

// 모듈 스코프에서 1회만 초기화 (워커 인스턴스 재사용 시 캐시됨)
function getWasmInstance() {
  if (!_wasmInstancePromise) {
    _wasmInstancePromise = instantiateWasm().catch(e => {
      // 초기화 자체가 실패해도 다음 요청에서 재시도할 수 있도록 캐시를 비움
      _wasmInstancePromise = null;
      throw e;
    });
  }
  return _wasmInstancePromise;
}

function mem8(instance) {
  return new Uint8Array(instance.exports.memory.buffer);
}

function writeUtf8(instance, ptr, str) {
  const encoded = new TextEncoder().encode(str);
  if (encoded.length > instance.exports.getBufSize()) {
    throw new Error('wasm input too large for buffer');
  }
  mem8(instance).set(encoded, ptr);
  return encoded.length;
}

function writeBytes(instance, ptr, bytes) {
  mem8(instance).set(bytes, ptr);
  return bytes.length;
}

function readBytes(instance, ptr, len) {
  return mem8(instance).slice(ptr, ptr + len);
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// ─────────────────────────────────────────────
// JS 폴백 구현 (WASM과 동일한 결과를 내야 함 — 정확성 검증 완료된 기존 로직)
// ─────────────────────────────────────────────
function generateSlugJsFallback(title) {
  if (!title) return 'untitled';
  try {
    let s = title.trim().toLowerCase()
      .replace(/\s+/g, '-').replace(/_+/g, '-')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
      .replace(/[^\p{L}\p{N}\-]/gu, '-')
      .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    if (/[^\x00-\x7F]/.test(s)) {
      s = encodeURIComponent(s).replace(/%20/g, '-').replace(/%2F/gi, '-');
    }
    return s || 'post';
  } catch (_) {
    return 'post';
  }
}

async function sha256HexJsFallback(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256HexJsFallback(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function constantTimeEqualJsFallback(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0 && a.length === b.length;
}

function fnv1a32JsFallback(input) {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function countOccurrencesJsFallback(haystack, needle) {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

// ─────────────────────────────────────────────
// 공개 API — 워커 어디서나 이 객체만 사용. WASM/JS 여부는 내부에서 처리.
// 모든 메서드는 async (WASM 인스턴스화가 비동기이므로 일관성 유지).
// ─────────────────────────────────────────────
export const wasmCore = {
  // 어떤 백엔드(wasm|js)가 실제로 사용됐는지 마지막 호출 기준으로 노출(디버그용)
  _lastBackend: 'unknown',

  async generateSlug(title) {
    try {
      const instance = await getWasmInstance();
      const inPtr = Number(instance.exports.getInputPtr());
      const outPtr = Number(instance.exports.getOutputPtr());
      const n = writeUtf8(instance, inPtr, title);
      const outLen = instance.exports.rawGenerateSlug(n);
      const result = new TextDecoder().decode(readBytes(instance, outPtr, outLen));
      this._lastBackend = 'wasm';
      return result || 'post';
    } catch (_) {
      this._lastBackend = 'js';
      return generateSlugJsFallback(title);
    }
  },

  async sha256Hex(input) {
    try {
      const instance = await getWasmInstance();
      const inPtr = Number(instance.exports.getInputPtr());
      const outPtr = Number(instance.exports.getOutputPtr());
      const bytes = new TextEncoder().encode(input);
      const n = writeBytes(instance, inPtr, bytes);
      const outLen = instance.exports.rawSha256(n);
      this._lastBackend = 'wasm';
      return bytesToHex(readBytes(instance, outPtr, outLen));
    } catch (_) {
      this._lastBackend = 'js';
      return sha256HexJsFallback(input);
    }
  },

  async sha256HexShort(input, len) {
    const full = await this.sha256Hex(input);
    return full.slice(0, len);
  },

  async hmacSha256Hex(key, message) {
    try {
      const instance = await getWasmInstance();
      const inPtr = Number(instance.exports.getInputPtr());
      const in2Ptr = Number(instance.exports.getInput2Ptr());
      const outPtr = Number(instance.exports.getOutputPtr());
      const keyBytes = new TextEncoder().encode(key);
      const msgBytes = new TextEncoder().encode(message);
      const kn = writeBytes(instance, inPtr, keyBytes);
      const mn = writeBytes(instance, in2Ptr, msgBytes);
      const outLen = instance.exports.rawHmacSha256(kn, mn);
      this._lastBackend = 'wasm';
      return bytesToHex(readBytes(instance, outPtr, outLen));
    } catch (_) {
      this._lastBackend = 'js';
      return hmacSha256HexJsFallback(key, message);
    }
  },

  constantTimeEqual(a, b) {
    // 순수 동기 비교 로직 — WASM 호출 비용(memory 접근)이 오히려 타이밍을
    // 더 흔들 수 있어 이 함수만 JS로 직접 수행 (보안 목적상 변동 없음)
    return constantTimeEqualJsFallback(a, b);
  },

  async fnv1a32Hex(input) {
    try {
      const instance = await getWasmInstance();
      const inPtr = Number(instance.exports.getInputPtr());
      const bytes = new TextEncoder().encode(input);
      const n = writeBytes(instance, inPtr, bytes);
      const h = instance.exports.rawFnv1a32(n) >>> 0;
      this._lastBackend = 'wasm';
      return h.toString(16).padStart(8, '0');
    } catch (_) {
      this._lastBackend = 'js';
      return fnv1a32JsFallback(input).toString(16).padStart(8, '0');
    }
  },

  async countOccurrences(haystack, needle) {
    try {
      const instance = await getWasmInstance();
      const inPtr = Number(instance.exports.getInputPtr());
      const in2Ptr = Number(instance.exports.getInput2Ptr());
      const hBytes = new TextEncoder().encode(haystack);
      const nBytes = new TextEncoder().encode(needle);
      const bufSize = instance.exports.getBufSize();
      if (hBytes.length > bufSize || nBytes.length > bufSize) {
        // 버퍼보다 큰 입력은 WASM 경로를 건너뛰고 안전하게 JS로 처리
        this._lastBackend = 'js';
        return countOccurrencesJsFallback(haystack, needle);
      }
      const hn = writeBytes(instance, inPtr, hBytes);
      const nn = writeBytes(instance, in2Ptr, nBytes);
      this._lastBackend = 'wasm';
      return instance.exports.rawCountOccurrences(hn, nn);
    } catch (_) {
      this._lastBackend = 'js';
      return countOccurrencesJsFallback(haystack, needle);
    }
  },

  async warmup() {
    // 콜드스타트 시 WASM을 미리 인스턴스화해 첫 요청 지연을 줄임 (waitUntil로 호출)
    try {
      await getWasmInstance();
      return true;
    } catch (_) {
      return false;
    }
  },
};
