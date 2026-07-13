/**
 * BloggerSEO 인프라 모듈 v5 (경량화)
 * v5 변경: KV 의존 완전 제거 (레이트리밋/메트릭/로깅 모두 store.js로 이전)
 *          fetchWithRetry + LocalSemaphore + connectionOptimizedCf만 유지
 *          (worker.js에서 직접 쓰는 항목 — 하위 호환 유지를 위해 export 유지)
 */

// ─── 재시도 + 지수 백오프 + 지터 ─────────────────────────────────
export async function fetchWithRetry(fetchFn, options) {
  const maxRetries = (options && options.maxRetries) != null ? options.maxRetries : 2;
  const baseDelayMs = (options && options.baseDelayMs) != null ? options.baseDelayMs : 60;
  const retryableStatuses = (options && options.retryableStatuses) || [502, 503, 504];
  const onRetry = options && options.onRetry;

  let lastErr = null, lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchFn();
      if (resp && !retryableStatuses.includes(resp.status)) return resp;
      lastResp = resp;
      if (attempt === maxRetries) return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) throw e;
    }
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * baseDelayMs);
    if (onRetry) onRetry(attempt, delay, lastErr || (lastResp && lastResp.status));
    await new Promise(r => setTimeout(r, delay));
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

// ─── 동시성 게이트 ────────────────────────────────────────────────
export class LocalSemaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

// ─── 커넥션 최적화 ─────────────────────────────────────────────────
// ⚠️ [정리] 현재 이 함수는 worker.js/src/*.js 어디에서도 호출되지 않는
// 미사용(대기) 상태다. http3:true는 v13에서 제거했다 — 실제 사용되는
// bloggerFetch/argoBuildFetchOptions 경로에서 QUIC 협상 불안정성으로
// SSL handshake 실패를 유발할 수 있어 제거한 것과 동일한 이유로,
// 나중에 이 헬퍼를 실제로 연결할 때도 같은 값을 물려주지 않도록 한다.
export function connectionOptimizedCf(baseCf) {
  return { ...baseCf };
}

// ─── 구조화 로깅 (KV 없이 console만) ─────────────────────────────
export function structuredLog(level, event, fields) {
  try {
    const entry = { ts: new Date().toISOString(), level, event, ...fields };
    (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
  } catch (_) {}
}
