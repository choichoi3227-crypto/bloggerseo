# bp-admin 1단계: 로그인 + 대시보드 뼈대

## 무엇이 바뀌었나

### 수정된 파일 (기존 bloggerseo 레포)
- `worker.js` — `/bp-admin` 및 `/bp-admin/api/*` 라우팅 분기 추가 (기존 로직은 그대로)
- `wrangler.toml` — `[assets]` 바인딩(`BP_ADMIN_ASSETS`) 추가

### 신규 파일 (기존 bloggerseo 레포에 추가)
- `src/bp-admin-auth.js` — 계정/세션/비밀번호 해싱 (KV 기반, 별도 D1 불필요)
- `src/bp-admin-router.js` — `/bp-admin` API 핸들러 + 정적 자산 서빙/인증 게이트

### 신규 프로젝트 (Astro + React 하이브리드 프론트엔드)
- `bp-admin-src/` — 전체 소스. `npm install && npm run build`로 `dist/`가 생성됨
- `bp-admin-dist/` — 위 소스를 미리 빌드해 둔 산출물 (즉시 배포 가능하도록 동봉)

## 배포 방법

1. `bp-admin-step1/` 안의 파일들을 기존 bloggerseo 레포 루트에 그대로 덮어쓰기 (worker.js, wrangler.toml, src/*, bp-admin-dist/, bp-admin-src/)
2. `wrangler deploy`
3. 배포 후 `{도메인}/bp-admin/login`에 접속 → 계정이 하나도 없으므로 자동으로 "관리자 계정 만들기" 화면이 뜸 → 최초 계정 생성
4. 이후 `{도메인}/bp-admin`으로 로그인해 대시보드 확인

## 지금 이 단계에서 되는 것 / 안 되는 것

**됨:**
- `/bp-admin/login`에서 아이디+비밀번호 로그인 (Blogspot 계정과 무관한 별도 계정)
- 로그인 세션 유지(12시간, HttpOnly 쿠키)
- 대시보드에서 사이트 상태·캐시 히트율·차단 IP 수 등 실시간 조회
- 좌측 네비게이션 전체 뼈대 (글 관리/SEO/광고/성능/보안/설정)

**아직 안 됨 (다음 단계):**
- 실제 Blogger API 연동 (글 목록 조회, 작성, 수정, 이미지 업로드) — 지금은 "글 관리" 메뉴가 플레이스홀더
- alpack/aibp-pro 플러그인 기능 이식
- WP Rocket 수준 캐시 엔진 확장

## 설계 메모

- Astro는 `output: 'static'`, `build.format: 'file'`로 빌드됩니다 (예: `login.astro` → `login.html`). Cloudflare Workers Assets의 `html_handling = "auto-trailing-slash"`와 조합해, 확장자 없는 URL(`/bp-admin/login`)이 트레일링 슬래시 리다이렉트 없이 바로 해당 HTML에 매핑되도록 맞췄습니다.
- React는 `client:load`(로그인 폼, 즉시 필요) / `client:idle`(상태 펄스, 급하지 않음)로 구분해 초기 로딩을 최적화했습니다.
- 비밀번호는 HMAC-SHA256 3,000회 스트레치(자체 KDF)로 해싱됩니다. 기존 프로젝트가 전역적으로 `wasmCore.hmacSha256Hex`(WASM 가속)를 채택하고 있어 동일 계열로 통일했습니다.
