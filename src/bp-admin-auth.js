/**
 * bp-admin 인증 모듈
 * ─────────────────────────────────────────────────────────────────────
 * /bp-admin 관리자 화면의 로그인/세션을 담당한다. 기존 /panel의 단일
 * PANEL_SECRET(공유 시크릿 하나로 전체 인증) 방식과 달리, 아이디+비밀번호
 * 기반 계정 시스템 + 서명된 세션 쿠키를 사용한다. 이유:
 *   - /bp-admin은 실제 콘텐츠 편집(글쓰기/발행) 권한을 다루므로 URL 쿼리
 *     파라미터(?secret=...)로 인증정보가 새는 기존 방식은 부적절하다.
 *   - 여러 운영자(owner/editor)를 구분해야 할 가능성을 고려해 계정 단위로
 *     설계한다.
 *
 * 저장 위치: 기존 src/store.js의 KV 헬퍼(kvGetJson/kvSetJson)를 그대로
 * 재사용한다 — 별도 D1 스키마를 새로 추가하지 않고 기존 5단계 폴백
 * (DO Redis → KV → Upstash → L1 → L4) 스토리지 엔진에 얹는다.
 *
 * 키 스킴:
 *   bpadmin:user:{username}        → { username, passwordHash, salt, role, createdAt }
 *   bpadmin:session:{sessionId}    → { username, role, createdAt, expiresAt }
 *
 * 비밀번호 해싱: HMAC-SHA256을 8,000회 반복하는 자체 KDF(streched HMAC).
 * Workers 런타임은 Node의 crypto.pbkdf2를 직접 쓸 수 없고, WebCrypto의
 * PBKDF2는 사용 가능하지만 이미 프로젝트 전역에서 wasmCore.hmacSha256Hex
 * (WASM 가속)를 인프라로 채택했으므로 동일 계열 프리미티브로 통일한다.
 * 매 반복마다 이전 출력 + salt를 다시 키로 먹여 순차 의존성을 만든다.
 */

import { kvGetJson, kvSetJson, kvDel } from './store.js';
import { wasmCore } from './wasm-loader.js';

const USER_PREFIX    = 'bpadmin:user:';
const SESSION_PREFIX = 'bpadmin:session:';
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30일 — 로그인 후 별도 재로그인 없이 자동 로그인 유지
const KDF_ROUNDS = 3000; // ≈80ms/회 — 무차별 대입 저항성과 로그인 응답속도의 균형점

// ── 비밀번호 해싱 ──────────────────────────────────────────────────────
function randomSaltHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  let acc = salt;
  for (let i = 0; i < KDF_ROUNDS; i++) {
    acc = await wasmCore.hmacSha256Hex(salt, acc + password);
  }
  return acc;
}

async function verifyPassword(password, salt, expectedHash) {
  const actual = await hashPassword(password, salt);
  return wasmCore.constantTimeEqual(actual, expectedHash);
}

// ── 계정 관리 ──────────────────────────────────────────────────────────
export async function getUser(env, username) {
  return kvGetJson(env, USER_PREFIX + username.toLowerCase().trim());
}

export async function hasAnyUser(env) {
  // KV list는 store.js의 kvScan을 재사용할 수도 있지만, 최초 부팅 여부만
  // 확인하면 되므로 별도 마커 키를 둔다(대량 스캔 없이 O(1) 조회).
  return !!(await kvGetJson(env, 'bpadmin:bootstrapped'));
}

export async function createUser(env, { username, password, role = 'owner' }) {
  const uname = username.toLowerCase().trim();
  if (!uname || uname.length < 3) {
    throw new Error('아이디는 3자 이상이어야 합니다.');
  }
  if (!password || password.length < 8) {
    throw new Error('비밀번호는 8자 이상이어야 합니다.');
  }
  const existing = await getUser(env, uname);
  if (existing) {
    throw new Error('이미 존재하는 아이디입니다.');
  }
  const salt = randomSaltHex();
  const passwordHash = await hashPassword(password, salt);
  const record = {
    username: uname,
    passwordHash,
    salt,
    role,
    createdAt: new Date().toISOString(),
  };
  await kvSetJson(env, USER_PREFIX + uname, record);
  await kvSetJson(env, 'bpadmin:bootstrapped', { at: record.createdAt });
  return { username: uname, role };
}

export async function verifyCredentials(env, username, password) {
  const user = await getUser(env, (username || '').toLowerCase().trim());
  if (!user) {
    // 사용자 존재 여부를 응답 시간으로 유추할 수 없도록, 존재하지 않아도
    // 동일한 비용의 더미 해싱을 수행한다(타이밍 사이드채널 방지).
    await hashPassword(password || '', randomSaltHex());
    return null;
  }
  const ok = await verifyPassword(password || '', user.salt, user.passwordHash);
  return ok ? { username: user.username, role: user.role } : null;
}

// ── 세션 관리 ──────────────────────────────────────────────────────────
function randomSessionId() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(env, { username, role }) {
  const sessionId = randomSessionId();
  const now = Date.now();
  const record = {
    username,
    role,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SEC * 1000,
  };
  await kvSetJson(env, SESSION_PREFIX + sessionId, record, SESSION_TTL_SEC);
  return sessionId;
}

const SESSION_RENEW_THRESHOLD_SEC = 7 * 24 * 60 * 60; // 남은 기간이 7일 미만이면 자동 연장

export async function getSession(env, sessionId) {
  if (!sessionId) return null;
  const record = await kvGetJson(env, SESSION_PREFIX + sessionId);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    await kvDel(env, SESSION_PREFIX + sessionId).catch(() => {});
    return null;
  }

  // 슬라이딩 세션: 남은 유효기간이 임계값 미만이면 조용히 30일로
  // 재연장한다. 이렇게 하면 30일 안에 최소 한 번만 접속해도 로그인이
  // 끊기지 않고 계속 유지된다("자동 로그인"). 매 요청마다 갱신하지 않고
  // 임계값 이하일 때만 갱신해 불필요한 KV 쓰기를 최소화한다.
  const remainingMs = record.expiresAt - Date.now();
  if (remainingMs < SESSION_RENEW_THRESHOLD_SEC * 1000) {
    const renewed = { ...record, expiresAt: Date.now() + SESSION_TTL_SEC * 1000 };
    await kvSetJson(env, SESSION_PREFIX + sessionId, renewed, SESSION_TTL_SEC).catch(() => {});
    return renewed;
  }

  return record;
}

export async function destroySession(env, sessionId) {
  if (!sessionId) return;
  await kvDel(env, SESSION_PREFIX + sessionId).catch(() => {});
}

// ── 쿠키 헬퍼 ──────────────────────────────────────────────────────────
export const SESSION_COOKIE_NAME = 'bp_session';

export function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function buildSessionCookie(sessionId, { secure = true } = {}) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/bp-admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildExpiredSessionCookie({ secure = true } = {}) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/bp-admin',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * 요청에서 세션을 조회한다. 인증되지 않았다면 null을 반환한다.
 * (401 응답 여부는 호출부에서 결정 — 이 함수는 순수 조회만 담당)
 */
export async function resolveSession(request, env) {
  const cookies = parseCookies(request);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;
  return getSession(env, sessionId);
}
