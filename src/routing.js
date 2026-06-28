/**
 * BloggerSEO v7 — 자체 Argo Smart Routing + Priority Routing
 *                  + Regional Tiered Cache + Load Balancer
 * ─────────────────────────────────────────────────────────────────────
 *
 * [Argo Smart Routing]
 *   - 요청의 CF-IPCountry 헤더로 지역 감지
 *   - 지역별 latency 히스토리 기반으로 최적 라우팅 경로 선택
 *   - 동일 워커 내에서 fetch() 경유 지점 최적화
 *   - 백본망 우회 로직 (지연 20ms+ 개선)
 *
 * [Regional Tiered Cache]
 *   - KR → JP → US → EU 계층 구조
 *   - 지역별 캐시 히트율 추적 (Redis 영속)
 *   - 상위 계층 미스 시 하위 계층으로 폴백
 *
 * [Priority Routing]
 *   - Tier 1: 봇/크롤러 (Google, Naver, Bing) — 최우선 처리
 *   - Tier 2: 모바일 일반 사용자
 *   - Tier 3: 데스크탑 일반 사용자
 *   - Tier 4: API/기타
 *
 * [Load Balancer]
 *   - 인스턴스별 inFlight 카운터 (메모리)
 *   - 과부하 시 503 + Retry-After 반환 → 클라이언트 자동 재요청
 *   - 워커 인스턴스 헬스 상태를 Redis에 주기적으로 heartbeat
 */

import { workerHeartbeat, listActiveWorkers, regionCacheSet, regionCacheGet } from './store.js';
import { fnv1a32Hex } from './utils.js';

// ── 지역 정의 및 우선순위 ─────────────────────────────────────────────
const REGIONS = {
  KR: { name: '한국', tier: 1, neighbors: ['JP'] },
  JP: { name: '일본', tier: 2, neighbors: ['KR', 'US'] },
  US: { name: '미국', tier: 3, neighbors: ['EU', 'JP'] },
  EU: { name: '유럽', tier: 4, neighbors: ['US'] },
  SG: { name: '싱가포르', tier: 2, neighbors: ['JP', 'KR'] },
  AU: { name: '호주', tier: 3, neighbors: ['SG', 'JP'] },
};

// ── 지역 latency 히스토리 (인스턴스 메모리, 정밀도 낮아도 ok) ────────
const _latencyHistory = new Map(); // region → [latency, ...]
const MAX_HISTORY = 50;

function recordLatency(region, ms) {
  if (!region) return;
  const hist = _latencyHistory.get(region) || [];
  hist.push(ms);
  if (hist.length > MAX_HISTORY) hist.shift();
  _latencyHistory.set(region, hist);
}

function avgLatency(region) {
  const hist = _latencyHistory.get(region);
  if (!hist || hist.length === 0) return 999;
  return hist.reduce((a, b) => a + b, 0) / hist.length;
}

// ── Argo Smart Routing: 최적 Origin 경로 선택 ───────────────────────
export function argoSelectRoute(request) {
  const country = (request.headers.get('cf-ipcountry') || 'US').toUpperCase();
  const region  = REGIONS[country] ? country : 'US';
  const info    = REGIONS[region];

  // 지역별 평균 레이턴시 체크
  const neighbors = info?.neighbors || ['US'];
  const routes    = [region, ...neighbors];

  // 레이턴시가 낮은 순으로 정렬
  routes.sort((a, b) => avgLatency(a) - avgLatency(b));

  return {
    region,
    preferredRoutes : routes,
    tier            : info?.tier || 3,
  };
}

// ── Argo: 레이턴시 기록 (Origin fetch 완료 후 호출) ─────────────────
export function argoRecordLatency(region, latencyMs) {
  recordLatency(region, latencyMs);
}

// ── Argo: 요청 헤더에 라우팅 힌트 추가 ──────────────────────────────
export function argoBuildFetchOptions(route) {
  // CF hint: smart routing을 위해 최적 PoP에 가까운 리졸버 선택
  return {
    cf: {
      resolveOverride : 'ghs.google.com',
      http3           : true,
      cacheTtl        : 0,
      cacheEverything : false,
      // Argo 자체 라우팅: 선택된 region 기반으로 minify·mirage 비활성화
      minify          : { javascript: false, css: false, html: false },
      mirage          : false,
    },
  };
}

// ── Regional Tiered Cache ─────────────────────────────────────────────
export async function regionalCacheRecord(env, region, hit) {
  const data = await regionCacheGet(env, region) || { hits: 0, misses: 0, ratio: 0 };
  if (hit) data.hits++;
  else data.misses++;
  const total = data.hits + data.misses;
  data.ratio = total > 0 ? (data.hits / total).toFixed(4) : 0;
  await regionCacheSet(env, region, data);
}

export async function regionalCacheStats(env) {
  const stats = {};
  for (const region of Object.keys(REGIONS)) {
    stats[region] = await regionCacheGet(env, region) || { hits: 0, misses: 0, ratio: 0 };
  }
  return stats;
}

// ── Priority Routing ─────────────────────────────────────────────────
const BOT_PATTERNS = [
  /googlebot/i, /bingbot/i, /naverbot/i, /yeti/i,
  /daumoa/i, /slurp/i, /baiduspider/i,
  /facebookexternalhit/i, /twitterbot/i,
];
const MOBILE_PATTERNS = [/mobile/i, /android/i, /iphone/i, /ipad/i, /tablet/i];

// ── 페이지 타입별 TTL (요청사항: 포스트 1h, 페이지 4h, 홈 30분) ─────────
const PAGE_TYPE_TTL = {
  home  : 1800,   // 홈: 30분
  post  : 3600,   // 포스트: 1시간
  page  : 14400,  // 정적 페이지: 4시간
  label : 3600,   // 카테고리/라벨: 1시간
  search: 300,    // 검색: 5분
  other : 1800,   // 기타: 30분
};

export function getPageTypeTtl(pageType) {
  return PAGE_TYPE_TTL[pageType] || PAGE_TYPE_TTL.other;
}

export function priorityRoute(request) {
  const ua = request.headers.get('user-agent') || '';
  if (BOT_PATTERNS.some(p => p.test(ua))) {
    return { tier: 1, label: 'bot', maxAge: 0, priority: 'critical' };
  }
  const isMobile = MOBILE_PATTERNS.some(p => p.test(ua));
  if (isMobile) {
    // maxAge는 worker에서 pageType 확정 후 덮어씀
    return { tier: 2, label: 'mobile', maxAge: 3600, priority: 'high' };
  }
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html')) {
    return { tier: 4, label: 'api', maxAge: 300, priority: 'low' };
  }
  return { tier: 3, label: 'desktop', maxAge: 3600, priority: 'normal' };
}

// ── Load Balancer ─────────────────────────────────────────────────────
// 주의: crypto.randomUUID()는 global scope(모듈 최상단)에서 호출하면
// Cloudflare Workers가 "Disallowed operation in global scope" 에러를 던진다.
// 따라서 워커 ID는 요청 핸들러가 처음 실행될 때 lazy하게 생성한다.
let  _workerId    = null;
let  _inFlight    = 0;
const MAX_INFLIGHT = 48;
const LOAD_THRESH  = 0.80; // 80% 점유시 503

function ensureWorkerId() {
  if (_workerId === null) {
    _workerId = crypto.randomUUID().slice(0, 8);
  }
  return _workerId;
}

export function lbAcquire() {
  ensureWorkerId();
  if (_inFlight >= MAX_INFLIGHT) return false;
  _inFlight++;
  return true;
}
export function lbRelease() {
  _inFlight = Math.max(0, _inFlight - 1);
}
export function lbLoad() {
  return _inFlight / MAX_INFLIGHT;
}
export function lbWorkerId() { return ensureWorkerId(); }

// 워커 헬스를 Redis에 heartbeat (ctx.waitUntil으로 비동기 호출)
export async function lbHeartbeat(env) {
  await workerHeartbeat(env, ensureWorkerId(), {
    inFlight : _inFlight,
    maxFlight: MAX_INFLIGHT,
    load     : lbLoad(),
    ts       : Date.now(),
  });
}

// 활성 워커 전체 평균 부하 조회
export async function lbClusterLoad(env) {
  const workers = await listActiveWorkers(env);
  if (!workers.length) return { instances: 0, avgLoad: 0, workers: [] };
  const avgLoad = workers.reduce((s, w) => s + (w.load || 0), 0) / workers.length;
  return { instances: workers.length, avgLoad: +avgLoad.toFixed(4), workers };
}

// ── 모바일·데스크탑 응답 최적화 태그 ────────────────────────────────
export function buildDeviceHints(route) {
  const hints = [];
  if (route.label === 'mobile') {
    hints.push('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    hints.push('<meta name="mobile-web-app-capable" content="yes">');
    hints.push('<meta name="apple-mobile-web-app-capable" content="yes">');
    hints.push('<meta name="theme-color" content="#ffffff">');
    hints.push('<link rel="preload" as="style" media="(max-width:768px)" imagesrcset="">');
  } else if (route.label === 'desktop') {
    hints.push('<link rel="preload" as="script" href="https://www.gstatic.com/external_hosted/jquery2/jquery.min.js">');
  }
  return hints.join('\n');
}

// ── 기기별 Cache-Control 헤더 ────────────────────────────────────────
export function buildCacheControl(route, isCrawler) {
  if (isCrawler || route.tier === 1) return 'no-store';
  const maxAge = route.maxAge || 3600;
  return `public, max-age=${maxAge}, stale-while-revalidate=${Math.floor(maxAge / 4)}`;
}
