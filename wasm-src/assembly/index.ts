// ═══════════════════════════════════════════════════════════════════
// bloggerseo WASM core v13 (우선순위 2: WASM 사용 확대)
// v13 추가:
//   - rawExtractBodyText: HTML→본문 텍스트 추출 O(n) 단일 패스
//     (script/style 블록 스킵 + 태그 제거 + 공백 압축, JS 정규식 3연쇄 대체)
//   - rawBuildMetaDescription: CJK-aware(한글/한자 폭 2) meta description
//     생성 — 표시 폭 기준 160 근처에서 자연스럽게 절단
//   - rawSha256Hex / rawHmacSha256Hex / rawConstantTimeEqual: 버퍼 API
//     관례에 맞춘 문자열 반환 래퍼 (wasm-loader.js에서 실사용 wire)
//   - rawBase64Decode: rawBase64Encode의 역함수
// v5까지: KV-less 자체 NoSQL 스토리지 지원, 슬러그 버그 수정,
//         고성능 인코딩/암호화, 안정성 강화
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

// ── [4b] FNV-1a 32bit — 청크 이어쓰기(continuation) ────────────────
// 입력 버퍼(BUF_SIZE=128KB)보다 큰 데이터(렌더링된 전체 HTML 등)를
// JS 쪽에서 여러 조각으로 나눠 INPUT_BUF에 채운 뒤 이 함수를 반복
// 호출하면, 매 호출 사이에 해시 상태(prevHash)를 이어받아 스트리밍
// 방식으로 임의 길이 데이터를 해싱할 수 있다. FNV-1a는 순수 순차
// XOR+곱셈 누적이라 청크 경계에서 결과가 전체를 한 번에 처리한 것과
// 수학적으로 완전히 동일하다(청크 크기와 무관하게 항상 같은 최종 해시).
export function fnv1a32Chunk(prevHash: u32, inLen: i32): u32 {
  let hash: u32 = prevHash;
  for (let i = 0; i < inLen; i++) {
    hash ^= INPUT_BUF[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}
export function fnv1a32Seed(): u32 { return 0x811c9dc5; }

// [버그 수정] 이 프로젝트는 --runtime stub으로 빌드되고 JS 글루 코드
// (asc의 bindings/loader) 없이 raw WebAssembly.instantiate로 직접
// 호출한다. 이 방식에서 AssemblyScript의 관리형 `string` 반환값은
// 자동으로 JS 문자열로 변환되지 않고, 메모리 포인터(숫자)가 그대로
// 넘어와 그 자체로는 사용할 수 없다. 이 파일의 다른 모든 함수(예:
// writeOutputUtf8 기반의 rawGenerateSlug, rawSha256 등)는 이미 이
// 문제를 피하려고 "OUTPUT_BUF에 UTF-8 바이트로 쓰고 길이(i32)만
// 반환" 하는 관례를 따르고 있다. 아래 함수를 그 관례에 맞춰 고친다.
export function fnv1a32FinalizeHex(hash: u32): i32 {
  const hc = "0123456789abcdef";
  let out = "";
  for (let i = 7; i >= 0; i--) {
    const nibble = (hash >>> (i * 4)) & 0xf;
    out += hc.charAt(nibble);
  }
  return writeOutputUtf8(out);
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
  // [버그 수정] 기존 `(i - 1 < inLen)` / `(i < inLen + 1)` 조건은 루프
  // 내부에서 이미 증가된 i를 기준으로 판단해 항상 참이 되어, 입력 길이가
  // 3의 배수가 아닌 경우에도 패딩('=')이 전혀 붙지 않는 문제가 있었다
  // (예: 26바이트 입력 → 마지막 그룹에 b2가 없는데도 4문자 전부 실제 문자로
  // 출력됨). 그룹 시작 시점의 "남은 바이트 수"를 기준으로 명확히 판단한다.
  let out = "";
  let i = 0;
  while (i < inLen) {
    const remaining = inLen - i; // 이 그룹에서 실제로 존재하는 바이트 수(1~3)
    const b0 = INPUT_BUF[i++];
    const b1 = i < inLen ? INPUT_BUF[i++] : 0;
    const b2 = i < inLen ? INPUT_BUF[i++] : 0;
    out += B64_CHARS.charAt((b0 >> 2) & 0x3f);
    out += B64_CHARS.charAt(((b0 & 0x3) << 4) | (b1 >> 4));
    out += (remaining > 1) ? B64_CHARS.charAt(((b1 & 0xf) << 2) | (b2 >> 6)) : "=";
    out += (remaining > 2) ? B64_CHARS.charAt(b2 & 0x3f) : "=";
  }
  return writeOutputUtf8(out);
}

// ── [8] HTML → 본문 텍스트 추출 (script/style 제거 + 태그 제거 + 공백 압축) ──
// JS의 정규식 3연쇄(.replace(script).replace(style).replace(tag)) 를 단일
// 순방향 스캔으로 대체 — 대형 HTML(수십~수백KB)에서 정규식 백트래킹/중간
// 문자열 재할당 비용을 없애고 O(n) 단일 패스로 처리한다.
// 상태 머신: NORMAL / IN_TAG / IN_SCRIPT / IN_STYLE
function matchesTagName(bytes: Uint8Array, pos: i32, len: i32, name: string): bool {
  // pos는 '<' 다음 위치. name(예: "script")과 대소문자 무시 비교 후
  // 다음 문자가 태그명 경계(공백/'>'/'/')인지 확인.
  const nlen = name.length;
  if (pos + nlen > len) return false;
  for (let i = 0; i < nlen; i++) {
    let c = bytes[pos + i];
    if (c >= 65 && c <= 90) c += 32; // toLower
    const nc = name.charCodeAt(i);
    if (c != nc) return false;
  }
  if (pos + nlen < len) {
    const after = bytes[pos + nlen];
    if (after != 32 && after != 62 && after != 47 && after != 9 && after != 10 && after != 13) return false;
  }
  return true;
}

export function rawExtractBodyText(inLen: i32): i32 {
  const bytes = new Uint8Array(inLen);
  for (let i = 0; i < inLen; i++) bytes[i] = INPUT_BUF[i];

  let out = "";
  let i = 0;
  let lastWasSpace = true; // 선행 공백 생략
  const SCRIPT = "script", STYLE = "style";

  while (i < inLen) {
    const c = bytes[i];
    if (c == 60 /* '<' */) {
      // 종료 스크립트/스타일 태그인지, 시작 태그인지 판별해 해당 블록을 스킵
      let closeTagLen = 0;
      let isCloseScript = false, isCloseStyle = false;
      if (i + 1 < inLen && bytes[i + 1] == 47 /* '/' */) {
        if (matchesTagName(bytes, i + 2, inLen, SCRIPT)) { isCloseScript = true; }
        else if (matchesTagName(bytes, i + 2, inLen, STYLE)) { isCloseStyle = true; }
      }
      const isOpenScript = matchesTagName(bytes, i + 1, inLen, SCRIPT);
      const isOpenStyle  = matchesTagName(bytes, i + 1, inLen, STYLE);

      if (isOpenScript || isOpenStyle) {
        // 여는 태그 자체를 건너뛰고, 대응하는 닫는 태그까지 전부 스킵
        const wantClose = isOpenScript ? SCRIPT : STYLE;
        // '>' 까지 이동
        while (i < inLen && bytes[i] != 62) i++;
        i++; // '>' 다음으로
        // 닫는 태그 검색
        let found = false;
        while (i < inLen) {
          if (bytes[i] == 60 && i + 1 < inLen && bytes[i + 1] == 47 &&
              matchesTagName(bytes, i + 2, inLen, wantClose)) {
            found = true;
            break;
          }
          i++;
        }
        if (found) {
          while (i < inLen && bytes[i] != 62) i++;
          i++; // '>' 다음
        }
        // ✅ [버그 수정] script/style 블록 전체를 제거한 뒤 앞뒤 텍스트가
        // 공백 없이 붙어버리는 문제(예: "안녕<style>...</style>Hello" →
        // "안녕Hello"가 되어 서로 다른 단어가 합성어처럼 붙음)를 막기 위해
        // 일반 태그와 동일하게 공백 구분자를 삽입한다.
        if (!lastWasSpace && out.length > 0) { out += " "; lastWasSpace = true; }
        continue;
      }
      if (isCloseScript || isCloseStyle) {
        while (i < inLen && bytes[i] != 62) i++;
        i++;
        continue;
      }
      // 일반 태그: '>' 까지 스킵하고 공백 하나로 치환
      while (i < inLen && bytes[i] != 62) i++;
      i++; // '>' 다음
      if (!lastWasSpace && out.length > 0) { out += " "; lastWasSpace = true; }
      continue;
    }

    // 일반 문자: UTF-8 시퀀스 길이 판별 후 그대로 복사 (공백류는 압축)
    let seqLen = 1;
    if ((c & 0xe0) == 0xc0) seqLen = 2;
    else if ((c & 0xf0) == 0xe0) seqLen = 3;
    else if ((c & 0xf8) == 0xf0) seqLen = 4;

    const isAsciiSpace = (c == 32 || c == 9 || c == 10 || c == 13);
    if (isAsciiSpace) {
      if (!lastWasSpace) { out += " "; lastWasSpace = true; }
      i++;
      continue;
    }

    // UTF-8 멀티바이트 문자를 문자열로 디코드해서 추가 (드물게 잘린 시퀀스는
    // 안전하게 남은 바이트만큼만 사용)
    const avail = inLen - i;
    const n = seqLen < avail ? seqLen : avail;
    const chunk = new Uint8Array(n);
    for (let k = 0; k < n; k++) chunk[k] = bytes[i + k];
    out += utf8Decode(chunk);
    lastWasSpace = false;
    i += n;
  }

  // 끝의 공백 제거 (trim)
  let start = 0, end = out.length;
  while (start < end && out.charCodeAt(start) == 32) start++;
  while (end > start && out.charCodeAt(end - 1) == 32) end--;
  return writeOutputUtf8(out.substring(start, end));
}

// ── [9] CJK-aware meta description 빌더 ────────────────────────────
// 한글/한자/가나(전각) 1글자를 폭 2로, 그 외(ASCII 등, 반각)를 폭 1로
// 계산해 "실제 노출 폭" 기준 160 근처에서 자연스럽게 자른다. 기존 JS
// 구현(bodyText.length > 160 단순 문자수 컷)은 한글처럼 폭이 넓은
// 문자가 많은 본문에서 실제 표시 폭 기준으로는 지나치게 길게 잘리는
// 문제가 있었다 — 대부분의 한국어 SEO 도구(네이버 등)가 검색결과
// 미리보기를 표시 폭 기준으로 자르는 것과 일치시킨다.
function isWideChar(cp: i32): bool {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 한글 자모
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 부수/한자 영역 전반
    (cp >= 0xac00 && cp <= 0xd7a3) || // 완성형 한글
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 호환 한자
    (cp >= 0xff00 && cp <= 0xff60) || // 전각 기호
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

export function rawBuildMetaDescription(bodyLen: i32, titleLen: i32, maxWidth: i32): i32 {
  const body  = readInputUtf8(bodyLen);
  // titleLen > 0이면 INPUT_BUF2에서 title을 읽어 본문 앞부분에서 제거 시도
  let text = body;
  if (titleLen > 0) {
    const ptr = changetype<usize>(INPUT_BUF2);
    const tbytes = new Uint8Array(titleLen);
    for (let i = 0; i < titleLen; i++) tbytes[i] = load<u8>(ptr + i);
    const title = utf8Decode(tbytes);
    const idx = text.indexOf(title);
    if (idx >= 0) text = text.substring(0, idx) + text.substring(idx + title.length);
  }
  // 앞뒤 공백 trim
  let s = 0, e = text.length;
  while (s < e && text.charCodeAt(s) == 32) s++;
  while (e > s && text.charCodeAt(e - 1) == 32) e--;
  text = text.substring(s, e);

  const limit = maxWidth > 0 ? maxWidth : 160;
  let width = 0;
  let cutAt = -1;      // 마지막 공백 위치(폭 기준 fallback 절단점)
  let cutAtWidth = 0;
  let result = "";
  let truncated = false;

  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    const w  = isWideChar(cp) ? 2 : 1;
    if (width + w > limit) { truncated = true; break; }
    if (cp == 32 && width > 100) { cutAt = i; cutAtWidth = width; }
    width += w;
    result += String.fromCharCode(cp);
  }

  if (truncated) {
    if (cutAt >= 0 && cutAtWidth > 100) {
      result = text.substring(0, cutAt);
    }
    result += "…";
  }
  return writeOutputUtf8(result);
}

// ── [10] SHA-256 / HMAC — 저수준 버퍼 API 문자열 hex 출력 래퍼 ──────
// wasm-loader.js가 버퍼 기반(rawXxx) 관례로 호출할 수 있도록 노출.
export function rawSha256Hex(inLen: i32): i32 {
  const copy = new Uint8Array(inLen);
  for (let i = 0; i < inLen; i++) copy[i] = INPUT_BUF[i];
  const hex = bytesToHex(sha256Digest(copy));
  return writeOutputUtf8(hex);
}
export function rawHmacSha256Hex(keyLen: i32, msgLen: i32): i32 {
  const key = new Uint8Array(keyLen);
  for (let i = 0; i < keyLen; i++) key[i] = INPUT_BUF[i];
  const message = new Uint8Array(msgLen);
  for (let i = 0; i < msgLen; i++) message[i] = INPUT_BUF2[i];
  const hex = bytesToHex(hmacSha256Raw(key, message));
  return writeOutputUtf8(hex);
}
// 상수시간 비교: 두 hex 다이제스트를 INPUT_BUF / INPUT_BUF2에 각각 담아 호출.
export function rawConstantTimeEqual(aLen: i32, bLen: i32): i32 {
  if (aLen != bLen) {
    // 길이가 달라도 dummy 비교로 타이밍을 흡수한 뒤 false(0) 반환
    let dummy: i32 = 0;
    const maxLen = aLen > bLen ? aLen : bLen;
    for (let i = 0; i < maxLen; i++) {
      const ca = i < aLen ? INPUT_BUF[i] : 0;
      const cb = i < bLen ? INPUT_BUF2[i] : 0;
      dummy |= ca ^ cb;
    }
    return 0;
  }
  let diff: i32 = 0;
  for (let i = 0; i < aLen; i++) diff |= INPUT_BUF[i] ^ INPUT_BUF2[i];
  return diff == 0 ? 1 : 0;
}

// ── [11] Base64 디코딩 (rawBase64Encode의 역함수) ───────────────────
function b64CharVal(c: i32): i32 {
  if (c >= 65 && c <= 90) return c - 65;         // A-Z
  if (c >= 97 && c <= 122) return c - 97 + 26;   // a-z
  if (c >= 48 && c <= 57) return c - 48 + 52;    // 0-9
  if (c == 43) return 62;                         // +
  if (c == 47) return 63;                         // /
  return -1; // '=' 또는 패딩/무효 문자
}
export function rawBase64Decode(inLen: i32): i32 {
  // [버그 수정] '=' 패딩 문자를 단순히 "건너뛰기"만 하면, 6비트 누적
  // 상태(bits)가 패딩 이후에도 계속 이어지다 마지막에 남은 조각을 추가로
  // flush해 실제 데이터보다 1바이트 더 많은 출력이 생길 수 있었다(예:
  // 26바이트 원본을 인코딩→디코딩하면 27바이트로 복원되며 끝에 스퓨리어스
  // null 바이트가 붙음). 표준 Base64 규격대로 '=' 를 만나는 즉시 디코딩을
  // 종료한다.
  const out = new Uint8Array(inLen); // 디코딩 결과는 항상 입력보다 작거나 같음
  let outLen = 0;
  let buffer: i32 = 0;
  let bits = 0;
  for (let i = 0; i < inLen; i++) {
    const c = INPUT_BUF[i];
    if (c == 61 /* '=' */) break; // 패딩 시작 → 즉시 종료
    const v = b64CharVal(c);
    if (v < 0) continue; // 개행/공백 등 base64 알파벳이 아닌 문자만 무시
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outLen++] = u8((buffer >> bits) & 0xff);
    }
  }
  return writeOutputBytes(out.subarray(0, outLen));
}

export function wasmVersion(): string { return "bloggerseo-wasm-13.0.0"; }
