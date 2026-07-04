import { kvGetJson, kvSetJson, kvGet, kvSet, blockIp } from './store.js';

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}
function deviceId(request) {
  const ua = request.headers.get('user-agent') || '';
  const al = request.headers.get('accept-language') || '';
  return `${ua}|${al}`.slice(0, 500);
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function hasCloudflareBotMfa(request, env) {
  if (String(env.PANEL_CF_BOT_MFA || 'true') !== 'true') return true;
  const score = Number(request.headers.get('cf-bot-score') || '99');
  const verified = request.headers.get('cf-verified-bot') === 'true';
  return verified || score >= (Number(env.PANEL_MIN_BOT_SCORE) || 30);
}

// [버그 수정] Bingbot이 사이트맵/피드 조회 시 403(VPN/Proxy 오탐으로 인한
// 자동 IP 차단)을 받는 문제가 보고됨. 원인은 아래 isVpnOrProxy()의
// 데이터센터 판별 정규식에 microsoft/azure/google cloud/amazon 등이
// 포함되어 있었던 것 — 그런데 Bingbot, Googlebot 등 주요 검색엔진
// 크롤러는 실제로 Microsoft Azure/Google Cloud/Amazon 소속 IP 대역에서
// 크롤링한다. 그 결과 검색엔진 공식 크롤러가 "데이터센터発 트래픽"으로
// 오판되어 VPN/Proxy로 차단되고, 심지어 blockIp()로 7일간 IP까지
// 차단되어 이후 재크롤링도 계속 실패하는 문제로 이어졌다.
//
// → 알려진 검색엔진 크롤러는 VPN/Proxy 차단 판정에서 제외한다.
//   1차: Cloudflare가 자체 검증한 request.cf.botManagement.verifiedBot
//        (Bot Management 활성화 플랜에서 제공, IP 스푸핑에 안전)
//   2차: verifiedBot 신호가 없는 플랜/요청에서는 User-Agent 패턴으로
//        보조 판별한다. UA는 스푸핑 가능하지만, 이 경로로 통과해도
//        하는 일은 "VPN 차단을 안 거는 것"뿐이고 사이트맵/RSS/일반
//        페이지 열람 이상의 권한을 주지 않으므로 리스크가 낮다.
const KNOWN_CRAWLER_UA = /googlebot|bingbot|naverbot|yeti|daumoa|slurp|baiduspider|duckduckbot|applebot|facebookexternalhit|twitterbot|linkedinbot|discordbot|telegrambot|indexnow/i;

export function isKnownSearchEngineCrawler(request) {
  const cf = request.cf || {};
  if (cf.botManagement && cf.botManagement.verifiedBot === true) return true;
  const ua = request.headers.get('user-agent') || '';
  return KNOWN_CRAWLER_UA.test(ua);
}

export function isVpnOrProxy(request, env) {
  if (String(env.VPN_AUTO_BLOCK_ENABLED || 'true') !== 'true') return false;
  if (isKnownSearchEngineCrawler(request)) return false; // 검색엔진 크롤러는 VPN 판정 제외
  const cf = request.cf || {};
  const threat = Number(cf.threatScore || 0);
  const asOrg = String(cf.asOrganization || '').toLowerCase();
  const dc = /(vpn|proxy|hosting|cloud|data center|datacenter|colo|vps|tor|m247|ovh|digitalocean|amazon|google cloud|microsoft|azure|hetzner|leaseweb|linode)/i.test(asOrg);
  return threat >= (Number(env.VPN_THREAT_SCORE) || 25) || dc;
}
export async function enforceVpnBlock(request, env) {
  if (!isVpnOrProxy(request, env)) return null;
  const ip = clientIp(request);
  await blockIp(env, ip, (Number(env.VPN_BLOCK_DAYS) || 7) * 86400).catch(() => {});
  return new Response('VPN/Proxy access blocked', { status: 403, headers: { 'cache-control': 'no-store' } });
}

export function injectAdSenseClickGuard(html) {
  if (!/pagead2\.googlesyndication\.com|adsbygoogle/i.test(html) || html.includes('bseo-ad-guard')) return html;
  const js = `<script class="bseo-ad-guard">(function(){let last=0;document.addEventListener('click',function(e){let n=e.target;for(;n&&n!==document;n=n.parentNode){let s=(n.src||n.href||'')+' '+(n.className||'')+' '+(n.id||'');if(/googlesyndication|googleads|adsbygoogle|adservice/i.test(s)){let now=Date.now();if(now-last<300)return;last=now;try{navigator.sendBeacon('/__ads_click',JSON.stringify({t:now,u:location.href}))}catch(_){fetch('/__ads_click',{method:'POST',keepalive:true,body:'{}'}).catch(function(){})}break}}},true)}())</script>`;
  return html.replace(/<\/body>/i, js + '\n</body>');
}
export async function handleAdsClick(request, env) {
  const ip = clientIp(request);
  const dev = await sha256Hex(deviceId(request));
  const windowHours = Number(env.ADS_CLICK_WINDOW_HOURS) || 1;
  const maxClicks = Number(env.ADS_MAX_CLICKS) || 3;
  const blockDays = Number(env.ADS_BLOCK_DAYS) || 7;
  const key = `state:ads:${ip}:${dev}`;
  const rec = await kvGetJson(env, key) || { count: 0, start: Date.now(), blockedUntil: 0 };
  const now = Date.now();
  if (now - rec.start > windowHours * 3600_000) { rec.count = 0; rec.start = now; }
  rec.count++;
  if (rec.count > maxClicks) rec.blockedUntil = now + blockDays * 86400_000;
  await kvSetJson(env, key, rec, Math.max(windowHours * 3600, blockDays * 86400));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
export async function shouldHideAds(request, env) {
  const ip = clientIp(request);
  const dev = await sha256Hex(deviceId(request));
  const rec = await kvGetJson(env, `state:ads:${ip}:${dev}`);
  return !!(rec?.blockedUntil && rec.blockedUntil > Date.now());
}
export function hideAds(html) {
  if (!/adsbygoogle|googlesyndication|googleads/i.test(html)) return html;
  return html
    .replace(/<ins\b[^>]*class=["'][^"']*adsbygoogle[^"']*["'][\s\S]*?<\/ins>/gi, '<div class="bseo-ad-hidden" aria-hidden="true" style="display:none!important"></div>')
    .replace(/<script\b[^>]+pagead2\.googlesyndication\.com[^>]*><\/script>/gi, '')
    .replace(/\(adsbygoogle\s*=\s*window\.adsbygoogle\s*\|\|\s*\[\]\)\.push\([^)]*\);?/gi, '');
}
export async function securitySettings(env) {
  return {
    adsClickWindowHours: Number(env.ADS_CLICK_WINDOW_HOURS) || 1,
    adsMaxClicks: Number(env.ADS_MAX_CLICKS) || 3,
    adsBlockDays: Number(env.ADS_BLOCK_DAYS) || 7,
    vpnAutoBlock: String(env.VPN_AUTO_BLOCK_ENABLED || 'true') === 'true',
    panelCfBotMfa: String(env.PANEL_CF_BOT_MFA || 'true') === 'true',
  };
}
