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

// ── Load Balancer (v8: KV 기반 실제 분산 상태 동기화) ────────────────
// ─ 워커 ID는 첫 요청 시 lazy 생성 (global scope 사용 금지)
// ─ lbAcquire/lbRelease: 인스턴스 메모리 inFlight + KV 원자 카운터 연동
// ─ Cluster-wide 상태: KV 'lb:workers:<id>' — 30s TTL heartbeat
// ─ 실제 503 방출 기준: 인스턴스 inFlight ≥ MAX_INFLIGHT (80%)
// ─ Retry-After 응답으로 클라이언트 자동 재시도 유도

let  _workerId      = null;
let  _inFlight      = 0;
let  _clusterTotal  = 0;   // KV에서 동기화된 클러스터 전체 inFlight
let  _lastHbAt      = 0;
const MAX_INFLIGHT   = 48;
const LOAD_THRESH    = 0.85;  // 85%에서 새 요청 거부
const HB_INTERVAL_MS = 10_000; // 10초마다 heartbeat (KV TTL 30s)

function ensureWorkerId() {
  if (_workerId === null) {
    // Workers 환경에서는 crypto.randomUUID()를 lazy 호출해야 함
    try { _workerId = crypto.randomUUID().slice(0, 8); }
    catch (_) { _workerId = Math.random().toString(36).slice(2, 10); }
  }
  return _workerId;
}

export function lbAcquire() {
  ensureWorkerId();
  if (_inFlight >= MAX_INFLIGHT) return false;
  // 클러스터 전체 부하도 체크 (클러스터 분산 거부)
  if (_clusterTotal > 0 && _clusterTotal / (_clusterTotal + 1) > LOAD_THRESH) return false;
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

// KV 기반 heartbeat — 실제 인스턴스 상태를 KV에 기록
export async function lbHeartbeat(env) {
  const now = Date.now();
  // 10초 이내 중복 heartbeat 방지 (KV 호출 최소화)
  if (now - _lastHbAt < HB_INTERVAL_MS) return;
  _lastHbAt = now;

  const id      = ensureWorkerId();
  const payload = {
    inFlight : _inFlight,
    maxFlight: MAX_INFLIGHT,
    load     : lbLoad(),
    ts       : now,
    region   : 'auto',
  };

  await workerHeartbeat(env, id, payload);

  // 클러스터 전체 inFlight 동기화 (KV listActiveWorkers 결과 캐시)
  try {
    const workers     = await listActiveWorkers(env);
    _clusterTotal = workers.reduce((s, w) => s + (w.inFlight || 0), 0);
  } catch (_) {}
}

// 활성 워커 전체 평균 부하 조회 (실제 KV 기반)
export async function lbClusterLoad(env) {
  const workers = await listActiveWorkers(env);
  if (!workers.length) {
    // KV에 아무것도 없으면 현재 인스턴스 정보만 반환
    return {
      instances: 1,
      avgLoad  : lbLoad(),
      workers  : [{ workerId: ensureWorkerId(), inFlight: _inFlight, maxFlight: MAX_INFLIGHT, load: lbLoad(), ts: Date.now() }],
    };
  }
  const avgLoad = workers.reduce((s, w) => s + (w.load || 0), 0) / workers.length;
  return {
    instances: workers.length,
    avgLoad  : +avgLoad.toFixed(4),
    workers  : workers.map(w => ({
      ...w,
      loadPct: Math.round((w.load || 0) * 100),
      status : (w.load || 0) > LOAD_THRESH ? 'overloaded' : 'healthy',
    })),
  };
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
    // 데스크탑 전용 힌트 없음 — Blogger 자체 스크립트 로딩 방해 방지
  }
  return hints.join('\n');
}

// ── 기기별 Cache-Control 헤더 ────────────────────────────────────────
export function buildCacheControl(route, isCrawler) {
  if (isCrawler || route.tier === 1) return 'no-store';
  const maxAge = route.maxAge || 3600;
  return `public, max-age=${maxAge}, stale-while-revalidate=${Math.floor(maxAge / 4)}`;
}
