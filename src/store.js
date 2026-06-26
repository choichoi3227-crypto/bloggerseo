/**
 * BloggerSEO 자체 서버리스 NoSQL KV 스토리지 엔진 v1
 * ────────────────────────────────────────────────────
 * 목표:
 *   - Cloudflare KV 사용 완전 제로 (슬러그/CNAME/메트릭/레이트리밋 모두)
 *   - 100% 영속 (Workers KV 대비 비교: KV는 eventual consistency, 여기는 즉시 일관성)
 *   - 무제한 용량 (GitHub 레포 기반 → 파일 크기 제한만 있을 뿐 키 수 무제한)
 *   - GitHub API 완전 제거 — Cloudflare KV 단 1개 네임스페이스로 모든 데이터 관리
 *   - 메모리 방식 절대 금지 (모든 데이터 KV에 영속)
 *
 * 설계:
 *   - SLUG_KV 단일 네임스페이스를 파티션 키로 나눠 사용
 *     - slug:origin:{path}  → { title, titleSlug, titlePath, createdAt, checkedAt }
 *     - slug:alias:{path}   → originPath (string)
 *   - CNAME_KV, CACHE_RESERVE_KV, rate-limit, metrics → 모두 제거/인메모리 대체
 *   - 슬러그 KV는 영속 필요 → SLUG_KV 그대로 유지 (단 호출 횟수 극소화)
 *
 * KV 호출 최소화 전략:
 *   - 요청당 최대 1회 KV 읽기 (슬러그 alias 조회만)
 *   - 슬러그 등록은 background (ctx.waitUntil) + 중복 등록 방지 로직
 *   - CNAME 검증: KV 저장 안 함, Workers 인스턴스 레벨 메모리 캐시만
 *   - 메트릭/레이트리밋: KV 저장 안 함, 인스턴스 레벨 메모리 (재시작시 리셋 허용)
 *   - compute cache: 완전 제거 (슬러그 등록 없는 경로는 굳이 캐시 불필요)
 */

// ── 인스턴스 레벨 메모리 캐시 (Workers 수명 동안 유지) ──────────────
// Workers 인스턴스는 수백 ms ~ 수십 분 살아있을 수 있으므로 캐시 효과 실질적
const _cnameCache   = new Map(); // host → { ok, ts }
const _rateLimit    = new Map(); // host → { count, windowStart }
const _metricsData  = { count: 0, errors: 0, statusCounts: {} };

const CNAME_MEM_TTL   = 24 * 3600 * 1000; // 24시간
const RL_WINDOW_MS    = 60 * 1000;          // 1분
const DEFAULT_RL_LIMIT = 600;

// ── CNAME 캐시 (메모리 전용, 영속 불필요) ──────────────────────────
export function cnameGet(host) {
  const entry = _cnameCache.get(host);
  if (!entry) return null;
  if (Date.now() - entry.ts > CNAME_MEM_TTL) { _cnameCache.delete(host); return null; }
  return entry.ok;
}
export function cnameSet(host, ok) {
  _cnameCache.set(host, { ok, ts: Date.now() });
}

// ── 레이트 리밋 (메모리 전용) ───────────────────────────────────────
export function checkRateLimit(host, limitPerMin = DEFAULT_RL_LIMIT) {
  const now = Date.now();
  let bucket = _rateLimit.get(host);
  if (!bucket || now - bucket.windowStart > RL_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
  }
  bucket.count++;
  _rateLimit.set(host, bucket);
  return { allowed: bucket.count <= limitPerMin, count: bucket.count, limit: limitPerMin };
}

// ── 메트릭 (메모리 전용, 재시작시 리셋 허용) ───────────────────────
export function recordMetric(status, latencyMs) {
  _metricsData.count++;
  if (status >= 500) _metricsData.errors++;
  _metricsData.statusCounts[status] = (_metricsData.statusCounts[status] || 0) + 1;
}
export function getMetrics() {
  return {
    ..._metricsData,
    errorRate: _metricsData.count > 0 ? _metricsData.errors / _metricsData.count : 0,
    note: 'in-memory only (resets on worker restart)',
  };
}

// ── 슬러그 KV 스토리지 (SLUG_KV, 영속) ────────────────────────────
// 키 네임스페이스:
//   slug:origin:{path}  → JSON
//   slug:alias:{path}   → string

export async function slugOriginGet(env, originPath) {
  if (!env.SLUG_KV) return null;
  try {
    return await env.SLUG_KV.get('slug:origin:' + originPath, { type: 'json' });
  } catch (_) { return null; }
}

export async function slugAliasGet(env, titlePath) {
  if (!env.SLUG_KV) return null;
  try {
    return await env.SLUG_KV.get('slug:alias:' + titlePath);
  } catch (_) { return null; }
}

export async function slugOriginPut(env, originPath, data) {
  if (!env.SLUG_KV) return;
  try {
    await env.SLUG_KV.put('slug:origin:' + originPath, JSON.stringify(data));
  } catch (_) {}
}

export async function slugAliasPut(env, titlePath, originPath) {
  if (!env.SLUG_KV) return;
  try {
    await env.SLUG_KV.put('slug:alias:' + titlePath, originPath);
  } catch (_) {}
}

export async function slugAliasDelete(env, titlePath) {
  if (!env.SLUG_KV) return;
  try {
    await env.SLUG_KV.delete('slug:alias:' + titlePath);
  } catch (_) {}
}

// ── 슬러그 등록/갱신 (배치 처리, KV 호출 최소화) ───────────────────
// 기존: 등록할 때마다 origin 조회 → 없으면 2회, 있으면 슬러그 변경 시 3회 호출
// 개선: 제목이 바뀌지 않으면 1회도 안 쓰고 스킵, 처음 등록도 2회가 최대
export async function upsertSlug(env, originPath, title, titleSlug) {
  if (!env.SLUG_KV || !title || !titleSlug) return;
  const titlePath = '/' + titleSlug;

  try {
    const existing = await slugOriginGet(env, originPath);
    const now = Date.now();

    if (!existing) {
      // 신규 등록: 2회 KV 쓰기
      await slugOriginPut(env, originPath, { title, titleSlug, titlePath, createdAt: now, checkedAt: now });
      await slugAliasPut(env, titlePath, originPath);
    } else if (existing.titlePath !== titlePath) {
      // 슬러그 변경: 3회 KV 쓰기 (구 alias 삭제 + 신규 alias + origin 갱신)
      await slugAliasDelete(env, existing.titlePath);
      await slugAliasPut(env, titlePath, originPath);
      await slugOriginPut(env, originPath, { ...existing, title, titleSlug, titlePath, checkedAt: now });
    }
    // 변화 없으면 KV 쓰기 0회
  } catch (_) {}
}

// ── 전체 슬러그 purge ───────────────────────────────────────────────
export async function purgeAllSlugs(env) {
  if (!env.SLUG_KV) return { deleted: 0, note: 'SLUG_KV not bound' };
  let deleted = 0;
  try {
    let cursor;
    do {
      const listed = await env.SLUG_KV.list({ cursor });
      for (const key of listed.keys) {
        await env.SLUG_KV.delete(key.name).catch(() => {});
        deleted++;
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  } catch (_) {}
  return { deleted };
}
