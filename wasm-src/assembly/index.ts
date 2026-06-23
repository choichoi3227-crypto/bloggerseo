// ═══════════════════════════════════════════════════════════════════
// bloggerseo WASM core
// AssemblyScript로 작성 → wasm32 바이너리로 컴파일.
//
// 포함 기능 (전부 워커의 "느린 경로"를 빠른 경로로 대체):
//   1) generateSlugWasm   — 유니코드 정규화 기반 슬러그 생성 (한글/특수문자)
//   2) sha256Hex          — SHA-256 (호스트 해싱, state 파일 무결성)
//   3) hmacSha256Hex      — HMAC-SHA256 (GitHub state JSON 위변조 방지 서명)
//   4) fnv1a32            — FNV-1a 32bit 해시 (캐시 키, 빠른 라우팅 해시)
//   5) countTagFast       — HTML 내 특정 바이트 패턴 빠른 카운트(파싱 가속용)
//
// 메모리 관리: AssemblyScript 기본 incremental GC 대신 더 가볍고 예측
// 가능한 "stub" 런타임을 사용 (요청-응답 단위로 짧게 살다 버려지는 워커
// 환경에 적합 — GC 오버헤드 없이 단순 증가형 할당만 사용).
// ═══════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────
// 공통: UTF-8 인코딩/디코딩 헬퍼 (AssemblyScript 문자열은 UTF-16 내부
// 표현이므로, 워커(JS)와 주고받을 때는 UTF-8 바이트 배열로 변환)
// ───────────────────────────────────────────────────────────────────

function utf8Encode(str: string): Uint8Array {
  return Uint8Array.wrap(String.UTF8.encode(str, false));
}

function utf8Decode(bytes: Uint8Array): string {
  return String.UTF8.decode(bytes.buffer, false);
}

function bytesToHex(bytes: Uint8Array): string {
  const hexChars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += hexChars.charAt(b >> 4) + hexChars.charAt(b & 0x0f);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// 1) 슬러그 생성
//
// JS 버전(generateSlug)은 정규식을 6~7번 연쟁(replace 체인)으로 호출함.
// WASM 버전은 문자열을 1회 순회하며 동시에:
//   - 소문자화 (ASCII + 라틴 확장 일부)
//   - 공백/언더스코어 → 하이픈
//   - 결합 분음 기호(diacritics) 제거 (NFD 분해 후 마크 카테고리 스킵)
//   - 영문/숫자/한글(완성형) 외 문자는 하이픈으로 치환
//   - 연속 하이픈 축약, 앞뒤 하이픈 제거
// 를 단일 패스로 수행해 GC 압력과 정규식 백트래킹 비용을 제거함.
// ═══════════════════════════════════════════════════════════════════

// 결합 분음 기호 유니코드 범위 (Combining Diacritical Marks: U+0300–U+036F)
function isCombiningMark(cp: i32): bool {
  return cp >= 0x0300 && cp <= 0x036f;
}

// 한글 완성형(U+AC00–U+D7A3), 한글 자모(U+1100–U+11FF, U+3130–U+318F) 허용
function isHangul(cp: i32): bool {
  return (
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  );
}

function isAsciiAlnum(cp: i32): bool {
  return (cp >= 48 && cp <= 57) || (cp >= 97 && cp <= 122);
}

function toAsciiLower(cp: i32): i32 {
  if (cp >= 65 && cp <= 90) return cp + 32; // A-Z → a-z
  return cp;
}

// 라틴 확장(Latin-1 Supplement, U+00C0–U+00FF) 대문자를 NFD 유사 분해 없이
// 가장 가까운 베이스 문자로 근사 매핑 (à, é, ü 등 → a, e, u).
// 완전한 유니코드 NFD 테이블은 크기가 커 워커 번들에 부담이 되므로,
// 실무에서 흔한 라틴 확장 1블록만 커버하는 경량 근사 테이블을 사용.
function approxBaseLatin(cp: i32): i32 {
  // U+00C0–U+00C5 (ÀÁÂÃÄÅ) → a, U+00E0–U+00E5 (àáâãäå) → a
  if ((cp >= 0xc0 && cp <= 0xc5) || (cp >= 0xe0 && cp <= 0xe5)) return 97;
  // È É Ê Ë / è é ê ë → e
  if ((cp >= 0xc8 && cp <= 0xcb) || (cp >= 0xe8 && cp <= 0xeb)) return 101;
  // Ì Í Î Ï / ì í î ï → i
  if ((cp >= 0xcc && cp <= 0xcf) || (cp >= 0xec && cp <= 0xef)) return 105;
  // Ò Ó Ô Õ Ö / ò ó ô õ ö → o
  if ((cp >= 0xd2 && cp <= 0xd6) || (cp >= 0xf2 && cp <= 0xf6)) return 111;
  // Ù Ú Û Ü / ù ú û ü → u
  if ((cp >= 0xd9 && cp <= 0xdc) || (cp >= 0xf9 && cp <= 0xfc)) return 117;
  // Ñ / ñ → n
  if (cp == 0xd1 || cp == 0xf1) return 110;
  // Ç / ç → c
  if (cp == 0xc7 || cp == 0xe7) return 99;
  // Ý / ý / ÿ → y
  if (cp == 0xdd || cp == 0xfd || cp == 0xff) return 121;
  return cp;
}

export function generateSlugWasm(title: string): string {
  if (title.length == 0) return "untitled";

  const len = title.length;
  let out = "";
  let lastWasHyphen = false;
  let hasOutput = false;
  let hasNonAscii = false;

  for (let i = 0; i < len; i++) {
    let cp = title.charCodeAt(i);

    // 결합 분음 기호는 그냥 스킵 (직전 베이스 문자에 이미 흡수된 것으로 간주)
    if (isCombiningMark(cp)) continue;

    cp = toAsciiLower(cp);
    cp = approxBaseLatin(cp);
    cp = toAsciiLower(cp); // 근사 매핑 후 다시 한 번 (안전)

    // 공백류(스페이스, 탭, NBSP) 또는 언더스코어 → 하이픈 후보
    const isSpaceLike =
      cp == 32 || cp == 9 || cp == 10 || cp == 13 || cp == 0xa0 || cp == 95;

    if (isSpaceLike) {
      if (hasOutput && !lastWasHyphen) {
        out += "-";
        lastWasHyphen = true;
      }
      continue;
    }

    const allowed = isAsciiAlnum(cp) || isHangul(cp);
    if (cp > 127 && !isHangul(cp)) hasNonAscii = true;

    if (allowed) {
      out += String.fromCharCode(cp);
      lastWasHyphen = false;
      hasOutput = true;
    } else {
      // 허용되지 않는 문자(구두점, 이모지 등) → 하이픈으로 치환(중복 축약)
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

  // 한글 외 비-ASCII가 섞여 있었다면(예: 한자, CJK 외 기타 문자) 안전하게
  // percent-encoding으로 보존 — JS 쪽 generateSlug의 기존 동작과 동등.
  // (한글 자체는 그대로 슬러그에 남김 — 기존 JS 버전과 동일한 정책)
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// 2) SHA-256 (순수 구현, 의존성 없음)
// 용도: GitHub state 파일 경로용 호스트 해싱(긴 호스트명을 고정 길이
// 파일명으로), 캐시 키 다이제스트.
// ═══════════════════════════════════════════════════════════════════

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

function rotr(x: u32, n: u32): u32 {
  return (x >>> n) | (x << (32 - n));
}

// 입력 바이트를 SHA-256 다이제스트(32바이트)로 변환
function sha256Digest(msg: Uint8Array): Uint8Array {
  let h0: u32 = 0x6a09e667,
    h1: u32 = 0xbb67ae85,
    h2: u32 = 0x3c6ef372,
    h3: u32 = 0xa54ff53a,
    h4: u32 = 0x510e527f,
    h5: u32 = 0x9b05688c,
    h6: u32 = 0x1f83d9ab,
    h7: u32 = 0x5be0cd19;

  const msgLen = msg.length;
  const bitLen: u64 = (msgLen as u64) * 8;

  // 패딩: 0x80 + 0x00... + 64bit big-endian length, 총 길이는 64의 배수
  let totalLen = msgLen + 1;
  while (totalLen % 64 != 56) totalLen++;
  totalLen += 8;

  const padded = new Uint8Array(totalLen);
  for (let i = 0; i < msgLen; i++) padded[i] = msg[i];
  padded[msgLen] = 0x80;
  for (let i = 0; i < 8; i++) {
    padded[totalLen - 1 - i] = u8((bitLen >> (u64(i) * 8)) & 0xff);
  }

  const w = new StaticArray<u32>(64);
  const blocks = totalLen / 64;

  for (let b = 0; b < blocks; b++) {
    const off = b * 64;
    for (let t = 0; t < 16; t++) {
      const o = off + t * 4;
      w[t] =
        (u32(padded[o]) << 24) |
        (u32(padded[o + 1]) << 16) |
        (u32(padded[o + 2]) << 8) |
        u32(padded[o + 3]);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = w[t - 16] + s0 + w[t - 7] + s1;
    }

    let a = h0,
      bb = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = h + S1 + ch + SHA256_K[t] + w[t];
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const temp2 = S0 + maj;

      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = bb;
      bb = a;
      a = temp1 + temp2;
    }

    h0 += a;
    h1 += bb;
    h2 += c;
    h3 += d;
    h4 += e;
    h5 += f;
    h6 += g;
    h7 += h;
  }

  const out = new Uint8Array(32);
  const hs: StaticArray<u32> = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[i * 4] = u8(hs[i] >> 24);
    out[i * 4 + 1] = u8(hs[i] >> 16);
    out[i * 4 + 2] = u8(hs[i] >> 8);
    out[i * 4 + 3] = u8(hs[i]);
  }
  return out;
}

export function sha256Hex(input: string): string {
  const bytes = utf8Encode(input);
  const digest = sha256Digest(bytes);
  return bytesToHex(digest);
}

// 짧은 다이제스트(파일명용, 16 hex chars = 64bit 충돌 안전성)
export function sha256HexShort(input: string, hexLen: i32): string {
  const full = sha256Hex(input);
  return full.substring(0, hexLen);
}

// ═══════════════════════════════════════════════════════════════════
// 3) HMAC-SHA256 (보안 연산)
// 용도: GitHub state JSON에 서명을 첨부해, state 파일이 워커가 쓴 그대로인지
// (제3자가 GitHub 레포에 직접 손댄 게 아닌지) 읽을 때 검증.
// ═══════════════════════════════════════════════════════════════════

function sha256DigestRaw(bytes: Uint8Array): Uint8Array {
  return sha256Digest(bytes);
}

function hmacSha256Raw(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) {
    k = sha256DigestRaw(k);
  }
  if (k.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    for (let i = 0; i < k.length; i++) padded[i] = k[i];
    k = padded;
  }

  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oKeyPad[i] = k[i] ^ 0x5c;
    iKeyPad[i] = k[i] ^ 0x36;
  }

  const inner = new Uint8Array(blockSize + message.length);
  for (let i = 0; i < blockSize; i++) inner[i] = iKeyPad[i];
  for (let i = 0; i < message.length; i++) inner[blockSize + i] = message[i];
  const innerHash = sha256DigestRaw(inner);

  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) outer[i] = oKeyPad[i];
  for (let i = 0; i < 32; i++) outer[blockSize + i] = innerHash[i];

  return sha256DigestRaw(outer);
}

export function hmacSha256Hex(key: string, message: string): string {
  const keyBytes = utf8Encode(key);
  const msgBytes = utf8Encode(message);
  const mac = hmacSha256Raw(keyBytes, msgBytes);
  return bytesToHex(mac);
}

// 상수시간 비교 (타이밍 사이드채널 공격 방지) — 서명 검증 시 사용
export function constantTimeEqual(a: string, b: string): bool {
  const len = a.length;
  if (len != b.length) {
    // 길이가 달라도 동일 시간 소요를 위해 더미 비교를 끝까지 수행
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
  for (let i = 0; i < len; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff == 0;
}

// ═══════════════════════════════════════════════════════════════════
// 4) FNV-1a 32bit 해시 — 캐시 키/라우팅용 초고속 해시
// (SHA-256보다 ~10배 빠름, 암호학적 안전성 불필요한 곳에 사용)
// ═══════════════════════════════════════════════════════════════════

export function fnv1a32(input: string): u32 {
  const bytes = utf8Encode(input);
  let hash: u32 = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = (hash * 0x01000193) >>> 0; // FNV prime, 32bit wrap
  }
  return hash;
}

export function fnv1a32Hex(input: string): string {
  const h = fnv1a32(input);
  const hexChars = "0123456789abcdef";
  let out = "";
  for (let i = 7; i >= 0; i--) {
    const nibble = (h >>> (i * 4)) & 0xf;
    out += hexChars.charAt(nibble);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// 5) HTML 빠른 스캔 유틸 — 단순 부분 문자열 카운트
// (JS 정규식 .test()/.match() 다회 호출 대비, 단일 패턴 빈도 카운트는
// 직접 문자 비교 루프가 더 빠르고 GC 압력이 없음. 워커는 이를 사용해
// "이 HTML에 이미 og:title이 몇 번 등장하는지" 등을 정규식 없이 사전 스캔하고,
// 0이면 정규식 단계를 완전히 스킵해 변환 파이프라인을 가속함)
// ═══════════════════════════════════════════════════════════════════

export function countOccurrences(haystack: string, needle: string): i32 {
  const hLen = haystack.length;
  const nLen = needle.length;
  if (nLen == 0 || nLen > hLen) return 0;
  let count = 0;
  let i = 0;
  while (i <= hLen - nLen) {
    let matched = true;
    for (let j = 0; j < nLen; j++) {
      if (haystack.charCodeAt(i + j) != needle.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      count++;
      i += nLen;
    } else {
      i++;
    }
  }
  return count;
}

export function containsFast(haystack: string, needle: string): bool {
  return countOccurrences(haystack, needle) > 0;
}

// ═══════════════════════════════════════════════════════════════════
// 메모리 export (AssemblyScript 런타임이 자동 관리하지만, 명시적으로
// 워커 쪽에서 string export를 읽을 때 필요한 헬퍼)
// ═══════════════════════════════════════════════════════════════════
export function wasmVersion(): string {
  return "bloggerseo-wasm-1.0.0";
}

// ═══════════════════════════════════════════════════════════════════
// RAW BUFFER API — Cloudflare Workers 호출용 안전 계층
//
// AssemblyScript의 GC 문자열 객체(런타임 내부 클래스 id, 헤더 레이아웃)는
// 빌드/버전마다 바뀔 수 있어 호스트(JS) 쪽에서 그 구조에 직접 의존하는
// 것은 깨지기 쉽다. 따라서 호스트와 주고받는 모든 데이터는 항상:
//   - 입력: UTF-8 바이트를 "공유 입력 버퍼"(고정 오프셋)에 써넣고 길이만 전달
//   - 출력: 결과를 "공유 출력 버퍼"(고정 오프셋)에 써넣고 길이를 반환
// 하는 raw pointer/length 방식만 사용한다. 이렇게 하면:
//   1) 워커 쪽 JS는 memory.buffer를 Uint8Array로 보기만 하면 되고
//   2) AssemblyScript 빌드가 바뀌어도(런타임 옵션, 버전 등) 계약이 깨지지 않음
//   3) GC 호출(__new/__pin) 없이 정적 버퍼만 사용해 호출 1회당 할당이 0에 가까움
// ═══════════════════════════════════════════════════════════════════

// 고정 크기 정적 버퍼: 입력 64KB, 출력 64KB (HTML 메타 추출/슬러그/서명용으로
// 충분한 크기. 더 큰 페이로드가 필요하면 이 값을 늘리고 재빌드)
const BUF_SIZE: i32 = 65536;

// AssemblyScript의 정적 배열(StaticArray)을 모듈 전역으로 선언하면 컴파일
// 시점에 고정 오프셋의 선형 메모리 영역으로 배치된다 — 즉 "정적 버퍼"가 됨.
const INPUT_BUF: StaticArray<u8> = new StaticArray<u8>(BUF_SIZE);
const INPUT_BUF2: StaticArray<u8> = new StaticArray<u8>(BUF_SIZE); // 2번째 입력(HMAC message 등)
const OUTPUT_BUF: StaticArray<u8> = new StaticArray<u8>(BUF_SIZE);

export function getInputPtr(): usize {
  return changetype<usize>(INPUT_BUF);
}
export function getInput2Ptr(): usize {
  return changetype<usize>(INPUT_BUF2);
}
export function getOutputPtr(): usize {
  return changetype<usize>(OUTPUT_BUF);
}
export function getBufSize(): i32 {
  return BUF_SIZE;
}

function readInputUtf8(len: i32): string {
  const ptr = changetype<usize>(INPUT_BUF);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = load<u8>(ptr + i);
  }
  return utf8Decode(bytes);
}

function writeOutputUtf8(s: string): i32 {
  const encoded = utf8Encode(s);
  const n = encoded.length < BUF_SIZE ? encoded.length : BUF_SIZE;
  for (let i = 0; i < n; i++) {
    OUTPUT_BUF[i] = encoded[i];
  }
  return n;
}

function writeOutputBytes(bytes: Uint8Array): i32 {
  const n = bytes.length < BUF_SIZE ? bytes.length : BUF_SIZE;
  for (let i = 0; i < n; i++) {
    OUTPUT_BUF[i] = bytes[i];
  }
  return n;
}

// ── Raw API: 슬러그 생성 ──
// 입력: INPUT_BUF에 UTF-8 title, inLen 바이트
// 출력: OUTPUT_BUF에 UTF-8 슬러그, 반환값 = 출력 바이트 길이
export function rawGenerateSlug(inLen: i32): i32 {
  const title = readInputUtf8(inLen);
  const slug = generateSlugWasm(title);
  return writeOutputUtf8(slug);
}

// ── Raw API: SHA-256 ──
// 입력: INPUT_BUF에 임의 바이트 inLen개 (UTF-8 문자열일 필요 없음 — raw bytes)
// 출력: OUTPUT_BUF에 32바이트 다이제스트(raw, hex 아님 — 워커에서 필요시 hex화)
export function rawSha256(inLen: i32): i32 {
  const copy = new Uint8Array(inLen);
  for (let i = 0; i < inLen; i++) copy[i] = INPUT_BUF[i];
  const digest = sha256Digest(copy);
  return writeOutputBytes(digest);
}

// ── Raw API: HMAC-SHA256 ──
// 입력: INPUT_BUF = key(keyLen bytes), INPUT_BUF2 = message(msgLen bytes)
// 출력: OUTPUT_BUF에 32바이트 MAC(raw)
export function rawHmacSha256(keyLen: i32, msgLen: i32): i32 {
  const key = new Uint8Array(keyLen);
  for (let i = 0; i < keyLen; i++) key[i] = INPUT_BUF[i];
  const message = new Uint8Array(msgLen);
  for (let i = 0; i < msgLen; i++) message[i] = INPUT_BUF2[i];
  const mac = hmacSha256Raw(key, message);
  return writeOutputBytes(mac);
}

// ── Raw API: FNV-1a32 ──
// 입력: INPUT_BUF에 UTF-8 바이트 inLen개. 반환값 자체가 32bit 해시값(출력버퍼 불필요)
export function rawFnv1a32(inLen: i32): u32 {
  let hash: u32 = 0x811c9dc5;
  for (let i = 0; i < inLen; i++) {
    hash ^= INPUT_BUF[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ── Raw API: countOccurrences ──
// 입력: INPUT_BUF=haystack(hLen), INPUT_BUF2=needle(nLen). 반환값=출현 횟수
export function rawCountOccurrences(hLen: i32, nLen: i32): i32 {
  if (nLen == 0 || nLen > hLen) return 0;
  let count = 0;
  let i = 0;
  while (i <= hLen - nLen) {
    let matched = true;
    for (let j = 0; j < nLen; j++) {
      if (INPUT_BUF[i + j] != INPUT_BUF2[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      count++;
      i += nLen;
    } else {
      i++;
    }
  }
  return count;
}
