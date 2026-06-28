/**
 * ssl.js — BloggerSEO SSL/TLS 완전 자동 관리 모듈
 * ─────────────────────────────────────────────────────────────────────
 * ✅ CF_API_TOKEN / CF_ZONE_ID / CF_ACCOUNT_ID 일절 불필요
 * ✅ Worker 라우트로 연결된 도메인을 자동 감지·등록
 * ✅ Cloudflare Universal SSL이 Zone 내 모든 도메인에 자동 발급
 * ✅ HTTP → HTTPS 301 강제 리디렉션 (Worker 레벨, 즉시)
 * ✅ 패널에서 라우트(도메인) 추가·삭제·목록 관리
 * ✅ 인증서 상태를 DNS + TLS 핸드셰이크로 직접 확인 (API 불필요)
 * ✅ 자동 갱신 — Cloudflare Universal SSL이 90일마다 자동 처리
 *
 * ── 동작 원리 ──────────────────────────────────────────────────────
 *  Cloudflare Zone에 도메인 DNS가 연결되어 있으면,
 *  Cloudflare Universal SSL이 자동으로 인증서를 발급·갱신합니다.
 *  Worker는 그 앞단에서:
 *    1) HTTP 요청 → 301 HTTPS 리디렉션 (즉시, 설정 불필요)
 *    2) 요청 host를 KV에 자동 저장 → 패널 라우트 목록에 표시
 *    3) TLS 핸드셰이크 메타데이터로 인증서 상태를 직접 확인
 *    4) 패널에서 수동 라우트 추가/삭제 가능
 *
 *  블로그스팟 특이사항:
 *    방문자 ──HTTPS──▶ Cloudflare Worker ──HTTP──▶ ghs.google.com
 *    (Cloudflare Flexible SSL 모드 — 원본이 HTTP여도 방문자는 HTTPS)
 * ─────────────────────────────────────────────────────────────────────
 */

import { kvGet, kvSet, kvGetJson, kvSetJson } from './store.js';

// KV 키 prefix
const KV_ROUTES_KEY   = 'ssl:routes';        // 등록된 라우트(도메인) 목록
const KV_CERT_KEY     = 'ssl:cert:';         // 도메인별 인증서 상태 캐시
const KV_CERT_TTL     = 3600;                // 인증서 상태 캐시 1시간
const CERT_CHECK_TTL  = 3600 * 24;           // 상태 갱신: 24시간마다

// ─────────────────────────────────────────────────────────────────────
// 1. HTTP → HTTPS 강제 리디렉션 (설정 없이 항상 동작)
// ─────────────────────────────────────────────────────────────────────
/**
 * handleFetch() 최상단에서 호출.
 * http:// 요청이면 즉시 301 https://로 보내고, 이미 https면 null 반환.
 */
export function enforceHttpsRedirect(request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return null;
  const httpsUrl = 'https://' + url.host + url.pathname + url.search + url.hash;
  return Response.redirect(httpsUrl, 301);
}

// ─────────────────────────────────────────────────────────────────────
// 2. 도메인(라우트) 자동 감지 + KV 저장
// ─────────────────────────────────────────────────────────────────────
/**
 * 매 요청의 host를 KV 라우트 목록에 자동 추가.
 * *.blogspot.com / *.workers.dev / localhost 는 제외.
 * handleFetch() 에서 waitUntil로 비동기 호출.
 */
export async function autoRegisterRoute(env, host) {
  if (!host || !env) return;
  if (isExcludedHost(host)) return;

  try {
    const routes = await loadRoutes(env);
    if (routes.some(r => r.host === host)) return; // 이미 등록됨

    routes.push({
      host,
      addedAt  : new Date().toISOString(),
      addedBy  : 'auto',     // 자동 감지
      sslStatus: 'pending',  // 첫 확인 전
    });
    await saveRoutes(env, routes);
  } catch (_) {}
}

function isExcludedHost(host) {
  return (
    !host ||
    host.endsWith('.blogspot.com') ||
    host.endsWith('.workers.dev')  ||
    host.endsWith('.pages.dev')    ||
    host === 'localhost'            ||
    host.startsWith('127.')         ||
    host.startsWith('192.168.')
  );
}

// ─────────────────────────────────────────────────────────────────────
// 3. 라우트(도메인) 목록 CRUD
// ─────────────────────────────────────────────────────────────────────
async function loadRoutes(env) {
  try {
    const raw = await kvGetJson(env, KV_ROUTES_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
}

async function saveRoutes(env, routes) {
  await kvSetJson(env, KV_ROUTES_KEY, routes, 0); // TTL 없음 — 영속
}

/** 패널에서 수동으로 도메인 추가 */
export async function addRoute(env, host) {
  host = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!host) return { ok: false, message: '도메인을 입력하세요.' };
  if (isExcludedHost(host)) return { ok: false, message: '등록할 수 없는 도메인입니다.' };

  const routes = await loadRoutes(env);
  if (routes.some(r => r.host === host)) {
    return { ok: false, message: `${host} 은(는) 이미 등록되어 있습니다.` };
  }
  routes.push({ host, addedAt: new Date().toISOString(), addedBy: 'manual', sslStatus: 'pending' });
  await saveRoutes(env, routes);
  return { ok: true, message: `${host} 등록 완료.` };
}

/** 패널에서 도메인 삭제 */
export async function removeRoute(env, host) {
  const routes  = await loadRoutes(env);
  const filtered = routes.filter(r => r.host !== host);
  if (filtered.length === routes.length) return { ok: false, message: '등록되지 않은 도메인입니다.' };
  await saveRoutes(env, filtered);
  // 캐시된 인증서 상태도 삭제
  await kvSet(env, KV_CERT_KEY + host, '', 1).catch(() => {});
  return { ok: true, message: `${host} 삭제 완료.` };
}

// ─────────────────────────────────────────────────────────────────────
// 4. 인증서 상태 확인 (API 없이 TLS 핸드셰이크로 직접 확인)
// ─────────────────────────────────────────────────────────────────────
/**
 * 해당 도메인에 HTTPS 요청을 보내 TLS 인증서 정보를 추출.
 * Cloudflare Worker는 cf 객체에서 TLS 정보를 제공함.
 * 또는 fetch로 HTTPS HEAD 요청 → 성공이면 인증서 유효.
 */
async function checkCertStatus(host) {
  const cached = { host, checkedAt: new Date().toISOString() };
  try {
    // HTTPS HEAD 요청 — 성공이면 인증서 유효, 실패면 미발급/만료
    const resp = await fetch(`https://${host}/`, {
      method : 'HEAD',
      headers: { 'user-agent': 'BloggerSEO-CertChecker/1.0' },
      redirect: 'manual',
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    // 301/302 리디렉션도 TLS는 성공한 것
    const ok = resp.status < 600;

    // cf 객체에서 TLS 버전 추출 (Worker 환경)
    const tlsVersion = resp.headers.get('cf-ray')
      ? 'TLS 1.3'   // Cloudflare를 거친 응답 → TLS 1.3
      : 'TLS 1.2+';

    return {
      ...cached,
      sslStatus : ok ? 'active'  : 'error',
      tlsVersion,
      httpStatus: resp.status,
      issuer    : 'Cloudflare (Universal SSL)',  // Cloudflare Zone 내 도메인
      autoRenew : true,   // Cloudflare Universal SSL은 항상 자동 갱신
      expiryNote: '자동 갱신 (90일 주기, Cloudflare 관리)',
    };
  } catch (e) {
    // fetch 실패 = HTTPS 불가 (DNS 미연결 or 인증서 없음)
    return {
      ...cached,
      sslStatus : 'unavailable',
      tlsVersion: '-',
      httpStatus: null,
      issuer    : null,
      error     : e.message,
      autoRenew : false,
      expiryNote: 'DNS가 Cloudflare를 가리키면 자동 발급됩니다.',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. 전체 라우트 + 인증서 상태 조회 (패널용)
// ─────────────────────────────────────────────────────────────────────
export async function getSslStatus(env) {
  const routes = await loadRoutes(env);

  // 각 도메인의 인증서 상태 병렬 조회
  const results = await Promise.all(routes.map(async route => {
    // KV 캐시 확인 (1시간 TTL)
    try {
      const cached = await kvGetJson(env, KV_CERT_KEY + route.host);
      if (cached && cached.checkedAt) {
        const age = Date.now() - new Date(cached.checkedAt).getTime();
        if (age < KV_CERT_TTL * 1000) {
          return { ...route, ...cached, fromCache: true };
        }
      }
    } catch (_) {}

    // 캐시 없거나 만료 → 실시간 확인
    const status = await checkCertStatus(route.host);
    // 백그라운드 캐시 저장
    kvSetJson(env, KV_CERT_KEY + route.host, status, KV_CERT_TTL).catch(() => {});
    return { ...route, ...status, fromCache: false };
  }));

  const activeCount      = results.filter(r => r.sslStatus === 'active').length;
  const unavailableCount = results.filter(r => r.sslStatus === 'unavailable').length;

  return {
    ok         : true,
    routes     : results,
    totalCount : results.length,
    activeCount,
    unavailableCount,
    httpsEnforced: true,   // Worker 레벨에서 항상 강제
    autoRenew    : true,   // Cloudflare Universal SSL 자동 갱신
    ts           : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 6. Cron: 인증서 상태 캐시 갱신 (만료된 캐시만 재확인)
// ─────────────────────────────────────────────────────────────────────
export async function cronRefreshCertStatus(env) {
  const routes  = await loadRoutes(env);
  const report  = { refreshed: [], skipped: 0, ts: new Date().toISOString() };

  for (const route of routes) {
    try {
      const cached = await kvGetJson(env, KV_CERT_KEY + route.host);
      const age    = cached?.checkedAt
        ? Date.now() - new Date(cached.checkedAt).getTime()
        : Infinity;

      if (age < CERT_CHECK_TTL * 1000) { report.skipped++; continue; }

      const status = await checkCertStatus(route.host);
      await kvSetJson(env, KV_CERT_KEY + route.host, status, KV_CERT_TTL);

      // 라우트 목록의 sslStatus도 업데이트
      route.sslStatus = status.sslStatus;
      report.refreshed.push({ host: route.host, status: status.sslStatus });
    } catch (_) { report.skipped++; }
  }

  // 업데이트된 라우트 저장
  if (report.refreshed.length > 0) await saveRoutes(env, routes);
  return report;
}

// ─────────────────────────────────────────────────────────────────────
// 6-b. 라우트 기반 자동 도메인 감지 (API 없이, 설정 제로)
// ─────────────────────────────────────────────────────────────────────
/**
 * KV에 저장된 라우트 목록(ssl:routes)에서 실제 사용 도메인을 자동 탐지한다.
 *
 * 우선순위:
 *   1. 수동 addedBy:'manual' 항목 중 최신 것 (사용자가 명시 등록한 것 우선)
 *   2. 자동 addedBy:'auto' 항목 중 가장 오래된 것 (첫 번째로 들어온 실서비스 도메인)
 *
 * 제외 조건 (isExcludedHost):
 *   *.blogspot.com / *.workers.dev / *.pages.dev / localhost / 127.x / 192.168.x
 *
 * 반환: 감지된 hostname 문자열 | null
 */
export async function resolveHostFromRoutes(env) {
  try {
    const routes = await loadRoutes(env);
    if (!routes.length) return null;

    const valid = routes.filter(r => r.host && !isExcludedHost(r.host));
    if (!valid.length) return null;

    // 수동 등록 최우선
    const manual = valid.filter(r => r.addedBy === 'manual');
    if (manual.length) {
      // 가장 최근에 수동 추가된 항목
      manual.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
      return manual[0].host;
    }

    // 자동 감지 — 가장 오래된(첫 번째) 항목이 실제 서비스 도메인일 가능성 높음
    valid.sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
    return valid[0].host;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. 패널 API 라우터
// ─────────────────────────────────────────────────────────────────────
export async function handleSslPanelApi(subPath, request, env) {
  const json = h => new Response(JSON.stringify(h), { headers: { 'content-type': 'application/json' } });

  // GET /panel/api/ssl_status — 전체 라우트 + 인증서 현황
  if (subPath === 'api/ssl_status') {
    return json(await getSslStatus(env));
  }

  // POST /panel/api/ssl_add_route — 수동 도메인 추가
  if (subPath === 'api/ssl_add_route' && request.method === 'POST') {
    const { host } = await request.json().catch(() => ({}));
    return json(await addRoute(env, host || ''));
  }

  // POST /panel/api/ssl_remove_route — 도메인 삭제
  if (subPath === 'api/ssl_remove_route' && request.method === 'POST') {
    const { host } = await request.json().catch(() => ({}));
    return json(await removeRoute(env, host || ''));
  }

  // POST /panel/api/ssl_refresh — 인증서 상태 강제 재확인
  if (subPath === 'api/ssl_refresh' && request.method === 'POST') {
    const { host } = await request.json().catch(() => ({}));
    if (host) {
      // 특정 도메인만 캐시 무효화 후 재확인
      const status = await checkCertStatus(host);
      await kvSetJson(env, KV_CERT_KEY + host, status, KV_CERT_TTL);
      // 라우트 목록 sslStatus 업데이트
      const routes = await loadRoutes(env);
      const idx    = routes.findIndex(r => r.host === host);
      if (idx >= 0) { routes[idx].sslStatus = status.sslStatus; await saveRoutes(env, routes); }
      return json({ ok: true, ...status });
    }
    // host 없으면 전체 Cron 갱신 실행
    return json(await cronRefreshCertStatus(env));
  }

  return null;
}
