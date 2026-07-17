/**
 * BloggerSEO v14 — 저장소 압축 헬퍼 (gzip, CompressionStream)
 * ─────────────────────────────────────────────────────────────────────
 * redis-do.js(DO SQLite 저장)에서 사용하는 압축 인코딩/디코딩을 별도
 * 모듈로 분리했다. 이 파일은 'cloudflare:workers'를 import하지 않으므로
 * Workers 런타임 밖(Node 테스트 러너 등)에서도 독립적으로 단위 테스트할
 * 수 있다 — CompressionStream/DecompressionStream(gzip)과 btoa/atob는
 * Node 18+에도 전역으로 존재하는 표준 Web API라 동작이 동일하다.
 *
 * 목표(요청사항 1번): "기존 크기의 최소 70%로 압축" — 저장 바이트 수를
 * 원본의 70% 이하로 줄인다(=최소 30% 절감). HTML/JSON처럼 반복 패턴이
 * 많은 텍스트는 gzip으로 대개 70~85%까지 줄어드는 경우가 흔하지만,
 * 이미 압축된 바이너리나 매우 짧은 값은 이득이 적거나 오히려 늘어날 수
 * 있다. 그래서 "압축했을 때 실제로 더 작아지는 경우에만" 압축본을
 * 저장하는 적응형 방식을 쓴다 — 어떤 입력에도 저장 크기가 원본보다
 * 커지는 회귀는 없다.
 *
 * 저장 포맷(문자열 값 자체의 접두사를 포맷 태그로 사용):
 *   'z:' + base64(gzip(원본 문자열))  → 압축 저장
 *   원본 문자열 그대로                 → 비압축 저장(기존 데이터와 100%
 *                                       호환 — 마이그레이션 불필요)
 */

export const GZIP_PREFIX = 'z:';
// 이 바이트 수 미만은 gzip 오버헤드(gzip 헤더/트레일러 ~20바이트) 대비
// 이득이 거의 없거나 손해이므로 압축을 시도하지 않는다.
export const GZIP_MIN_BYTES = 96;

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzipCompress(str) {
  const enc = new TextEncoder();
  const input = enc.encode(str);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gzipDecompress(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  return new TextDecoder().decode(decompressed);
}

// 저장 직전 호출: 압축이 실제로 더 작을 때만 'z:' 접두사 포맷으로 반환.
export async function encodeForStorage(str) {
  if (typeof str !== 'string' || str.length < GZIP_MIN_BYTES) return str;
  try {
    const compressed = await gzipCompress(str);
    const encoded = GZIP_PREFIX + bytesToBase64(compressed);
    // base64는 원본 바이트보다 ~33% 커지므로, gzip 이득이 base64 오버헤드를
    // 넘어설 때만 채택한다. 그렇지 않으면 원본 문자열 그대로 저장.
    return encoded.length < str.length ? encoded : str;
  } catch (_) {
    return str; // 압축 실패 시 항상 안전한 비압축 경로로 폴백
  }
}

// 조회 직후 호출: 'z:' 접두사면 압축 해제, 아니면(압축 이전 데이터 포함) 그대로 반환.
export async function decodeFromStorage(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(GZIP_PREFIX)) return stored;
  try {
    const bytes = base64ToBytes(stored.slice(GZIP_PREFIX.length));
    return await gzipDecompress(bytes);
  } catch (_) {
    // 손상/압축 해제 실패 — 호출부의 JSON.parse가 실패하면 자동 치유
    // 경로(해당 키 삭제)를 타도록 원본 그대로 반환한다.
    return stored;
  }
}
