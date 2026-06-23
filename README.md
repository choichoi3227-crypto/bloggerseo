# Blogspot SEO & Performance Optimization Worker

Cloudflare Workers 기반 Blogger 커스텀 도메인 SEO 최적화 워커.
**환경변수/Secret 설정 불필요. Route 추가만 하면 즉시 동작.**

> **v3**: Durable Objects를 완전히 제거하고 GitHub 레포 JSON 상태 저장으로
> 대체했습니다. WASM(AssemblyScript) 가속과 EC2/Linux급 인프라 기능
> (메트릭, 레이트리밋, 재시도, 동시성 게이트)이 추가되었습니다.
> 신규 기능은 모두 **opt-in**이며, 추가 설정 없이는 v2와 100% 동일하게
> 동작합니다. 자세한 내용은 [v3 변경사항](#v3-변경사항) 섹션 참고.

---

## 동작 원리

```
사용자 요청 (blog.example.com)
        │
        ▼
[1.1.1.1 DoH] CNAME 검증
  blog.example.com → ghs.google.com ?
        │
   YES  │  NO → 502 Bad Gateway
        ▼
[KV 캐시] 검증 결과 24시간 캐시
        │
        ▼
커스텀 도메인으로 직접 fetch
  https://blog.example.com/...
        │
   /feeds/* /sitemap*.xml   HTML 페이지
   /atom.xml /rss.xml            │
        │                        ▼
   그대로 반환        SEO 최적화 후 반환
                    - meta description
                    - canonical URL
                    - OG / Twitter 태그
                    - schema.org JSON-LD
                    - 성능 최적화 태그
```

### 핵심 변경사항 (구버전 대비)
- ❌ blogspot.com 원본 도메인 탐지 제거 (불필요)
- ✅ 커스텀 도메인으로 직접 fetch
- ✅ 1.1.1.1/dns-query DoH로 CNAME 검증 (ghs.google.com 여부)
- ✅ "사이트 준비 중" 페이지 제거 → 502 Bad Gateway로 대체
- ✅ RSS/Atom/Feed/Sitemap 모두 커스텀 도메인으로 정상 동작

---

## 설치

### 1. KV 네임스페이스 생성

```bash
wrangler kv namespace create "SLUG_KV"
wrangler kv namespace create "CACHE_RESERVE_KV"
```

생성된 ID를 `wrangler.toml`의 `id` 값에 입력.

### 2. 배포

```bash
wrangler deploy
```

### 3. 라우트 추가

Cloudflare 대시보드 → Workers & Pages → `blogspot-seo-worker` → Settings → Triggers

**Custom Domains** 또는 **Routes**에 커스텀 도메인 추가:
```
blog.example.com/*
www.example.com/*
```

> ghs.google.com CNAME이 있는 모든 서브도메인에 동작.  
> 도메인별 설정 불필요 — CNAME만 맞으면 자동 통과.

---

## Feed / Sitemap

별도 설정 없이 커스텀 도메인으로 동작:

| URL | 동작 |
|-----|------|
| `blog.example.com/feeds/posts/default` | Atom Feed |
| `blog.example.com/feeds/posts/default?alt=rss` | RSS Feed |
| `blog.example.com/sitemap.xml` | Sitemap |
| `blog.example.com/atom.xml` | Atom |
| `blog.example.com/rss.xml` | RSS |
| `blog.example.com/feeds/posts/default?alt=json` | JSON Feed |

Google Search Console, 피드 리더 등에서 커스텀 도메인 URL 그대로 사용 가능.

---

## SEO 기능

- **meta description** 자동 생성/보완
- **canonical URL** 커스텀 도메인 기준으로 주입
- **OG / Twitter Card** 태그 자동 주입
- **schema.org JSON-LD** (WebSite, Article, WebPage)
- **성능 최적화**: dns-prefetch, preconnect, lazy-load img (위젯 동작을 보존하기 위해 `<script>`에 강제 `defer`는 주입하지 않음)
- **반응형 이미지**: Blogger 네이티브 리사이즈를 활용한 `srcset` 자동 생성
- **슬러그 canonical**: 포스트 제목 변경 시 301 리다이렉트 자동 관리
- **모바일 파라미터** `?m=1` 제거

---

## CNAME 검증

요청 호스트의 DNS CNAME 레코드를 **1.1.1.1/dns-query** (Cloudflare DoH)로 조회.  
CNAME 체인을 최대 10단계까지 추적하여 최종적으로 `ghs.google.com`을 가리키는지 확인.

검증 결과는 KV에 **24시간** 캐시되어 이후 요청은 DNS 조회 없이 즉시 통과.

검증 실패 시: `502 Bad Gateway` (일반 텍스트, 사이트 준비 중 페이지 없음)

---

## 환경변수

**설정 불필요.** 모든 동작이 자동으로 처리됩니다.

---

## KV 구조

| 키 패턴 | 용도 |
|---------|------|
| `cname_ok:{host}` | CNAME 검증 캐시 (24h) |
| `origin:{path}` | 원본(날짜형) 경로 → 슬러그 매핑 |
| `alias:{titlePath}` | 평탄화된 슬러그 경로 → 원본 경로 |
| `lb:rtt:{host}` | RTT EWMA 기록 |
| `lb:bw:{host}` | 대역폭 기록 |
| `metrics:{minuteWindow}` | [v3] 분 단위 메트릭 집계 (요청수/에러/레이턴시 버킷) |
| `rl:{host}` | [v3] 레이트 리미터 토큰 버킷 상태 |

---

## v3 변경사항

### 1. Durable Objects 제거 → GitHub 레포 JSON 상태 저장

기존에 Durable Object(`TenantCoordinator`)가 메모리에서 처리하던
도메인별 동시성 제어 + circuit breaker를 **GitHub Contents API**로
완전히 대체했습니다.

- 상태 파일: `state/tenants/{sha256(host)[:16]}.json` (이 레포 안에 자동 생성됨)
- 매 요청마다 GitHub API를 실시간으로 호출(GET → 판정 → PUT 커밋)하는
  "실시간 강결합" 모드로 동작합니다.
- `HMAC-SHA256`으로 상태에 서명을 붙여, 레포가 외부에서 변조되지
  않았는지 매번 검증합니다.
- **GITHUB_TOKEN이 없으면 이 기능은 완전히 비활성(no-op)** 이며,
  나머지 모든 동작(SEO 최적화, 슬러그 라우팅 등)에는 영향이 없습니다.

#### 설정 방법

```bash
# 1) GitHub Fine-grained Personal Access Token 발급
#    권한: 이 레포에 대한 Contents: Read and write

# 2) secret 등록 (토큰 값은 대화형 프롬프트에 직접 입력 — 파일에 남지 않음)
npx wrangler secret put GITHUB_TOKEN

# 3) (선택) state 무결성 서명용 키도 등록 가능 — 미설정 시 서명 단계만 스킵
npx wrangler secret put STATE_SIGNING_KEY
```

`wrangler.toml`의 `[vars]`에서 동시성 한도/실패 임계치/쿨다운 등을
조정할 수 있습니다(`TENANT_MAX_CONCURRENCY`, `TENANT_FAILURE_THRESHOLD`,
`TENANT_OPEN_COOLDOWN_MS`).

> **주의**: 매 요청마다 GitHub API를 호출하므로 트래픽이 많은 사이트에서는
> GitHub API 레이트리밋(시간당 5,000회, 인증된 요청 기준)에 도달할 수
> 있습니다. 레이트리밋에 도달하거나 GitHub API가 응답하지 않는 경우에도
> **서비스는 절대 막히지 않고 통과(degrade gracefully)** 합니다.

### 2. WASM(AssemblyScript) 가속

`wasm-src/assembly/index.ts`에 작성된 AssemblyScript 코드를 `.wasm`으로
컴파일해 다음 기능을 가속합니다:

| 기능 | 용도 |
|------|------|
| 슬러그 생성 | 유니코드 정규화 기반 단일 패스 슬러그 생성 (한글/특수문자 처리) |
| SHA-256 | GitHub state 파일 경로용 호스트 해싱 |
| HMAC-SHA256 | GitHub state JSON 무결성 서명/검증 |
| FNV-1a32 | 캐시 키 해싱 (비암호화, 고속) |
| countOccurrences | HTML 사전 스캔 (정규식 단계 스킵 판단) |

모든 WASM 호출은 `src/wasm-loader.js`에서 try/catch로 감싸여 있으며,
**실패 시 동일한 결과를 내는 JS 구현으로 즉시 자동 전환**됩니다. WASM
바이너리는 base64로 인코딩되어 `wasm-src/wasm-blob.js`에 저장되고
`worker.js`가 이를 import합니다.

WASM 소스를 수정한 뒤에는 다음 명령으로 재빌드해야 합니다:

```bash
npm run build:wasm
```

### 3. EC2/Linux급 인프라 기능 (`src/infra.js`)

| 기능 | EC2/Linux 대응 개념 |
|------|---------------------|
| 구조화 로깅(JSON lines) | syslog / journald |
| 메트릭(레이턴시 히스토그램, 에러율) | Prometheus / node_exporter |
| 레이트 리미팅(토큰 버킷) | nginx `limit_req_zone` |
| 재시도 + 지수 백오프 + 지터 | systemd `Restart=on-failure`, AWS SDK 재시도 |
| 동시성 게이트(세마포어) | 워커 프로세스 풀 / PM2 cluster |
| 커넥션 최적화 힌트 | `keepalive_timeout`, HTTP/2·3 선호 |

신규 디버그/운영 엔드포인트:

| URL | 설명 |
|-----|------|
| `GET /__metrics?minutes=15` | 최근 N분 메트릭(요청수/에러율/레이턴시 분포 버킷) |
| `GET /__blogger_debug` | 기존 CNAME 진단 + GitHub tenant 상태 + WASM/JS 백엔드 표시 |
