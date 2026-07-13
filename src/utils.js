/**
 * BloggerSEO v7 — 공용 유틸리티
 */

// ── FNV-1a 32bit ────────────────────────────────────────────────────
export function fnv1a32Hex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= str.length; h = Math.imul(h, 0x01000193);
  return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

// ── HTML 파싱 유틸 ───────────────────────────────────────────────────
export function extractMeta(html, name) {
  const r = escapeRe(name);
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${r}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${r}["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+name=["']${r}["'][^>]+content=["']([^"']+)["']`,    'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${r}["']`,    'i')) || []
  )[1] || '';
}

export function extractTagContent(html, re) {
  return (html.match(re) || ['', ''])[1].trim();
}

// ─────────────────────────────────────────────────────────────────────
// [v13] extractBodyText / buildMetaDescription 은 이제 worker.js의 핫패스
// (extractPageContext)에서 wasmCore.extractBodyText / wasmCore.buildMetaDescription
// (src/wasm-loader.js, WASM 가속 + 내장 JS 폴백)으로 대체되었다. 이 두
// 함수는 외부에서 순수 JS 버전이 별도로 필요한 경우(테스트, 진단 등)를
// 위해 그대로 남겨둔다.
// ─────────────────────────────────────────────────────────────────────
export function extractBodyText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function buildMetaDescription(bodyText, title) {
  let t = title ? bodyText.replace(title, '').trim() : bodyText;
  if (t.length > 160) {
    t = t.slice(0, 160);
    const l = t.lastIndexOf(' ');
    if (l > 100) t = t.slice(0, l);
    t += '…';
  }
  return t;
}

export function extractFirstImage(html) {
  return (html.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || '';
}

export function extractSiteName(html) {
  return extractMeta(html, 'og:site_name') ||
    extractTagContent(html, /<title[^>]*>([^<|]+)/i) || '';
}

export function extractLogoUrl(html) {
  return (
    html.match(/<img[^>]+id=["']Header1_headerimg["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/i) || []
  )[1] || '';
}

export function extractLabels(html) {
  const labels = [], re = /class="label[^"]*"[^>]*>([^<]+)</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const l = m[1].trim();
    if (l && !labels.includes(l)) labels.push(l);
  }
  return labels;
}

export function extractJsonLdDate(html, key) {
  return (html.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i')) || [])[1] || '';
}

export function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 안전 변환 래퍼 ───────────────────────────────────────────────────
export function safeTransform(html, fn) {
  try {
    const out = fn(html);
    return (typeof out === 'string' && out.length > 0) ? out : html;
  } catch (_) { return html; }
}

// ── 지연 유틸 ────────────────────────────────────────────────────────
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 재시도 유틸 ──────────────────────────────────────────────────────
// [v8] 서킷 브레이커와 연동: origin이 이미 열림(open) 상태면 재시도 없이
// 즉시 실패시켜, 힘든 origin에 재시도 요청을 추가로 쏟아붓지 않는다.
// [Error 525 수정] 502/503/504뿐 아니라 Cloudflare가 "origin(=ghs.google.com)과의
// TLS 핸드셰이크/연결 자체"에 실패했을 때 합성하는 520~527 계열 상태 코드도
// 모두 일시적 장애로 간주해 재시도 대상에 포함한다. 이전에는 502/503/504만
// 재시도했기 때문에, ghs.google.com과의 TLS 핸드셰이크가 일시적으로 실패해
// Cloudflare가 525를 반환하면 재시도 한 번 없이 그대로 방문자에게 525가
// 노출됐다. 대부분의 525는 일시적 핸드셰이크 경합(코드 자체 문제가 아니라
// TLS 세션 재사용/커넥션 풀 타이밍 이슈)이라 짧은 backoff 후 재시도만으로도
// 상당수가 복구된다.
const RETRIABLE_ORIGIN_STATUSES = [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530];

export async function retryAsync(fn, maxRetries = 2, baseDelayMs = 60) {
  let lastErr, lastResp;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fn();
      if (resp && !RETRIABLE_ORIGIN_STATUSES.includes(resp.status)) return resp;
      lastResp = resp;
      if (attempt === maxRetries) return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) throw e;
    }
    await sleep(baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs);
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

// ── Origin 서킷 브레이커 (Blogger 과부하/장애 보호) ──────────────────
// 문제: 기존에는 Blogger가 502/503/504를 반환하는 상황(=부하로 힘든 상태)
// 에서도 요청 하나하나가 개별적으로 최대 2회씩 재시도를 했다. 이는 이미
// 죽어가는 origin에 오히려 요청량을 3배로 늘려서 상황을 더 악화시키는
// "재시도 폭풍(retry storm)" 패턴이다. 여기서는 최근 실패율을 인스턴스
// 메모리에서 추적해서, 임계치를 넘으면 일정 시간(OPEN_MS) 동안 재시도를
// 건너뛰고(빠른 실패) 곧바로 stale 캐시 폴백이나 502로 넘어가게 한다.
// → Blogger 입장에서는 불필요한 재시도 트래픽이 줄어 회복이 빨라지고,
//   사용자 입장에서는 무의미하게 대기하는 시간(재시도 지연 누적)이 사라져
//   체감 속도도 함께 개선된다.
const _circuit = { failures: 0, openedAt: 0 };
const CIRCUIT_FAIL_THRESHOLD = 8;   // 최근 실패 8회 누적 시 open
const CIRCUIT_OPEN_MS        = 5_000; // 5초간 재시도 억제 후 half-open으로 재시도 허용
const CIRCUIT_DECAY_MS       = 30_000; // 실패 카운트가 30초 이상 안 늘면 리셋

export function circuitIsOpen() {
  if (_circuit.openedAt === 0) return false;
  if (Date.now() - _circuit.openedAt > CIRCUIT_OPEN_MS) {
    // half-open: 다음 한 번은 통과시켜서 origin 회복 여부를 탐침
    _circuit.openedAt = 0;
    _circuit.failures = Math.floor(CIRCUIT_FAIL_THRESHOLD / 2);
    return false;
  }
  return true;
}

export function circuitRecordResult(ok) {
  const now = Date.now();
  if (ok) {
    _circuit.failures = 0;
    _circuit.openedAt = 0;
    return;
  }
  if (_circuit._lastFailAt && now - _circuit._lastFailAt > CIRCUIT_DECAY_MS) {
    _circuit.failures = 0; // 한동안 실패가 없었다면 카운트 리셋
  }
  _circuit._lastFailAt = now;
  _circuit.failures++;
  if (_circuit.failures >= CIRCUIT_FAIL_THRESHOLD && _circuit.openedAt === 0) {
    _circuit.openedAt = now;
  }
}

export function circuitStatus() {
  return {
    open: circuitIsOpen(),
    failures: _circuit.failures,
    openedAt: _circuit.openedAt || null,
  };
}

// origin fetch 전용 래퍼: 서킷이 열려 있으면 재시도 없이 즉시 실패시켜
// 호출부(worker.js)가 곧바로 stale 캐시 폴백/502로 넘어가게 한다.
export async function retryOriginFetch(fn, maxRetries = 2, baseDelayMs = 60) {
  if (circuitIsOpen()) {
    const err = new Error('circuit-open: origin recently failing, skipping retries');
    err.circuitOpen = true;
    throw err;
  }
  try {
    const resp = await retryAsync(fn, maxRetries, baseDelayMs);
    circuitRecordResult(!(resp && resp.status >= 500));
    return resp;
  } catch (e) {
    circuitRecordResult(false);
    throw e;
  }
}
