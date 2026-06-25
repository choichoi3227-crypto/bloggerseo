// ═══════════════════════════════════════════════════════════════════
// [WASM 로더 v4] — 고급 연산 + 안정성 강화
//
// v4 개선:
//   - WASM 초기화 실패 시 영구 실패가 아닌 백오프 후 재시도
//   - 버퍼 오버플로 완전 방어 (대형 HTML 입력 안전 처리)
//   - TextEncoder/Decoder 인스턴스 재사용 (마이크로 최적화)
//   - warmup() → 타임아웃 보호 추가 (5초 초과 시 조용히 실패)
//   - 모든 exports 존재 여부 런타임 검증 → 누락 export = JS 폴백
// ═══════════════════════════════════════════════════════════════════

import { WASM_BASE64 } from '../wasm-src/wasm-blob.js';

let _wasmInstancePromise = null;
let _wasmFailedUntil = 0;         // 실패 후 재시도 금지 기간(ms)
const WASM_RETRY_COOLDOWN = 30000; // 30초간 재시도 없음

const _enc = new TextEncoder();
const _dec = new TextDecoder();

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
      abort(msgPtr, filePtr, line, col) {
        throw new Error(`wasm-abort@${line}:${col}`);
      },
      trace() {},
      seed() { return Date.now() * Math.random(); },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, importObject);

  // 필수 exports 검증 — 누락 시 즉시 throw → JS 폴백 사용
  const required = [
    'memory', 'getInputPtr', 'getInput2Ptr', 'getOutputPtr',
    'getBufSize', 'rawGenerateSlug', 'rawSha256',
    'rawHmacSha256', 'rawFnv1a32', 'rawCountOccurrences',
  ];
  for (const exp of required) {
    if (typeof instance.exports[exp] === 'undefined') {
      throw new Error(`wasm missing export: ${exp}`);
    }
  }
  return instance;
}

function getWasmInstance() {
  // 최근 실패 시 쿨다운 기간 동안 즉시 JS 폴백
  if (_wasmFailedUntil > Date.now()) return Promise.reject(new Error('wasm cooldown'));
  if (!_wasmInstancePromise) {
    _wasmInstancePromise = instantiateWasm().catch(e => {
      _wasmInstancePromise = null;
      _wasmFailedUntil = Date.now() + WASM_RETRY_COOLDOWN;
      throw e;
    });
  }
  return _wasmInstancePromise;
}

function mem8(inst) { return new Uint8Array(inst.exports.memory.buffer); }

function writeUtf8(inst, ptr, str) {
  const encoded = _enc.encode(str);
  const bufSize = inst.exports.getBufSize();
  if (encoded.length > bufSize) throw new Error('wasm input too large');
  mem8(inst).set(encoded, ptr);
  return encoded.length;
}

function writeBytes(inst, ptr, bytes) {
  const bufSize = inst.exports.getBufSize();
  if (bytes.length > bufSize) throw new Error('wasm input too large');
  mem8(inst).set(bytes, ptr);
  return bytes.length;
}

function readBytes(inst, ptr, len) { return mem8(inst).slice(ptr, ptr + len); }

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// ─── JS 폴백 구현 ──────────────────────────────────────────────────
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
  } catch (_) { return 'post'; }
}

async function sha256HexJsFallback(input) {
  const data = _enc.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256HexJsFallback(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', _enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, _enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function constantTimeEqualJsFallback(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0 && a.length === b.length;
}

function fnv1a32JsFallback(input) {
  const bytes = _enc.encode(input);
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

// ─── 공개 API ──────────────────────────────────────────────────────
export const wasmCore = {
  _lastBackend: 'unknown',

  async generateSlug(title) {
    try {
      const inst = await getWasmInstance();
      const inPtr = Number(inst.exports.getInputPtr());
      const outPtr = Number(inst.exports.getOutputPtr());
      const n = writeUtf8(inst, inPtr, title);
      const outLen = inst.exports.rawGenerateSlug(n);
      const result = _dec.decode(readBytes(inst, outPtr, Number(outLen)));
      this._lastBackend = 'wasm';
      return result || 'post';
    } catch (_) {
      this._lastBackend = 'js';
      return generateSlugJsFallback(title);
    }
  },

  async sha256Hex(input) {
    try {
      const inst = await getWasmInstance();
      const inPtr = Number(inst.exports.getInputPtr());
      const outPtr = Number(inst.exports.getOutputPtr());
      const bytes = _enc.encode(input);
      const n = writeBytes(inst, inPtr, bytes);
      const outLen = inst.exports.rawSha256(n);
      this._lastBackend = 'wasm';
      return bytesToHex(readBytes(inst, outPtr, Number(outLen)));
    } catch (_) {
      this._lastBackend = 'js';
      return sha256HexJsFallback(input);
    }
  },

  async sha256HexShort(input, len) {
    const full = await this.sha256Hex(input);
    return full.slice(0, len || 16);
  },

  async hmacSha256Hex(key, message) {
    try {
      const inst = await getWasmInstance();
      const inPtr  = Number(inst.exports.getInputPtr());
      const in2Ptr = Number(inst.exports.getInput2Ptr());
      const outPtr = Number(inst.exports.getOutputPtr());
      const keyBytes = _enc.encode(key);
      const msgBytes = _enc.encode(message);
      const kn = writeBytes(inst, inPtr,  keyBytes);
      const mn = writeBytes(inst, in2Ptr, msgBytes);
      const outLen = inst.exports.rawHmacSha256(kn, mn);
      this._lastBackend = 'wasm';
      return bytesToHex(readBytes(inst, outPtr, Number(outLen)));
    } catch (_) {
      this._lastBackend = 'js';
      return hmacSha256HexJsFallback(key, message);
    }
  },

  constantTimeEqual(a, b) { return constantTimeEqualJsFallback(a, b); },

  async fnv1a32Hex(input) {
    try {
      const inst = await getWasmInstance();
      const inPtr = Number(inst.exports.getInputPtr());
      const bytes = _enc.encode(input);
      const n = writeBytes(inst, inPtr, bytes);
      const h = inst.exports.rawFnv1a32(n) >>> 0;
      this._lastBackend = 'wasm';
      return h.toString(16).padStart(8, '0');
    } catch (_) {
      this._lastBackend = 'js';
      return fnv1a32JsFallback(input).toString(16).padStart(8, '0');
    }
  },

  async countOccurrences(haystack, needle) {
    try {
      const inst = await getWasmInstance();
      const inPtr  = Number(inst.exports.getInputPtr());
      const in2Ptr = Number(inst.exports.getInput2Ptr());
      const bufSize = inst.exports.getBufSize();
      const hBytes = _enc.encode(haystack);
      const nBytes = _enc.encode(needle);
      if (hBytes.length > bufSize || nBytes.length > bufSize) {
        this._lastBackend = 'js';
        return countOccurrencesJsFallback(haystack, needle);
      }
      const hn = writeBytes(inst, inPtr,  hBytes);
      const nn = writeBytes(inst, in2Ptr, nBytes);
      this._lastBackend = 'wasm';
      return Number(inst.exports.rawCountOccurrences(hn, nn));
    } catch (_) {
      this._lastBackend = 'js';
      return countOccurrencesJsFallback(haystack, needle);
    }
  },

  async warmup() {
    try {
      // 5초 타임아웃 보호
      await Promise.race([
        getWasmInstance(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('wasm warmup timeout')), 5000)),
      ]);
      return true;
    } catch (_) { return false; }
  },
};
