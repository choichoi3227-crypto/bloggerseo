/**
 * BloggerSEO v14 — Bunny CDN 감지 + Cloudflare/Bunny 이중 CDN 안전 캐싱
 * ─────────────────────────────────────────────────────────────────────
 * [배경 — 요청사항 1번]
 *   "Bunny CDN(DNS에서 감지) 및 Cloudflare CDN 사용 극대화"라는 요구는,
 *   이 Worker 앞단에 사용자가 Bunny CDN을 얹어둔 배포 형태(예: 원본이
 *   Cloudflare Workers, 그 앞에 Bunny를 리버스 프록시로 추가 배치)를
 *   전제로 한다. 이 경우 두 CDN이 서로 다른 캐시 정책/캐시 키로 같은
 *   콘텐츠를 각자 캐싱하면:
 *     - 한쪽만 갱신되고 다른 쪽은 낡은 콘텐츠를 계속 서빙 → 페이지에
 *       내장된 위젯(댓글, 드롭다운 메뉴 등)이 참조하는 인라인 설정과
 *       실제 서버 상태가 어긋나 JS 에러/오작동으로 보일 수 있다.
 *     - Cache-Control 지시자가 서로 다른 CDN 기준으로 해석되어(예:
 *       s-maxage 미지정) 의도한 것보다 오래/짧게 캐시될 수 있다.
 *
 * [탐지 방법]
 *   DNS CNAME 체인을 worker.js의 checkCnameGhs()와 동일한 DoH(1.1.1.1)
 *   패턴으로 조회해, 체인 안에 Bunny의 CNAME 대상 도메인(b-cdn.net,
 *   bunny.net 등)이 있으면 "Bunny가 이 요청 앞단에 있다"고 판단한다.
 *   런타임에는 요청이 Bunny를 거쳐 이미 이 Worker까지 도달한 뒤이므로
 *   Bunny 자체를 우회할 수는 없다 — 대신 두 CDN이 공존해도 안전하도록
 *   응답 캐시 헤더를 명시적으로/이중으로 정확하게 채운다.
 *
 * [적용]
 *   1. Cache-Control에 max-age(브라우저)와 s-maxage(CDN 공용) 모두 명시
 *      → Bunny/Cloudflare 어느 쪽이 캐시하든 동일한 신선도 기준을 따름.
 *   2. Bunny가 감지되면 CDN-Cache-Control(Bunny가 우선 인식하는 헤더)도
 *      함께 채워서, 표준 Cache-Control과 다른 해석으로 어긋나지 않게 함.
 *   3. 정적 자산(JS/CSS/폰트 등)은 Blogger/Google 원본 URL이 파일명에
 *      해시를 포함하는 불변 자산이므로 immutable + 1년 캐시를 강제해
 *      CDN 두 단계 모두 안정적으로 오래 캐시하되, HTML 문서는 짧은
 *      s-maxage + stale-while-revalidate로 위젯 상태가 너무 오래
 *      뒤처지지 않게 한다.
 *   4. Vary: Accept-Encoding, Cookie 는 명시적으로 관리한다 — Cookie를
 *      Vary에 넣지 않는 이유는 cache-reserve.js의 정책과 동일(서버가
 *      내려주는 HTML 자체는 쿠키별로 달라지지 않음). 대신 디바이스
 *      variant는 URL 파라미터로 분리되어 있으므로 CDN 캐시 키 충돌이
 *      나지 않는다.
 */

const DOH_URL = 'https://1.1.1.1/dns-query';

// Bunny CDN이 발급하는 CNAME 대상 도메인 패턴. 계정에 따라 서브도메인이
// 다르지만 항상 이 두 루트 도메인 중 하나로 끝난다(Bunny 공식 문서 기준).
const BUNNY_CNAME_SUFFIXES = ['.b-cdn.net', '.bunny.net'];

async function dnsCnameChain(host, maxHops = 10) {
  const chain = [];
  let current = host;
  const seen = new Set();
  for (let i = 0; i < maxHops; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    let cname;
    try {
      const resp = await fetch(`${DOH_URL}?name=${encodeURIComponent(current)}&type=CNAME`, {
        headers: { accept: 'application/dns-json' },
        cf     : { cacheTtl: 300, cacheEverything: true },
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const rec  = (data?.Answer || []).find(r => r.type === 5);
      cname = rec ? String(rec.data).replace(/\.$/, '').toLowerCase() : null;
    } catch (_) { break; }
    if (!cname) break;
    chain.push(cname);
    current = cname;
  }
  return chain;
}

// ── Bunny 감지 (짧은 인스턴스 메모리 캐시 — DoH 호출 반복 방지) ──────
const _bunnyCache = new Map(); // host → { val, exp }
const BUNNY_CACHE_TTL_MS = 10 * 60 * 1000; // 10분 — DNS는 자주 안 바뀜

export async function detectBunnyCdn(host) {
  if (!host) return false;
  const cached = _bunnyCache.get(host);
  if (cached && Date.now() < cached.exp) return cached.val;

  let isBunny = false;
  try {
    const chain = await dnsCnameChain(host);
    isBunny = chain.some(c => BUNNY_CNAME_SUFFIXES.some(suf => c.endsWith(suf)));
  } catch (_) { isBunny = false; }

  _bunnyCache.set(host, { val: isBunny, exp: Date.now() + BUNNY_CACHE_TTL_MS });
  if (_bunnyCache.size > 2000) {
    const now = Date.now();
    for (const [k, e] of _bunnyCache) if (now > e.exp) _bunnyCache.delete(k);
  }
  return isBunny;
}

// ── HTML 응답용 CDN-안전 Cache-Control 빌더 ─────────────────────────
// existingCacheControl: routing.js의 buildCacheControl()이 만든 기존 값
// (max-age=N, public 등)을 그대로 존중하면서 s-maxage/CDN-Cache-Control만
// 보강한다. SWR 윈도우는 cache-reserve.js의 SWR_WINDOW_SEC(30분)과 맞춘다.
export function buildCdnCacheControl(existingCacheControl, ttlSec, isBunny) {
  const swrSec = Math.min(1800, Math.max(60, Math.floor(ttlSec / 2)));
  const parts = [existingCacheControl || `public, max-age=${ttlSec}`];
  if (!/s-maxage=/.test(parts[0])) parts.push(`s-maxage=${ttlSec}`);
  if (!/stale-while-revalidate/.test(parts[0])) parts.push(`stale-while-revalidate=${swrSec}`);
  const cacheControl = parts.join(', ');
  const extra = {};
  if (isBunny) {
    // Bunny는 CDN-Cache-Control을 표준 Cache-Control보다 우선 해석한다
    // (공식 문서 기준) — 동일한 정책을 명시적으로 한 번 더 적어 Bunny
    // 쪽 해석이 Cloudflare 쪽과 어긋나지 않게 한다.
    extra['cdn-cache-control'] = cacheControl;
  }
  return { cacheControl, extraHeaders: extra };
}

// ── 정적 자산(JS/CSS/폰트/이미지) 응답 헤더 보강 ─────────────────────
// Blogger/Google이 서빙하는 테마 JS/CSS는 이 Worker가 직접 만들지 않고
// 그대로 통과(proxyPass)시키므로 내용을 바꿀 수는 없지만, 응답 헤더는
// 이 Worker가 방문자에게 내려주는 최종 헤더이므로 여기서 강화할 수 있다.
// 목표: 두 CDN 계층 모두 안정적으로 오래 캐시해서 드롭다운/위젯이 참조
// 하는 JS/CSS가 매 요청 원본(Blogger/Google CDN)까지 왕복하며 타이밍에
// 따라 다른 버전이 섞이는 사고를 방지한다.
export function buildStaticAssetHeaders(existingHeaders, isBunny) {
  const h = new Headers(existingHeaders);
  const ct = (h.get('content-type') || '').toLowerCase();
  const isJsCss = ct.includes('javascript') || ct.includes('css');
  const isFont  = ct.includes('font') || ct.includes('woff');
  const isImg   = ct.includes('image/');

  if (isJsCss || isFont) {
    // Blogger/Google이 서빙하는 리소스는 콘텐츠 해시가 URL에 포함되는
    // 불변 자산이 대부분이므로 immutable + 1년으로 캐시해도 안전하다.
    h.set('cache-control', 'public, max-age=31536000, s-maxage=31536000, immutable');
  } else if (isImg) {
    h.set('cache-control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400');
  }
  if (isBunny) {
    h.set('cdn-cache-control', h.get('cache-control') || 'public, max-age=31536000');
  }
  // 인코딩 협상 차이로 CDN 캐시가 쪼개지는 것은 정상(콘텐츠가 실제로
  // 다르므로)이지만, Cookie 기준으로는 쪼개지 않는다 — 정적 자산에는
  // 애초에 쿠키별 변형이 없다.
  h.set('vary', 'Accept-Encoding');
  return h;
}
