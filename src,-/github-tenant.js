// ═══════════════════════════════════════════════════════════════════
// [GitHub Tenant Coordinator] — Durable Objects 완전 대체
//
// 기존 TenantCoordinator(Durable Object)가 메모리에 들고 있던 상태
// (inFlight, consecutiveFailures, circuitOpenUntil, totalRequests,
//  totalRejected)를 GitHub 레포(state/tenants/{hash}.json)에 직접
// 커밋하는 방식으로 대체한다. 요청 1건마다:
//   acquire: GET(state) → 동시성/circuit 판정 → inFlight++ → PUT(state)
//   release: GET(state) → 실패/성공 반영 → PUT(state)
// 를 수행한다(실시간 강결합 — 사용자가 명시적으로 선택한 모드).
//
// [신뢰성 설계]
// - GitHub API 실패/타임아웃/레이트리밋 시 전부 "통과(allowed:true)"로
//   처리해 본 서비스(SEO 프록시)가 절대 막히지 않도록 함. 기존 DO 버전의
//   "TENANT_DO 미바인딩 시 no-op" 철학을 100% 유지.
// - 파일 SHA를 이용한 낙관적 동시성 제어(optimistic concurrency).
//   같은 파일을 두 요청이 동시에 갱신하려 하면 GitHub가 409/422를
//   반환하는데, 이 경우 최대 N회 재시도(지수 백오프+지터)한다.
// - HMAC-SHA256(WASM)으로 state JSON에 서명을 첨부해, 다음 읽기 때
//   레포가 외부에서 변조되지 않았는지 검증한다(보안 연산).
// - 호스트명을 그대로 파일 경로에 쓰지 않고 SHA-256(WASM) 앞 16자로
//   해싱해 경로 인젝션/특수문자/길이 문제를 원천 차단.
// ═══════════════════════════════════════════════════════════════════

const GH_API_BASE = 'https://api.github.com';
const GH_RETRY_MAX = 3;
const GH_RETRY_BASE_MS = 80;
const GH_TIMEOUT_MS = 4000; // 실시간 경로이지만 origin 응답을 무한정 막지 않도록 상한

function ghHeaders(env) {
  const h = new Headers();
  h.set('accept', 'application/vnd.github+json');
  h.set('user-agent', 'bloggerseo-worker');
  h.set('x-github-api-version', '2022-11-28');
  if (env.GITHUB_TOKEN) h.set('authorization', 'Bearer ' + env.GITHUB_TOKEN);
  return h;
}

function ghRepoConfig(env) {
  // owner/repo는 secret/var로 분리 설정 가능. 미설정 시 이 워커가 원래
  // 속한 레포를 기본값으로 사용.
  const owner = env.GITHUB_OWNER || 'choichoi3227-crypto';
  const repo  = env.GITHUB_REPO  || 'bloggerseo';
  const branch = env.GITHUB_BRANCH || 'main';
  return { owner, repo, branch };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitterBackoff(attempt) {
  const base = GH_RETRY_BASE_MS * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * base * 0.5);
}

// 타임아웃이 있는 fetch (AbortController) — origin 응답을 무한정 지연시키지 않음
async function ghFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || GH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// state 파일 경로: state/tenants/{sha256(host)[:16]}.json
async function tenantStatePath(host, wasm) {
  const hash = await wasm.sha256HexShort(host, 16);
  return `state/tenants/${hash}.json`;
}

// GitHub Contents API로 파일 읽기. 없으면 null, 실패하면 throw.
async function ghGetFile(env, path) {
  const { owner, repo, branch } = ghRepoConfig(env);
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`;
  const resp = await ghFetch(url, { headers: ghHeaders(env), cf: { cacheTtl: 0, cacheEverything: false } });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub GET ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  // GitHub Contents API의 content는 base64(줄바꿈 포함)
  const decoded = atob(data.content.replace(/\n/g, ''));
  return { json: decoded, sha: data.sha };
}

// GitHub Contents API로 파일 생성/갱신 (커밋 1회 = API 호출 1회)
async function ghPutFile(env, path, jsonString, sha, message) {
  const { owner, repo, branch } = ghRepoConfig(env);
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const body = {
    message: message || `chore(state): update ${path}`,
    content: btoa(jsonString),
    branch,
  };
  if (sha) body.sha = sha;
  const resp = await ghFetch(url, {
    method: 'PUT',
    headers: { ...Object.fromEntries(ghHeaders(env).entries()), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    const err = new Error(`GitHub PUT ${resp.status}: ${errBody.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function defaultTenantState() {
  return {
    inFlight: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    totalRequests: 0,
    totalRejected: 0,
    updatedAt: Date.now(),
  };
}

// HMAC 서명 첨부/검증 — env.STATE_SIGNING_KEY가 없으면 서명 단계 스킵(통과)
async function signState(env, wasm, stateObj) {
  if (!env.STATE_SIGNING_KEY) return { ...stateObj };
  const payload = JSON.stringify(stateObj);
  const sig = await wasm.hmacSha256Hex(env.STATE_SIGNING_KEY, payload);
  return { ...stateObj, _sig: sig };
}

async function verifyState(env, wasm, parsed) {
  if (!env.STATE_SIGNING_KEY) return true; // 서명 미사용 모드
  if (!parsed || typeof parsed._sig !== 'string') return false;
  const { _sig, ...rest } = parsed;
  const payload = JSON.stringify(rest);
  const expected = await wasm.hmacSha256Hex(env.STATE_SIGNING_KEY, payload);
  return wasm.constantTimeEqual(expected, _sig);
}

// ─────────────────────────────────────────────
// acquire: 동시성 슬롯 확보 + circuit breaker 판정
// 반환: { ok, reason, host, wasm 사용 가능 여부 }
// ─────────────────────────────────────────────
async function githubTenantAcquire(host, env, wasm, metrics) {
  if (!env.GITHUB_TOKEN) return { ok: true, skipped: 'no_token' };

  const path = await tenantStatePath(host, wasm);
  let attempt = 0;
  while (attempt <= GH_RETRY_MAX) {
    try {
      const t0 = Date.now();
      const existing = await ghGetFile(env, path);
      let state = defaultTenantState();
      let sha = null;

      if (existing) {
        sha = existing.sha;
        try {
          const parsed = JSON.parse(existing.json);
          const validSig = await verifyState(env, wasm, parsed);
          if (!validSig) {
            // 서명 불일치 = 외부 변조 가능성 → 안전하게 초기 상태로 리셋
            metrics && metrics.logEvent('tenant_state_signature_mismatch', { host });
            state = defaultTenantState();
          } else {
            const { _sig, ...rest } = parsed;
            state = { ...defaultTenantState(), ...rest };
          }
        } catch (_) {
          state = defaultTenantState();
        }
      }

      const now = Date.now();

      // circuit이 열려 있으면 즉시 거부 (GitHub에 커밋하지 않고 빠르게 반환 —
      // 불필요한 쓰기 API 호출/레이트리밋 소모 방지)
      if (state.circuitOpenUntil > now) {
        return { ok: false, reason: 'circuit_open', retryAfterMs: state.circuitOpenUntil - now };
      }

      const maxConcurrency = Number(env.TENANT_MAX_CONCURRENCY) || 24;
      if (state.inFlight >= maxConcurrency) {
        return { ok: false, reason: 'concurrency_limit' };
      }

      state.inFlight += 1;
      state.totalRequests += 1;
      state.updatedAt = now;

      const signed = await signState(env, wasm, state);
      await ghPutFile(env, path, JSON.stringify(signed), sha, `chore(state): acquire ${host}`);

      metrics && metrics.recordLatency('github_acquire', Date.now() - t0);
      return { ok: true, path, sha: true };
    } catch (e) {
      const status = e && e.status;
      // SHA 충돌(409/422) → 다른 요청이 먼저 커밋함. 재시도.
      if (status === 409 || status === 422) {
        attempt++;
        await sleep(jitterBackoff(attempt));
        continue;
      }
      // 그 외 실패(네트워크, 레이트리밋, 토큰 문제 등) → 서비스 보호 우선,
      // 통과시키고 로그만 남김 (기존 DO degrade-gracefully 철학 유지)
      metrics && metrics.logEvent('tenant_acquire_failed', { host, error: String((e && e.message) || e) });
      return { ok: true, degraded: true, error: String((e && e.message) || e) };
    }
  }
  // 재시도 소진 — 통과 (서비스 보호 우선)
  metrics && metrics.logEvent('tenant_acquire_retry_exhausted', { host });
  return { ok: true, degraded: true };
}

// ─────────────────────────────────────────────
// release: inFlight 감소 + 성공/실패에 따른 circuit breaker 갱신
// ─────────────────────────────────────────────
async function githubTenantRelease(host, success, env, wasm, metrics) {
  if (!env.GITHUB_TOKEN) return;

  const path = await tenantStatePath(host, wasm);
  let attempt = 0;
  while (attempt <= GH_RETRY_MAX) {
    try {
      const existing = await ghGetFile(env, path);
      if (!existing) return; // acquire가 실패/스킵된 상태에서 release만 호출된 경우

      let state = defaultTenantState();
      try {
        const parsed = JSON.parse(existing.json);
        const validSig = await verifyState(env, wasm, parsed);
        const { _sig, ...rest } = parsed;
        state = validSig ? { ...defaultTenantState(), ...rest } : defaultTenantState();
      } catch (_) {}

      state.inFlight = Math.max(0, state.inFlight - 1);

      const threshold = Number(env.TENANT_FAILURE_THRESHOLD) || 5;
      const cooldownMs = Number(env.TENANT_OPEN_COOLDOWN_MS) || 15000;

      if (success) {
        state.consecutiveFailures = 0;
        if (state.circuitOpenUntil > 0) state.circuitOpenUntil = 0;
      } else {
        state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
        if (state.consecutiveFailures >= threshold) {
          state.circuitOpenUntil = Date.now() + cooldownMs;
        }
      }
      if (!success) state.totalRejected = (state.totalRejected || 0); // 카운터 자리 유지(acquire에서 집계)
      state.updatedAt = Date.now();

      const signed = await signState(env, wasm, state);
      await ghPutFile(env, path, JSON.stringify(signed), existing.sha, `chore(state): release ${host} success=${success}`);
      return;
    } catch (e) {
      const status = e && e.status;
      if (status === 409 || status === 422) {
        attempt++;
        await sleep(jitterBackoff(attempt));
        continue;
      }
      metrics && metrics.logEvent('tenant_release_failed', { host, error: String((e && e.message) || e) });
      return; // release 실패는 서비스에 영향 주지 않음 (다음 acquire 시 자연 보정)
    }
  }
}

// ─────────────────────────────────────────────
// status: 디버그 엔드포인트용 현재 상태 조회 (읽기 전용, 커밋 없음)
// ─────────────────────────────────────────────
async function githubTenantStatus(host, env, wasm) {
  if (!env.GITHUB_TOKEN) return { bound: false, mode: 'github-state', reason: 'no_token' };
  try {
    const path = await tenantStatePath(host, wasm);
    const existing = await ghGetFile(env, path);
    if (!existing) return { bound: true, mode: 'github-state', exists: false };
    const parsed = JSON.parse(existing.json);
    const validSig = await verifyState(env, wasm, parsed);
    const { _sig, ...rest } = parsed;
    return { bound: true, mode: 'github-state', exists: true, signatureValid: validSig, ...rest };
  } catch (e) {
    return { bound: true, mode: 'github-state', error: String((e && e.message) || e) };
  }
}

export {
  githubTenantAcquire,
  githubTenantRelease,
  githubTenantStatus,
  tenantStatePath,
  ghRepoConfig,
};
