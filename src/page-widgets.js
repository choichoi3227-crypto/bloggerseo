/**
 * 페이지 위젯: SNS 공유 버튼 + 스크롤 트리거 팝업
 * ─────────────────────────────────────────────────────────────────────
 * alpack-2(presslearn) 플러그인의 두 기능을 이식:
 *   1. 소셜 공유 버튼(share.php) — 페이스북/X/카카오톡/네이버/밴드/라인
 *   2. 스크롤 팝업(presslearn-plugin.php의 presslearn_scroll_depth_frontend_script)
 *      — 지정한 스크롤 비율에 도달하면 팝업을 띄움
 *
 * 원본과의 차이:
 *   - 워드프레스 숏코드([presslearn_social_share]) 대신, Blogger 프록시
 *     HTML의 </body> 직전에 자동으로 공유 버튼 바를 삽입하는 방식을
 *     기본으로 한다(Blogger에는 숏코드 개념이 없으므로).
 *   - 설정은 KV에 저장하고 /bp-admin/settings에서 관리한다.
 *   - 카카오톡 공유는 Kakao JS SDK(카카오 개발자센터에서 발급한
 *     JavaScript 키 필요)를 그대로 사용한다 — 원본과 동일한 방식.
 */

import { kvGetJson, kvSetJson } from './store.js';

const SHARE_CONFIG_KEY = 'bpadmin:share:config';
const SCROLL_POPUP_CONFIG_KEY = 'bpadmin:scrollpopup:config';

// ── 공유 버튼 ────────────────────────────────────────────────────────

const SHARE_NETWORKS = ['facebook', 'twitter', 'kakaotalk', 'naver', 'band', 'line'];

export async function getShareConfig(env) {
  const stored = await kvGetJson(env, SHARE_CONFIG_KEY);
  return {
    enabled: !!stored?.enabled,
    networks: Array.isArray(stored?.networks) && stored.networks.length
      ? stored.networks.filter((n) => SHARE_NETWORKS.includes(n))
      : ['facebook', 'twitter', 'kakaotalk'],
    kakaoJsKey: stored?.kakaoJsKey || '',
    position: stored?.position === 'top' ? 'top' : 'bottom',
  };
}

export async function saveShareConfig(env, config) {
  const sanitized = {
    enabled: !!config.enabled,
    networks: Array.isArray(config.networks) ? config.networks.filter((n) => SHARE_NETWORKS.includes(n)) : [],
    kakaoJsKey: String(config.kakaoJsKey || '').slice(0, 200),
    position: config.position === 'top' ? 'top' : 'bottom',
  };
  await kvSetJson(env, SHARE_CONFIG_KEY, sanitized);
  return sanitized;
}

function escAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildShareButtonsHtml(pageUrl, pageTitle, config) {
  const url = escAttr(pageUrl);
  const title = escAttr(pageTitle);

  const buttons = config.networks.map((network) => {
    switch (network) {
      case 'facebook':
        return `<a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}" class="bseo-share-btn bseo-share-facebook" target="_blank" rel="noopener noreferrer">페이스북</a>`;
      case 'twitter':
        return `<a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(pageUrl)}&text=${encodeURIComponent(pageTitle)}" class="bseo-share-btn bseo-share-twitter" target="_blank" rel="noopener noreferrer">X</a>`;
      case 'naver':
        return `<a href="https://share.naver.com/web/shareView?url=${encodeURIComponent(pageUrl)}&title=${encodeURIComponent(pageTitle)}" class="bseo-share-btn bseo-share-naver" target="_blank" rel="noopener noreferrer">네이버</a>`;
      case 'band':
        return `<a href="https://band.us/plugin/share?body=${encodeURIComponent(pageTitle)}%0A${encodeURIComponent(pageUrl)}&route=${encodeURIComponent(pageUrl)}" class="bseo-share-btn bseo-share-band" target="_blank" rel="noopener noreferrer">밴드</a>`;
      case 'line':
        return `<a href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(pageUrl)}" class="bseo-share-btn bseo-share-line" target="_blank" rel="noopener noreferrer">라인</a>`;
      case 'kakaotalk':
        return `<a href="javascript:void(0)" class="bseo-share-btn bseo-share-kakao" data-url="${url}" data-title="${title}">카카오톡</a>`;
      default:
        return '';
    }
  }).join('');

  const kakaoInit = config.kakaoJsKey
    ? `<script src="https://developers.kakao.com/sdk/js/kakao.min.js"></script>
<script>if(window.Kakao&&!Kakao.isInitialized())Kakao.init(${JSON.stringify(config.kakaoJsKey)});</script>`
    : '';

  const kakaoHandler = config.networks.includes('kakaotalk')
    ? `<script>
document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('.bseo-share-kakao').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.preventDefault();
      if(!window.Kakao||!Kakao.isInitialized()){alert('카카오톡 공유를 사용할 수 없습니다.');return;}
      var shareUrl=btn.getAttribute('data-url'),shareTitle=btn.getAttribute('data-title');
      Kakao.Share.sendDefault({objectType:'feed',content:{title:shareTitle,description:'',imageUrl:'',link:{mobileWebUrl:shareUrl,webUrl:shareUrl}},buttons:[{title:'웹으로 보기',link:{mobileWebUrl:shareUrl,webUrl:shareUrl}}]});
    });
  });
});
</script>`
    : '';

  return `\n<!-- BP-Admin Social Share -->
${kakaoInit}
<div class="bseo-share-bar" style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0;">${buttons}</div>
${kakaoHandler}
<!-- /BP-Admin Social Share -->\n`;
}

/**
 * Blogger 글 페이지 HTML에 공유 버튼을 삽입한다. isPostPage(글 상세
 * 페이지 여부)는 호출부(worker.js)가 이미 판별한 값을 넘겨받는다 —
 * 목록/홈 페이지에는 공유 버튼을 넣지 않기 위함.
 */
export function injectShareButtons(html, config, { pageUrl, pageTitle, isPostPage }) {
  if (!config?.enabled || !isPostPage || config.networks.length === 0) return html;
  const block = buildShareButtonsHtml(pageUrl, pageTitle, config);

  if (config.position === 'top') {
    if (/<div[^>]+class=["'][^"']*post-body[^"']*["'][^>]*>/i.test(html)) {
      return html.replace(/(<div[^>]+class=["'][^"']*post-body[^"']*["'][^>]*>)/i, `$1${block}`);
    }
  }
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : html;
}

// ── 스크롤 트리거 팝업 ───────────────────────────────────────────────

export async function getScrollPopupConfig(env) {
  const stored = await kvGetJson(env, SCROLL_POPUP_CONFIG_KEY);
  return {
    enabled: !!stored?.enabled,
    content: stored?.content || '',
    scrollPercentage: Number(stored?.scrollPercentage) || 50,
    animation: ['fade', 'slide', 'zoom'].includes(stored?.animation) ? stored.animation : 'fade',
    repeatOncePerMonth: stored?.repeatOncePerMonth !== false,
  };
}

export async function saveScrollPopupConfig(env, config) {
  const sanitized = {
    enabled: !!config.enabled,
    content: String(config.content || '').slice(0, 10_000),
    scrollPercentage: Math.min(100, Math.max(1, Number(config.scrollPercentage) || 50)),
    animation: ['fade', 'slide', 'zoom'].includes(config.animation) ? config.animation : 'fade',
    repeatOncePerMonth: config.repeatOncePerMonth !== false,
  };
  await kvSetJson(env, SCROLL_POPUP_CONFIG_KEY, sanitized);
  return sanitized;
}

const ANIMATION_KEYFRAMES = {
  fade: 'from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}',
  slide: 'from{opacity:0;transform:translateY(-50px)}to{opacity:1;transform:translateY(0)}',
  zoom: 'from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}',
};

export function injectScrollPopup(html, config) {
  if (!config?.enabled || !config.content.trim()) return html;
  if (!/<\/body>/i.test(html)) return html;

  const keyframes = ANIMATION_KEYFRAMES[config.animation] || ANIMATION_KEYFRAMES.fade;
  const repeatCheck = config.repeatOncePerMonth ? 'true' : 'false';

  const block = `
<!-- BP-Admin Scroll Popup -->
<style>
.bseo-popup-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:99999;display:none;justify-content:center;align-items:center}
.bseo-popup-window{background:#fff;width:90%;max-width:500px;border-radius:8px;box-shadow:0 0 30px rgba(0,0,0,.5);max-height:80vh;overflow-y:auto;animation:bseoPopupAnim .3s ease-out}
.bseo-popup-body{padding:30px;line-height:1.6}
.bseo-popup-body img{max-width:100%;height:auto}
.bseo-popup-close{position:fixed;top:20px;right:20px;background:none;border:none;font-size:36px;cursor:pointer;color:#fff;z-index:100000}
@keyframes bseoPopupAnim{${keyframes}}
@media(max-width:768px){.bseo-popup-window{width:95%}.bseo-popup-body{padding:20px}}
</style>
<div id="bseo-popup-overlay" class="bseo-popup-overlay">
  <button type="button" class="bseo-popup-close" aria-label="닫기">&times;</button>
  <div class="bseo-popup-window"><div class="bseo-popup-body">${config.content}</div></div>
</div>
<script>
(function(){
  function getCookie(name){var m=document.cookie.match('(^|;)\\\\s*'+name+'\\\\s*=\\\\s*([^;]+)');return m?m.pop():'';}
  function setCookie(name,value,days){var d=new Date();d.setTime(d.getTime()+days*864e5);document.cookie=name+'='+value+';expires='+d.toUTCString()+';path=/';}
  var checkCookie=${repeatCheck};
  if(checkCookie&&getCookie('bseo_popup_shown'))return;
  var triggered=false;
  var overlay=document.getElementById('bseo-popup-overlay');
  window.addEventListener('scroll',function(){
    if(triggered)return;
    var pct=${config.scrollPercentage};
    var docH=document.documentElement.scrollHeight-window.innerHeight;
    if(docH<=0)return;
    if((window.scrollY/docH)*100>=pct){
      triggered=true;
      overlay.style.display='flex';
      if(checkCookie)setCookie('bseo_popup_shown','1',30);
    }
  });
  overlay.querySelector('.bseo-popup-close').addEventListener('click',function(){overlay.style.display='none';});
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.style.display='none';});
})();
</script>
<!-- /BP-Admin Scroll Popup -->
`;

  return html.replace(/<\/body>/i, `${block}</body>`);
}
