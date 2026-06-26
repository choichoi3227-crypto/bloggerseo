// ═══════════════════════════════════════════════════════════════════
// bloggerseo WASM core v5
// 변경: KV-less 자체 NoSQL 스토리지 지원, 슬러그 버그 수정,
//       고성능 인코딩/암호화, 안정성 강화
// ═══════════════════════════════════════════════════════════════════

// ── 버퍼 설정 ──────────────────────────────────────────────────────
const BUF_SIZE: i32 = 131072; // 128KB (기존 64KB → 2배, 대형 HTML 대응)
const INPUT_BUF:  StaticArray<u8> = new StaticArray<u8>(BUF_SIZE);
const INPUT_BUF2: StaticArray<u8> = new StaticArray<u8>(BUF_SIZE);
const OUTPUT_BUF: StaticArray<u8> = new StaticArray<u8>(BUF_SIZE);

export function getInputPtr():  usize { return changetype<usize>(INPUT_BUF);  }
export function getInput2Ptr(): usize { return changetype<usize>(INPUT_BUF2); }
export function getOutputPtr(): usize { return changetype<usize>(OUTPUT_BUF); }
export function getBufSize():   i32   { return BUF_SIZE; }

// ── UTF-8 헬퍼 ─────────────────────────────────────────────────────
function utf8Encode(str: string): Uint8Array {
  return Uint8Array.wrap(String.UTF8.encode(str, false));
}
function utf8Decode(bytes: Uint8Array): string {
  return String.UTF8.decode(bytes.buffer, false);
}
function readInputUtf8(len: i32): string {
  const ptr = changetype<usize>(INPUT_BUF);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = load<u8>(ptr + i);
  return utf8Decode(bytes);
}
function writeOutputUtf8(s: string): i32 {
  const encoded = utf8Encode(s);
  const n = encoded.length < BUF_SIZE ? encoded.length : BUF_SIZE;
  for (let i = 0; i < n; i++) OUTPUT_BUF[i] = encoded[i];
  return n;
}
function writeOutputBytes(bytes: Uint8Array): i32 {
  const n = bytes.length < BUF_SIZE ? bytes.length : BUF_SIZE;
  for (let i = 0; i < n; i++) OUTPUT_BUF[i] = bytes[i];
  return n;
}
function bytesToHex(bytes: Uint8Array): string {
  const h = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += h.charAt(b >> 4) + h.charAt(b & 0xf);
  }
  return out;
}

// ── 문자 판별 헬퍼 ─────────────────────────────────────────────────
function isCombiningMark(cp: i32): bool { return cp >= 0x0300 && cp <= 0x036f; }
function isHangul(cp: i32): bool {
  return (cp >= 0xac00 && cp <= 0xd7a3) ||
         (cp >= 0x1100 && cp <= 0x11ff) ||
         (cp >= 0x3130 && cp <= 0x318f);
}
function isAsciiAlnum(cp: i32): bool {
  return (cp >= 48 && cp <= 57) || (cp >= 97 && cp <= 122);
}
function toAsciiLower(cp: i32): i32 {
  if (cp >= 65 && cp <= 90) return cp + 32;
  return cp;
}
function approxBaseLatin(cp: i32): i32 {
  if ((cp >= 0xc0 && cp <= 0xc5) || (cp >= 0xe0 && cp <= 0xe5)) return 97;
  if ((cp >= 0xc8 && cp <= 0xcb) || (cp >= 0xe8 && cp <= 0xeb)) return 101;
  if ((cp >= 0xcc && cp <= 0xcf) || (cp >= 0xec && cp <= 0xef)) return 105;
  if ((cp >= 0xd2 && cp <= 0xd6) || (cp >= 0xf2 && cp <= 0xf6)) return 111;
  if ((cp >= 0xd9 && cp <= 0xdc) || (cp >= 0xf9 && cp <= 0xfc)) return 117;
  if (cp == 0xd1 || cp == 0xf1) return 110;
  if (cp == 0xc7 || cp == 0xe7) return 99;
  if (cp == 0xdd || cp == 0xfd || cp == 0xff) return 121;
  return cp;
}

// ── [1] 슬러그 생성 (v5 버그 수정) ────────────────────────────────
// 수정: 한글만 있는 제목도 슬러그가 정상 생성되도록
//       (기존 버전: 비-ASCII 플래그가 켜져 percent-encode 분기로 빠지던 버그)
export function generateSlugWasm(title: string): string {
  if (title.length == 0) return "untitled";

  const len = title.length;
  let out = "";
  let lastWasHyphen = false;
  let hasOutput = false;

  for (let i = 0; i < len; i++) {
    let cp = title.charCodeAt(i);

    if (isCombiningMark(cp)) continue;

    cp = toAsciiLower(cp);
    cp = approxBaseLatin(cp);
    cp = toAsciiLower(cp);

    const isSpaceLike =
      cp == 32 || cp == 9 || cp == 10 || cp == 13 || cp == 0xa0 || cp == 95;

    if (isSpaceLike) {
      if (hasOutput && !lastWasHyphen) {
        out += "-";
        lastWasHyphen = true;
      }
      continue;
    }

    // 한글 또는 ASCII 영숫자는 그대로 출력
    const allowed = isAsciiAlnum(cp) || isHangul(cp);

    if (allowed) {
      out += String.fromCharCode(cp);
      lastWasHyphen = false;
      hasOutput = true;
    } else if (cp > 127 && !isHangul(cp)) {
      // 기타 비-ASCII (이모지, CJK 등) → 하이픈으로 치환
      if (hasOutput && !lastWasHyphen) {
        out += "-";
        lastWasHyphen = true;
      }
    } else {
      // 허용되지 않는 ASCII 구두점 등 → 하이픈
      if (hasOutput && !lastWasHyphen) {
        out += "-";
        lastWasHyphen = true;
      }
    }
  }

  // 앞뒤 하이픈 제거
  let start = 0;
  let end = out.length;
  while (start < end && out.charCodeAt(start) == 45) start++;
  while (end > start && out.charCodeAt(end - 1) == 45) end--;
  out = out.substring(start, end);

  if (out.length == 0) return "post";
  return out;
}

export function rawGenerateSlug(inLen: i32): i32 {
  const title = readInputUtf8(inLen);
  const slug = generateSlugWasm(title);
  return writeOutputUtf8(slug);
}

// ── [2] SHA-256 ────────────────────────────────────────────────────
const SHA256_K: StaticArray<u32> = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: u32, n: u32): u32 { return (x >>> n) | (x << (32 - n)); }

function sha256Digest(msg: Uint8Array): Uint8Array {
  let h0: u32 = 0x6a09e667, h1: u32 = 0xbb67ae85,
      h2: u32 = 0x3c6ef372, h3: u32 = 0xa54ff53a,
      h4: u32 = 0x510e527f, h5: u32 = 0x9b05688c,
      h6: u32 = 0x1f83d9ab, h7: u32 = 0x5be0cd19;

  const msgLen = msg.length;
  const bitLen: u64 = (msgLen as u64) * 8;
  let totalLen = msgLen + 1;
  while (totalLen % 64 != 56) totalLen++;
  totalLen += 8;

  const padded = new Uint8Array(totalLen);
  for (let i = 0; i < msgLen; i++) padded[i] = msg[i];
  padded[msgLen] = 0x80;
  for (let i = 0; i < 8; i++) padded[totalLen - 1 - i] = u8((bitLen >> (u64(i) * 8)) & 0xff);

  const w = new StaticArray<u32>(64);
  const blocks = totalLen / 64;
  for (let b = 0; b < blocks; b++) {
    const off = b * 64;
    for (let t = 0; t < 16; t++) {
      const o = off + t * 4;
      w[t] = (u32(padded[o]) << 24) | (u32(padded[o+1]) << 16) |
              (u32(padded[o+2]) << 8) | u32(padded[o+3]);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t-15],7) ^ rotr(w[t-15],18) ^ (w[t-15] >>> 3);
      const s1 = rotr(w[t-2],17) ^ rotr(w[t-2],19) ^ (w[t-2] >>> 10);
      w[t] = w[t-16] + s0 + w[t-7] + s1;
    }
    let a=h0, bb=h1, c=h2, d=h3, e=h4, f=h5, g=h6, h=h7;
    for (let t = 0; t < 64; t++) {
      const S1   = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch   = (e & f) ^ (~e & g);
      const temp1 = h + S1 + ch + SHA256_K[t] + w[t];
      const S0   = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj  = (a & bb) ^ (a & c) ^ (bb & c);
      const temp2 = S0 + maj;
      h=g; g=f; f=e; e=d+temp1; d=c; c=bb; bb=a; a=temp1+temp2;
    }
    h0+=a; h1+=bb; h2+=c; h3+=d; h4+=e; h5+=f; h6+=g; h7+=h;
  }
  const out = new Uint8Array(32);
  const hs: StaticArray<u32> = [h0,h1,h2,h3,h4,h5,h6,h7];
  for (let i = 0; i < 8; i++) {
    out[i*4]   = u8(hs[i] >> 24); out[i*4+1] = u8(hs[i] >> 16);
    out[i*4+2] = u8(hs[i] >> 8);  out[i*4+3] = u8(hs[i]);
  }
  return out;
}

export function sha256Hex(input: string): string {
  return bytesToHex(sha256Digest(utf8Encode(input)));
}
export function sha256HexShort(input: string, hexLen: i32): string {
  return sha256Hex(input).substring(0, hexLen);
}
export function rawSha256(inLen: i32): i32 {
  const copy = new Uint8Array(inLen);
  for (let i = 0; i < inLen; i++) copy[i] = INPUT_BUF[i];
  return writeOutputBytes(sha256Digest(copy));
}

// ── [3] HMAC-SHA256 ────────────────────────────────────────────────
function hmacSha256Raw(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256Digest(k);
  if (k.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    for (let i = 0; i < k.length; i++) padded[i] = k[i];
    k = padded;
  }
  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) { oKeyPad[i] = k[i] ^ 0x5c; iKeyPad[i] = k[i] ^ 0x36; }
  const inner = new Uint8Array(blockSize + message.length);
  for (let i = 0; i < blockSize; i++) inner[i] = iKeyPad[i];
  for (let i = 0; i < message.length; i++) inner[blockSize + i] = message[i];
  const innerHash = sha256Digest(inner);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) outer[i] = oKeyPad[i];
  for (let i = 0; i < 32; i++) outer[blockSize + i] = innerHash[i];
  return sha256Digest(outer);
}
export function hmacSha256Hex(key: string, message: string): string {
  return bytesToHex(hmacSha256Raw(utf8Encode(key), utf8Encode(message)));
}
export function rawHmacSha256(keyLen: i32, msgLen: i32): i32 {
  const key = new Uint8Array(keyLen);
  for (let i = 0; i < keyLen; i++) key[i] = INPUT_BUF[i];
  const message = new Uint8Array(msgLen);
  for (let i = 0; i < msgLen; i++) message[i] = INPUT_BUF2[i];
  return writeOutputBytes(hmacSha256Raw(key, message));
}
export function constantTimeEqual(a: string, b: string): bool {
  const len = a.length;
  if (len != b.length) {
    let dummy: i32 = 0;
    const maxLen = len > b.length ? len : b.length;
    for (let i = 0; i < maxLen; i++) {
      const ca = i < a.length ? a.charCodeAt(i) : 0;
      const cb = i < b.length ? b.charCodeAt(i) : 0;
      dummy |= ca ^ cb;
    }
    return false;
  }
  let diff: i32 = 0;
  for (let i = 0; i < len; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff == 0;
}

// ── [4] FNV-1a 32bit ───────────────────────────────────────────────
export function fnv1a32(input: string): u32 {
  const bytes = utf8Encode(input);
  let hash: u32 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}
export function fnv1a32Hex(input: string): string {
  const h = fnv1a32(input);
  const hc = "0123456789abcdef";
  let out = "";
  for (let i = 7; i >= 0; i--) { const nibble = (h >>> (i * 4)) & 0xf; out += hc.charAt(nibble); }
  return out;
}
export function rawFnv1a32(inLen: i32): u32 {
  let hash: u32 = 0x811c9dc5;
  for (let i = 0; i < inLen; i++) {
    hash ^= INPUT_BUF[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ── [5] countOccurrences (raw bytes 직접 비교) ─────────────────────
export function rawCountOccurrences(hLen: i32, nLen: i32): i32 {
  if (nLen == 0 || nLen > hLen) return 0;
  let count = 0, i = 0;
  while (i <= hLen - nLen) {
    let matched = true;
    for (let j = 0; j < nLen; j++) {
      if (INPUT_BUF[i + j] != INPUT_BUF2[j]) { matched = false; break; }
    }
    if (matched) { count++; i += nLen; } else { i++; }
  }
  return count;
}

// ── [6] URL 인코딩 (퍼센트 인코딩) ────────────────────────────────
// Workers 내에서 JS encodeURIComponent 대신 WASM으로 처리
export function rawUrlEncode(inLen: i32): i32 {
  const input = new Uint8Array(inLen);
  for (let i = 0; i < inLen; i++) input[i] = INPUT_BUF[i];
  const h = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < inLen; i++) {
    const b = input[i];
    // 비-예약 문자: A-Z a-z 0-9 - _ . ~
    if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122) ||
        (b >= 48 && b <= 57) || b == 45 || b == 95 || b == 46 || b == 126) {
      out += String.fromCharCode(b);
    } else {
      out += "%" + h.charAt(b >> 4) + h.charAt(b & 0xf);
    }
  }
  return writeOutputUtf8(out);
}

// ── [7] Base64 인코딩/디코딩 ───────────────────────────────────────
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function rawBase64Encode(inLen: i32): i32 {
  let out = "";
  let i = 0;
  while (i < inLen) {
    const b0 = INPUT_BUF[i++];
    const b1 = i < inLen ? INPUT_BUF[i++] : 0;
    const b2 = i < inLen ? INPUT_BUF[i++] : 0;
    out += B64_CHARS.charAt((b0 >> 2) & 0x3f);
    out += B64_CHARS.charAt(((b0 & 0x3) << 4) | (b1 >> 4));
    out += (i - 1 < inLen) ? B64_CHARS.charAt(((b1 & 0xf) << 2) | (b2 >> 6)) : "=";
    out += (i < inLen + 1) ? B64_CHARS.charAt(b2 & 0x3f) : "=";
  }
  return writeOutputUtf8(out);
}

export function wasmVersion(): string { return "bloggerseo-wasm-5.0.0"; }
