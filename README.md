# bp-admin 1단계: 로그인 + 대시보드 뼈대

## 무엇이 바뀌었나

### 수정된 파일 (기존 bloggerseo 레포)
- `worker.js` — `/bp-admin` 및 `/bp-admin/api/*` 라우팅 분기 추가 (기존 로직은 그대로)
- `wrangler.toml` — `[assets]` 바인딩(`BP_ADMIN_ASSETS`) 추가, `directory`를 실제 산출물 경로(`./bp-admin-dist`)로 수정
- `src/bp-admin-router.js` — 잘못된 asset 경로 rewrite 로직 제거 (아래 "404 버그 원인" 참고)
- `package.json` — `npm run deploy` 실행 시 bp-admin 빌드를 자동 선행하도록 수정

### 신규 파일 (기존 bloggerseo 레포에 추가)
- `src/bp-admin-auth.js` — 계정/세션/비밀번호 해싱 (KV 기반, 별도 D1 불필요)
- `src/bp-admin-router.js` — `/bp-admin` API 핸들러 + 정적 자산 서빙/인증 게이트
- `scripts/build-bp-admin.sh` — Astro 빌드 + 산출물을 `bp-admin-dist/`로 재배치하는 스크립트

### 신규 프로젝트 (Astro + React 하이브리드 프론트엔드)
- `bp-admin-src/` — Astro 프로젝트 루트(`astro.config.mjs`, `package.json`, `src/pages` 등). **레포에 커밋되지만 `node_modules/`, `dist/`, `.astro/`는 제외됩니다.**
- `bp-admin-dist/` — 빌드 산출물. **레포에 커밋하지 않습니다** (`.gitignore`에 추가됨). 배포 전 매번 새로 생성해야 합니다.

## `/bp-admin/login` 404 버그 원인 (이번에 수정)

세 가지 문제가 겹쳐 있었습니다.

1. **Astro 빌드가 한 번도 실행되지 않았음** — `bp-admin-dist/`(및 `bp-admin-src/dist/`)가 레포에 없어 서빙할 HTML 자체가 존재하지 않았습니다.
2. **`bp-admin-src/` 내부 상대경로 및 대소문자 오류** — `astro.config.mjs`가 있는 폴더를 Astro root로 볼 때, `src/pages/**/*.astro`의 `import` 상대경로 깊이가 실제 폴더 깊이와 맞지 않았고(`../layouts/...`가 `../../layouts/...`여야 하는 경우 등), 컴포넌트 파일명(`Adminlayout.astro`, `Dashboardsummary.tsx`, `Statuspulse.tsx`, `token.css`)이 import 시 참조하는 이름(`AdminLayout.astro`, `DashboardSummary.tsx`, `StatusPulse.tsx`, `tokens.css`)과 대소문자/이름이 달라 빌드 자체가 실패했습니다. 전부 표준 표기로 통일했습니다.
3. **`wrangler.toml`의 `[assets] directory`가 `./src`(Worker 소스 폴더)를 가리키고 있었음** — Astro 빌드 산출물이 아니라 `.astro`/`.js` 원본을 그대로 서빙하려 해서, 애초에 `login.html` 같은 파일이 생성될 수 없는 구조였습니다.
4. (부수적) `bp-admin-router.js`의 `rewriteToAssetsRequest`가 요청 경로에서 `/bp-admin` 프리픽스를 제거하고 있었는데, Astro의 `base: '/bp-admin'` 설정 때문에 HTML이 참조하는 스크립트/링크 URL 자체가 이미 `/bp-admin/...`로 박혀 나옵니다. 프리픽스를 제거하면 오히려 실제 파일 위치와 어긋나므로 이 rewrite를 제거하고, 대신 `_astro/` 산출물을 `bp-admin/_astro/`로도 복사해 경로를 맞췄습니다(`scripts/build-bp-admin.sh`가 처리).

## 배포 방법

1. 레포 루트에서 의존성 설치: `npm install` (Worker), 그리고 `cd bp-admin-src && npm install` (최초 1회, Astro)
2. `npm run deploy` 실행 — 내부적으로 `scripts/build-bp-admin.sh`(Astro 빌드 + `bp-admin-dist/` 재생성) → `wrangler deploy` 순으로 동작합니다.
   - Cloudflare Workers Builds(대시보드 자동 배포)를 쓴다면, 빌드 커맨드를 `npm run build:bp-admin`, 배포 커맨드를 `npx wrangler deploy`로 지정하세요.
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
- Astro `base: '/bp-admin'` 설정 때문에 산출물 경로와 브라우저 요청 경로를 일치시키려면 `_astro/` 폴더를 `bp-admin/_astro/`로도 복사해야 합니다. `scripts/build-bp-admin.sh`가 이 작업을 자동으로 처리하므로, **수동으로 `bp-admin-dist/`를 만들거나 옮기지 말고 항상 이 스크립트를 통해 생성하세요.**
- React는 `client:load`(로그인 폼, 즉시 필요) / `client:idle`(상태 펄스, 급하지 않음)로 구분해 초기 로딩을 최적화했습니다.
- 비밀번호는 HMAC-SHA256 3,000회 스트레치(자체 KDF)로 해싱됩니다. 기존 프로젝트가 전역적으로 `wasmCore.hmacSha256Hex`(WASM 가속)를 채택하고 있어 동일 계열로 통일했습니다.

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
