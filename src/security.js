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
export function isVpnOrProxy(request, env) {
  if (String(env.VPN_AUTO_BLOCK_ENABLED || 'true') !== 'true') return false;
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
