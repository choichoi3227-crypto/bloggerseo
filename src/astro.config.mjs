// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// BloggerSEO 관리자 패널(/bp-admin) 프론트엔드.
//
// 아키텍처 메모:
// - output: 'static' — Cloudflare Workers 위에서 별도의 Astro SSR 런타임을
//   돌리지 않는다. 대신 순수 정적 HTML/CSS/JS로 빌드해서 기존 worker.js가
//   Assets(또는 KV)로 서빙한다. 이렇게 하면 무한 확장성(정적 자산은
//   Cloudflare 엣지 캐시가 거의 전부 처리)과 콜드스타트 없는 응답속도를
//   동시에 얻을 수 있다.
// - base: '/bp-admin' — 실제 서비스 경로가 {도메인}/bp-admin 이므로 모든
//   내부 링크/에셋 경로가 자동으로 이 프리픽스를 갖도록 한다.
// - React는 필요한 위젯(에디터, 차트, 실시간 통계 등)에만 아일랜드로
//   삽입한다. 정적인 레이아웃/네비게이션/폼 뼈대는 Astro 컴포넌트로 남겨
//   두어 JS 번들 크기와 초기 로딩 속도를 최소화한다(하이브리드 이점).
export default defineConfig({
  output: 'static',
  base: '/bp-admin',
  trailingSlash: 'never',
  outDir: './dist',
  build: {
    // 'file' — login.astro → login.html (디렉토리+index.html 대신 단일
    // 파일). Cloudflare Workers Assets의 html_handling이 확장자 없는
    // 요청(/bp-admin/login)을 이 파일에 직접 매핑하므로, 'directory'
    // 포맷에서 발생하던 트레일링 슬래시 리다이렉트 문제(리다이렉트 시
    // /bp-admin 프리픽스가 유실되는 문제)를 근본적으로 피할 수 있다.
    format: 'file',
  },
  integrations: [react()],
  vite: {
    define: {
      __BP_ADMIN_BASE__: JSON.stringify('/bp-admin'),
    },
  },
});
