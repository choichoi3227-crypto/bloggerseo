/**
 * ssl.js — BloggerSEO SSL/TLS 자동 관리 모듈
 * ─────────────────────────────────────────────────────────────────────
 * 기능:
 *   1. Cloudflare API를 통해 커스텀 도메인 SSL/TLS 인증서 자동 발급
 *      (Let's Encrypt 또는 Google Trust Services 선택)
 *   2. HTTP → HTTPS 자동 리디렉션 (항상 강제)
 *   3. 인증서 자동 갱신 (Cron 기반, 만료 30일 전 갱신)
 *   4. 블로그스팟 자체 SSL 발급 우회 (Cloudflare가 앞단 처리)
 *   5. 패널에서 인증서 현황 조회 가능
 * ─────────────────────────────────────────────────────────────────────
 * 동작 원리:
 *   - Cloudflare는 Worker가 연결된 Zone의 커스텀 호스트명에 대해
 *     자동으로 Universal SSL/TLS 인증서를 발급합니다.
 *   - 추가로 Advanced Certificate Manager로 Let's Encrypt 또는
 *     Google Trust Services에서 전용 인증서를 발급받을 수 있습니다.
 *   - 블로그스팟 원본은 HTTP(ghs.google.com:80)로 연결하고,
 *     Cloudflare ↔ 방문자 구간은 완전한 HTTPS로 처리합니다.
 *   - 방문자가 http://로 접근하면 301로 https://로 강제 이동합니다.
 * ─────────────────────────────────────────────────────────────────────
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// ── SSL 인증서 CA 선호도 ─────────────────────────────────────────────
// 'lets_encrypt' | 'google' (Google Trust Services)
const DEFAULT_CA = 'lets_encrypt';

// ── 인증서 갱신 임계값: 만료 30일 전 자동 갱신 ───────────────────────
const RENEW_BEFORE_EXPIRY_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────
// 1. HTTP → HTTPS 강제 리디렉션
// ─────────────────────────────────────────────────────────────────────
/**
 * HTTP 요청을 HTTPS로 301 영구 리디렉션합니다.
 * handleFetch() 최상단에서 가장 먼저 호출해야 합니다.
 * @param {Request} request
 * @returns {Response|null} 리디렉션 응답 또는 null(이미 HTTPS)
 */
export function enforceHttpsRedirect(request) {
  const url = new URL(request.url);

  // 이미 HTTPS면 통과
  if (url.protocol === 'https:') return null;

  // HTTP → HTTPS 301 영구 리디렉션
  const httpsUrl = 'https://' + url.host + url.pathname + url.search + url.hash;
  return Response.redirect(httpsUrl, 301);
}

// ─────────────────────────────────────────────────────────────────────
// 2. Cloudflare API 헬퍼
// ─────────────────────────────────────────────────────────────────────
async function cfFetch(env, path, opts = {}) {
  const token  = env.CF_API_TOKEN || '';
  const zoneId = env.CF_ZONE_ID   || '';

  if (!token) throw new Error('CF_API_TOKEN 환경변수가 설정되지 않았습니다.');
  if (!zoneId && path.includes('{zoneId}')) throw new Error('CF_ZONE_ID 환경변수가 설정되지 않았습니다.');

  const url = CF_API_BASE + path.replace('{zoneId}', zoneId);
  const res = await fetch(url, {
    method : opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type' : 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ─────────────────────────────────────────────────────────────────────
// 3. Zone SSL 설정 조회
// ─────────────────────────────────────────────────────────────────────
/**
 * Zone의 현재 SSL/TLS 설정을 반환합니다.
 */
export async function getSslSettings(env) {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/settings/ssl');
    if (!ok) return { mode: 'unknown', error: data?.errors?.[0]?.message || '조회 실패' };
    return { mode: data?.result?.value || 'unknown' };
  } catch (e) {
    return { mode: 'unknown', error: e.message };
  }
}

/**
 * Zone SSL 모드를 'full' 또는 'flexible'로 설정합니다.
 * 블로그스팟은 원본이 HTTP이므로 'flexible' 모드를 사용합니다.
 * (Cloudflare ↔ 방문자: HTTPS, Cloudflare ↔ Origin: HTTP)
 */
export async function setSslFlexible(env) {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/settings/ssl', {
      method: 'PATCH',
      body: { value: 'flexible' },
    });
    return { ok, message: ok ? 'SSL 모드를 flexible로 설정했습니다.' : data?.errors?.[0]?.message };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. HTTPS 강제 리디렉션 설정 (Cloudflare Zone 레벨)
// ─────────────────────────────────────────────────────────────────────
/**
 * Cloudflare Zone에서 HTTPS 강제 리디렉션을 켭니다.
 * (Always Use HTTPS = on)
 */
export async function enableAlwaysHttps(env) {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/settings/always_use_https', {
      method: 'PATCH',
      body: { value: 'on' },
    });
    return { ok, message: ok ? 'Always Use HTTPS 활성화 완료' : data?.errors?.[0]?.message };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * Always Use HTTPS 현재 설정 조회
 */
export async function getAlwaysHttps(env) {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/settings/always_use_https');
    return { enabled: data?.result?.value === 'on', ok };
  } catch (e) {
    return { enabled: false, ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. TLS 최소 버전 설정 (TLS 1.2 이상 강제)
// ─────────────────────────────────────────────────────────────────────
export async function setMinTlsVersion(env, version = '1.2') {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/settings/min_tls_version', {
      method: 'PATCH',
      body: { value: version },
    });
    return { ok, message: ok ? `최소 TLS 버전을 ${version}로 설정했습니다.` : data?.errors?.[0]?.message };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

export async function getMinTlsVersion(env) {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/settings/min_tls_version');
    return { version: data?.result?.value || 'unknown', ok };
  } catch (e) {
    return { version: 'unknown', ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. 인증서 목록 조회
// ─────────────────────────────────────────────────────────────────────
/**
 * Zone에 발급된 인증서 목록을 반환합니다.
 * Universal SSL + Advanced Certificate Manager 인증서 모두 포함.
 */
export async function listCertificates(env) {
  try {
    // Universal SSL 인증서
    const [univResp, advResp] = await Promise.all([
      cfFetch(env, '/zones/{zoneId}/ssl/universal/settings'),
      cfFetch(env, '/zones/{zoneId}/ssl/certificate_packs').catch(() => ({ ok: false, data: {} })),
    ]);

    const universal = univResp.ok ? univResp.data?.result || {} : {};
    const packs     = advResp.ok  ? (advResp.data?.result || []) : [];

    // 인증서 팩을 보기 좋은 형태로 변환
    const certificates = packs.map(pack => ({
      id           : pack.id,
      type         : pack.type || 'advanced',
      status       : pack.status,
      ca           : pack.certificate_authority || 'unknown',
      hosts        : pack.hosts || [],
      validityDays : pack.validity_days || null,
      expiresOn    : pack.certificates?.[0]?.expires_on || null,
      issuedOn     : pack.certificates?.[0]?.issued_on  || null,
      daysRemaining: calcDaysRemaining(pack.certificates?.[0]?.expires_on),
      renewalNeeded: calcDaysRemaining(pack.certificates?.[0]?.expires_on) <= RENEW_BEFORE_EXPIRY_DAYS,
    }));

    return {
      ok: true,
      universal: {
        enabled           : universal.enabled ?? true,
        certificateAuthority: universal.certificate_authority || 'lets_encrypt',
      },
      certificates,
      totalCount: certificates.length,
    };
  } catch (e) {
    return { ok: false, error: e.message, certificates: [] };
  }
}

function calcDaysRemaining(expiresOnStr) {
  if (!expiresOnStr) return null;
  const expiry = new Date(expiresOnStr);
  const now    = new Date();
  return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
}

// ─────────────────────────────────────────────────────────────────────
// 7. Universal SSL 설정 (CA 선택)
// ─────────────────────────────────────────────────────────────────────
/**
 * Universal SSL의 CA를 설정합니다.
 * @param {*} env
 * @param {'lets_encrypt'|'google'} ca - 인증 기관 선택
 */
export async function setUniversalSslCa(env, ca = DEFAULT_CA) {
  const validCa = ca === 'google' ? 'google' : 'lets_encrypt';
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/ssl/universal/settings', {
      method: 'PATCH',
      body: { certificate_authority: validCa, enabled: true },
    });
    return {
      ok,
      ca: validCa,
      message: ok
        ? `Universal SSL CA를 ${validCa === 'google' ? 'Google Trust Services' : 'Let\'s Encrypt'}로 설정했습니다.`
        : data?.errors?.[0]?.message,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * Universal SSL 현재 설정 조회
 */
export async function getUniversalSslSettings(env) {
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/ssl/universal/settings');
    const result = data?.result || {};
    return {
      ok,
      enabled: result.enabled ?? true,
      ca     : result.certificate_authority || 'lets_encrypt',
      caLabel: result.certificate_authority === 'google'
        ? 'Google Trust Services'
        : "Let's Encrypt",
    };
  } catch (e) {
    return { ok: false, enabled: false, ca: 'unknown', error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8. 인증서 자동 발급 (Advanced Certificate Manager)
// ─────────────────────────────────────────────────────────────────────
/**
 * 지정한 호스트에 대해 Advanced Certificate를 발급합니다.
 * Let's Encrypt 또는 Google Trust Services 중 선택 가능.
 * @param {*} env
 * @param {string[]} hosts - 인증서를 발급할 도메인 목록
 * @param {'lets_encrypt'|'google'} ca
 */
export async function issueCertificate(env, hosts, ca = DEFAULT_CA) {
  if (!hosts || hosts.length === 0) return { ok: false, message: '도메인이 지정되지 않았습니다.' };

  const validCa = ca === 'google' ? 'google' : 'lets_encrypt';
  try {
    const { ok, data } = await cfFetch(env, '/zones/{zoneId}/ssl/certificate_packs/order', {
      method: 'POST',
      body: {
        hosts,
        type                   : 'advanced',
        certificate_authority  : validCa,
        validation_method      : 'txt',  // DNS TXT 검증 (블로그스팟 호환)
        validity_days          : 90,
        cloudflare_branding    : false,
      },
    });
    return {
      ok,
      ca    : validCa,
      hosts,
      packId: data?.result?.id,
      status: data?.result?.status,
      message: ok
        ? `인증서 발급 요청 완료 (CA: ${validCa === 'google' ? 'Google Trust Services' : "Let's Encrypt"})`
        : data?.errors?.[0]?.message || '발급 실패',
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9. 인증서 자동 갱신 (Cron에서 호출)
// ─────────────────────────────────────────────────────────────────────
/**
 * 만료가 임박한 인증서를 자동으로 갱신합니다.
 * Cloudflare는 Universal SSL 인증서를 자동으로 갱신하지만,
 * Advanced Certificate는 수동 또는 API로 갱신해야 합니다.
 * @returns {Object} 갱신 결과 리포트
 */
export async function autoRenewCertificates(env) {
  const report = { checked: 0, renewed: [], errors: [], ts: new Date().toISOString() };

  try {
    const { ok, certificates } = await listCertificates(env);
    if (!ok) return { ...report, error: '인증서 목록 조회 실패' };

    report.checked = certificates.length;

    for (const cert of certificates) {
      if (!cert.renewalNeeded) continue;

      // 만료 임박 인증서 갱신 시도
      try {
        const result = await issueCertificate(env, cert.hosts, cert.ca === 'google' ? 'google' : 'lets_encrypt');
        if (result.ok) {
          report.renewed.push({ hosts: cert.hosts, ca: cert.ca, daysRemaining: cert.daysRemaining });
        } else {
          report.errors.push({ hosts: cert.hosts, error: result.message });
        }
      } catch (e) {
        report.errors.push({ hosts: cert.hosts, error: e.message });
      }
    }
  } catch (e) {
    report.error = e.message;
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────
// 10. 전체 SSL/TLS 상태 조회 (패널용)
// ─────────────────────────────────────────────────────────────────────
/**
 * 패널에서 표시할 SSL/TLS 전체 현황을 반환합니다.
 */
export async function getSslStatus(env) {
  const hasToken  = !!(env.CF_API_TOKEN);
  const hasZoneId = !!(env.CF_ZONE_ID);

  if (!hasToken || !hasZoneId) {
    return {
      ok            : false,
      configured    : false,
      missingToken  : !hasToken,
      missingZoneId : !hasZoneId,
      message       : '패널 → 도메인 설정에서 CF_API_TOKEN, CF_ZONE_ID를 설정하세요.',
    };
  }

  const [sslMode, alwaysHttps, minTls, univSsl, certs] = await Promise.all([
    getSslSettings(env),
    getAlwaysHttps(env),
    getMinTlsVersion(env),
    getUniversalSslSettings(env),
    listCertificates(env),
  ]);

  // 가장 빠르게 만료되는 인증서 찾기
  const nearestExpiry = certs.certificates
    .filter(c => c.daysRemaining !== null)
    .sort((a, b) => a.daysRemaining - b.daysRemaining)[0] || null;

  return {
    ok          : true,
    configured  : true,
    sslMode     : sslMode.mode,
    alwaysHttps : alwaysHttps.enabled,
    minTls      : minTls.version,
    universal   : univSsl,
    certificates: certs.certificates,
    certCount   : certs.totalCount,
    nearestExpiry,
    renewalNeeded: certs.certificates.some(c => c.renewalNeeded),
    ts          : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 11. 초기 설정 자동화 (최초 1회 실행)
//     - SSL flexible 모드 설정
//     - Always Use HTTPS 활성화
//     - TLS 1.2 최소 버전 설정
//     - Universal SSL CA 설정
// ─────────────────────────────────────────────────────────────────────
export async function initializeSsl(env, ca = DEFAULT_CA) {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return { ok: false, message: 'CF_API_TOKEN 및 CF_ZONE_ID가 필요합니다.' };
  }

  const results = await Promise.allSettled([
    setSslFlexible(env),
    enableAlwaysHttps(env),
    setMinTlsVersion(env, '1.2'),
    setUniversalSslCa(env, ca),
  ]);

  return {
    ok        : results.every(r => r.status === 'fulfilled' && r.value?.ok),
    sslMode   : results[0].value,
    alwaysHttps: results[1].value,
    minTls    : results[2].value,
    universalSsl: results[3].value,
    ts        : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 12. SSL 패널 API 라우터
// ─────────────────────────────────────────────────────────────────────
export async function handleSslPanelApi(subPath, request, env) {
  // GET /panel/api/ssl_status
  if (subPath === 'api/ssl_status') {
    const status = await getSslStatus(env);
    return new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json' } });
  }

  // POST /panel/api/ssl_init
  if (subPath === 'api/ssl_init' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ca   = body.ca === 'google' ? 'google' : 'lets_encrypt';
    const result = await initializeSsl(env, ca);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }

  // POST /panel/api/ssl_renew
  if (subPath === 'api/ssl_renew' && request.method === 'POST') {
    const result = await autoRenewCertificates(env);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }

  // POST /panel/api/ssl_issue
  if (subPath === 'api/ssl_issue' && request.method === 'POST') {
    const body  = await request.json().catch(() => ({}));
    const hosts = body.hosts || [];
    const ca    = body.ca === 'google' ? 'google' : 'lets_encrypt';
    const result = await issueCertificate(env, hosts, ca);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }

  // POST /panel/api/ssl_always_https
  if (subPath === 'api/ssl_always_https' && request.method === 'POST') {
    const result = await enableAlwaysHttps(env);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }

  // POST /panel/api/ssl_set_ca
  if (subPath === 'api/ssl_set_ca' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ca   = body.ca === 'google' ? 'google' : 'lets_encrypt';
    const result = await setUniversalSslCa(env, ca);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }

  return null; // 해당 경로 없음
}
