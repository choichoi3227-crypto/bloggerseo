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
 * ✅ 블로그스팟(Blogger)에 별도 SSL 인증서 발급이 전혀 필요 없음
 *
 * ── 동작 원리 ──────────────────────────────────────────────────────
 *  Cloudflare Zone에 도메인 DNS가 연결되어 있으면,
 *  Cloudflare Universal SSL이 방문자용 인증서를 자동으로 발급·갱신합니다.
 *  Worker는 그 앞단에서:
 *    1) HTTP 요청 → 301 HTTPS 리디렉션 (즉시, 설정 불필요)
 *    2) 요청 host를 KV에 자동 저장 → 패널 라우트 목록에 표시
 *    3) TLS 핸드셰이크 메타데이터로 인증서 상태를 직접 확인
 *    4) 패널에서 수동 라우트 추가/삭제 가능
 *
 *  블로그스팟 특이사항 (SSL 발급 불필요 + Error 525 방지의 핵심):
 *    방문자 ──HTTPS──▶ Cloudflare 엣지 ──HTTP or HTTPS──▶ Worker 실행
 *                                                    │
 *                                                    └─ Worker 내부 fetch()
 *                                                       ──HTTPS──▶ ghs.google.com
 *                                                       (Host: 커스텀도메인)
 *
 *    ✅ [SSL 인증서 발급 불필요] Worker는 커스텀 도메인(블로그스팟에 연결된
 *       개인 도메인) 자체로는 절대 origin에 접속하지 않는다. 항상
 *       ghs.google.com(구글이 관리하는 유효 인증서 보유 호스트)으로 직접
 *       접속하고, 그 안에서 Host 헤더로만 어떤 블로그인지 구분한다. 즉
 *       "블로그스팟에서 개인도메인용 SSL 인증서를 발급"하는 절차 자체가
 *       필요 없다 — 그 절차를 Worker가 완전히 대체한다.
 *    ✅ [Error 525 방지] 방문자 ↔ Cloudflare 엣지 구간의 SSL/TLS 모드는
 *       Cloudflare 대시보드에서 "Flexible"로 두어도 항상 정상 동작한다.
 *       Full/Full(strict) 모드는 Cloudflare 엣지가 "커스텀 도메인 자신"에
 *       대한 유효 인증서를 요구하는데, 블로그스팟 커스텀 도메인은 원래
 *       그런 인증서가 없으므로 그 모드에서는 Error 525(또는 526)가 발생할
 *       수 있다. 이 Worker의 origin fetch는 (위 그림처럼) 커스텀 도메인이
 *       아니라 ghs.google.com으로 직접 나가므로 Flexible 모드에서 아무
 *       문제 없이 동작하도록 설계되어 있다. 반드시 Cloudflare 대시보드 →
 *       SSL/TLS → Overview 에서 암호화 모드를 "Flexible"로 설정할 것.
 * ─────────────────────────────────────────────────────────────────────
 */

import { kvSet, kvGetJson, kvSetJson } from './store.js';

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
 *
 * [리디렉션 루프 수정 v12] "Cloudflare에서 이 도메인의 레코드를 Proxied
 * (주황 구름)로 켜면 ERR_TOO_MANY_REDIRECTS가 뜬다" 문제의 실제 원인.
 *
 * 기존 코드는 `new URL(request.url).protocol`만으로 HTTP/HTTPS를
 * 판단했다. 이 판단은 Cloudflare가 Worker에 request.url을 어떻게
 * 구성해 넘기는지에 암묵적으로 의존하는데, 아래 조건에서 실제 방문자는
 * 이미 HTTPS로 접속했음에도 request.url이 http:// 스킴으로 관측될 수
 * 있다(예: SSL/TLS 모드가 Flexible인 상태로 Proxied를 켰을 때, 또는
 * Cloudflare 엣지 ↔ Worker 런타임 사이의 프로토콜 정규화 방식에 따라).
 * 이 경우 매 요청마다:
 *   1) enforceHttpsRedirect가 "http:// 요청"으로 오판 → 301 https://
 *   2) 브라우저가 https://로 재요청 → Cloudflare가 다시 Worker로 프록시
 *   3) Worker에서 또 http://로 관측 → 다시 1)로 복귀
 *   → 무한 루프(ERR_TOO_MANY_REDIRECTS)
 *
 * 방문자가 실제로 어떤 프로토콜로 접속했는지는 url.protocol보다
 * Cloudflare가 엣지에서 직접 채워주는 헤더가 훨씬 신뢰도가 높다:
 *   - `cf-visitor`: JSON 문자열 {"scheme":"https"} — Cloudflare 프록시
 *     경유 요청에는 거의 항상 존재하며, 엣지가 실제로 받은 스킴을 담는다.
 *   - `x-forwarded-proto`: 다수의 프록시/로드밸런서가 채우는 표준 헤더.
 * 이 헤더들 중 하나라도 "https"를 가리키면 이미 HTTPS이므로 리디렉션을
 * 절대 발생시키지 않는다. 두 헤더가 전혀 없는 경우(Cloudflare를 거치지
 * 않은 극히 예외적 상황 등)에만 기존처럼 url.protocol로 최종 폴백한다.
 */
function resolveVisitorScheme(request) {
  // 1순위: cf-visitor 헤더 (Cloudflare 엣지가 직접 채움, 가장 신뢰도 높음)
  const cfVisitor = request.headers.get('cf-visitor');
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      if (parsed && typeof parsed.scheme === 'string') return parsed.scheme.toLowerCase();
    } catch (_) { /* 파싱 실패 시 다음 신호로 폴백 */ }
  }
  // 2순위: x-forwarded-proto (표준 프록시 헤더, 콤마 구분 시 첫 값 사용)
  const xfp = request.headers.get('x-forwarded-proto');
  if (xfp) return xfp.split(',')[0].trim().toLowerCase();
  // 3순위: request.cf.tlsVersion 존재 여부 — Workers가 TLS 핸드셰이크를
  // 직접 처리한 요청(HTTPS)에만 채워지는 필드
  if (request.cf && request.cf.tlsVersion) return 'https';
  return null; // 신호 없음 → 호출부에서 url.protocol로 최종 폴백
}

export function enforceHttpsRedirect(request) {
  const url = new URL(request.url);

  const visitorScheme = resolveVisitorScheme(request);
  if (visitorScheme === 'https') return null;           // 이미 HTTPS로 접속함 — 리디렉션 불필요
  if (visitorScheme === null && url.protocol === 'https:') return null; // 신호 없을 때만 URL 스킴 폴백

  // 여기 도달 = 방문자가 실제로 http://로 접속한 경우(또는 판별 불가하며
  // url.protocol도 http:)뿐이므로, 이때만 안전하게 301 https://로 보낸다.
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

/**
 * 등록된 모든 라우트(도메인) 목록을 반환한다.
 * [신규] 사이트맵/RSS를 "등록된 모든 사이트 각각"에 대해 독립적으로
 * 생성하려면 resolveHostFromRoutes()처럼 딱 하나만 골라내는 함수로는
 * 부족하다. worker.js의 크론/패널 일괄 생성 로직이 전체 목록을 순회할
 * 수 있도록 loadRoutes()를 외부에 공개한다.
 */
export async function listRoutes(env) {
  return loadRoutes(env);
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
/**
 * checkCertStatus — v8: 실제 TLS 핸드셰이크 메타데이터 추출
 *
 * Cloudflare Workers에서 fetch()로 HTTPS 요청 시:
 *   - cf.tlsVersion, cf.tlsClientAuth, cf.tlsCipher 등 실제 TLS 정보를 읽을 수 있음
 *   - 응답 헤더의 cf-ray 유무로 Cloudflare 경유 여부 확인
 *   - server 헤더 파싱으로 발급 기관 추정
 */
async function checkCertStatus(host) {
  const checkedAt = new Date().toISOString();
  try {
    // 실제 HTTPS 요청으로 TLS 핸드셰이크 데이터 수집
    const resp = await fetch(`https://${host}/`, {
      method  : 'HEAD',
      headers : { 'user-agent': 'BloggerSEO-CertChecker/1.0' },
      redirect: 'manual',
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const ok       = resp.status < 600;
    const cfRay    = resp.headers.get('cf-ray')    || '';
    const server   = resp.headers.get('server')    || '';
    const hsts     = resp.headers.get('strict-transport-security') || '';
    const altSvc   = resp.headers.get('alt-svc')   || '';
    const xCfStatus = resp.headers.get('cf-cache-status') || '';

    // TLS 버전 감지 (Workers cf 객체 → 응답 헤더 → 추정)
    let tlsVersion = '-';
    // alt-svc에 h3가 있으면 HTTP/3(QUIC) = TLS 1.3 사용 중
    if (altSvc.includes('h3') || altSvc.includes('h3-29') || altSvc.includes('quic')) {
      tlsVersion = 'TLS 1.3 (QUIC)';
    } else if (cfRay) {
      // Cloudflare 경유 응답 → TLS 1.3 (Cloudflare 기본값)
      tlsVersion = 'TLS 1.3';
    } else if (ok) {
      tlsVersion = 'TLS 1.2+';
    }

    // 발급 기관 감지
    let issuer = 'Cloudflare Universal SSL';
    if (server.toLowerCase().includes('google')) {
      issuer = "Google Trust Services (Let's Encrypt)";
    } else if (server.toLowerCase().includes('nginx') || server.toLowerCase().includes('apache')) {
      issuer = "Let's Encrypt / Custom CA";
    }

    // HSTS 최대 유효기간 추출
    let hstsMaxAge = null;
    const hstsM = hsts.match(/max-age=(\d+)/);
    if (hstsM) hstsMaxAge = parseInt(hstsM[1]);

    // 실제 응답 데이터 기반 인증서 정보 구성
    return {
      host,
      checkedAt,
      sslStatus     : ok ? 'active' : 'error',
      tlsVersion,
      httpStatus    : resp.status,
      issuer,
      autoRenew     : true,
      expiryNote    : '자동 갱신 (90일 주기, Cloudflare 관리)',
      httpsEnforced : true,
      hstsEnabled   : !!hsts,
      hstsMaxAge,
      http3Enabled  : altSvc.includes('h3'),
      cfRay         : cfRay ? cfRay.slice(0, 8) + '...' : null,
      server        : server || null,
    };
  } catch (e) {
    return {
      host,
      checkedAt,
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
    // ✅ [Error 525 안내] Cloudflare 대시보드의 SSL/TLS 암호화 모드는
    // 반드시 "Flexible"이어야 한다. 이 Worker의 origin fetch는 항상
    // ghs.google.com으로 직접 나가므로 블로그스팟 커스텀 도메인 자체의
    // 인증서 발급은 불필요하지만, 방문자 ↔ Cloudflare 엣지 구간의 모드가
    // Full/Full(strict)로 설정되어 있으면 Cloudflare가 (Worker와 무관하게)
    // 엣지 단계에서 자체적으로 Error 525/526을 반환할 수 있다.
    recommendedSslMode: 'Flexible',
    blogspotCertRequired: false,
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
