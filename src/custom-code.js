/**
 * 커스텀 헤더/바디/푸터 코드 삽입
 * ─────────────────────────────────────────────────────────────────────
 * alpack-2(presslearn) 플러그인의 "헤더/푸터 코드 삽입" 기능을 이식한
 * 모듈. 관리자가 GA4 스크립트, 네이버 웹마스터도구 인증 태그, 각종
 * 추적/광고 스크립트를 워드프레스 테마 파일을 건드리지 않고 삽입할 수
 * 있게 해주던 기능을, bp-admin/settings에서 저장한 값을 KV에서 읽어
 * Blogger 프록시 HTML에 주입하는 방식으로 재구현했다.
 *
 * 원본과의 차이:
 *   - 원본은 워드프레스 옵션(get_option)에서 값을 읽었으나, 여기서는
 *     KV(store.js)를 사용한다. 저장/조회는 src/bp-admin-router.js의
 *     /bp-admin/api/custom-code 엔드포인트를 통해 이루어진다.
 *   - 4개 삽입 지점(head, body-open, before-closing-body, footer)을
 *     동일하게 유지했다.
 *   - HTML 주석으로 삽입 범위를 표시하는 것도 원본과 동일하게 유지해
 *     디버깅 시 어디까지가 커스텀 코드인지 쉽게 식별할 수 있게 했다.
 *
 * 보안 유의사항: 이 기능은 의도적으로 임의의 HTML/JS를 그대로 페이지에
 * 삽입한다(GA4, 광고 스크립트 등이 원래 그런 형태로 배포되기 때문).
 * 따라서 /bp-admin/api/custom-code 저장 엔드포인트는 반드시 인증된
 * 관리자만 호출할 수 있어야 하며(bp-admin-router.js가 이미 세션 인증
 * 이후 섹션에 배치해 이를 보장한다), sanitize를 하지 않는다 — 이는
 * 원본 플러그인과 동일한 신뢰 모델이다(사이트 소유자 자신이 입력하는
 * 코드이므로 XSS 방어 대상이 아니라 신뢰된 입력으로 취급).
 */

import { kvGetJson, kvSetJson } from './store.js';

const CUSTOM_CODE_KEY = 'bpadmin:customcode';

/**
 * @typedef {object} CustomCodeConfig
 * @property {boolean} enabled
 * @property {string} headCode - </head> 직전에 삽입
 * @property {string} bodyOpenCode - <body> 직후에 삽입
 * @property {string} beforeClosingBodyCode - </body> 직전(다른 스크립트보다 먼저)
 * @property {string} footerCode - </body> 직전(다른 스크립트보다 나중, 우선순위 낮음)
 */

export async function getCustomCodeConfig(env) {
  const stored = await kvGetJson(env, CUSTOM_CODE_KEY);
  return {
    enabled: !!stored?.enabled,
    headCode: stored?.headCode || '',
    bodyOpenCode: stored?.bodyOpenCode || '',
    beforeClosingBodyCode: stored?.beforeClosingBodyCode || '',
    footerCode: stored?.footerCode || '',
  };
}

export async function saveCustomCodeConfig(env, config) {
  const sanitizedConfig = {
    enabled: !!config.enabled,
    headCode: String(config.headCode || '').slice(0, 20_000),
    bodyOpenCode: String(config.bodyOpenCode || '').slice(0, 20_000),
    beforeClosingBodyCode: String(config.beforeClosingBodyCode || '').slice(0, 20_000),
    footerCode: String(config.footerCode || '').slice(0, 20_000),
  };
  await kvSetJson(env, CUSTOM_CODE_KEY, sanitizedConfig);
  return sanitizedConfig;
}

function wrapWithComment(label, code) {
  return `\n<!-- BP-Admin ${label} -->\n${code}\n<!-- /BP-Admin ${label} -->\n`;
}

/**
 * HTML에 커스텀 코드 4곳을 모두 삽입한다. transformHtml() 파이프라인의
 * 마지막 단계 근처에서 호출하는 것을 권장한다(다른 SEO 태그 삽입이
 * 끝난 뒤에 실행해야 </head> 등의 위치가 안정적이다).
 */
export function injectCustomCode(html, config) {
  if (!config || !config.enabled) return html;
  let out = html;

  if (config.headCode.trim()) {
    const block = wrapWithComment('Header Code', config.headCode);
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${block}</head>`) : out;
  }

  if (config.bodyOpenCode.trim()) {
    const block = wrapWithComment('Body Open Code', config.bodyOpenCode);
    // <body ...> 태그 직후(속성 유무 모두 대응)
    out = /<body\b[^>]*>/i.test(out)
      ? out.replace(/(<body\b[^>]*>)/i, `$1${block}`)
      : out;
  }

  if (config.beforeClosingBodyCode.trim() || config.footerCode.trim()) {
    const blocks = [
      config.beforeClosingBodyCode.trim() ? wrapWithComment('Before Closing Body Code', config.beforeClosingBodyCode) : '',
      config.footerCode.trim() ? wrapWithComment('Footer Code', config.footerCode) : '',
    ].join('');
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${blocks}</body>`) : out;
  }

  return out;
}
