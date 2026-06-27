# BloggerSEO Worker v6

## 📋 신규 기능 (v5 → v6)

| 기능 | 설명 |
|------|------|
| **자동 스키마 마크업** | Article, FAQ(AI 추출), Breadcrumb, Product 자동 생성 |
| **Argo Smart Routing** | 지역 레이턴시 기반 최적 경로 자동 선택 (KR→JP→US→EU) |
| **Regional Tiered Cache** | 지역별 캐시 계층 구조 + Redis 영속 히트율 추적 |
| **Priority Routing** | 봇(Tier1) > 모바일(Tier2) > 데스크탑(Tier3) 우선순위 처리 |
| **Cache Reserve (4h)** | SWR 지원, 백그라운드 재검증, URL 단위 무효화 |
| **자체 NoSQL 스토리지** | Upstash Redis 기반 (CF KV/D1 완전 미사용) |
| **Load Balancer** | inFlight 기반, 503+Retry-After, 워커 heartbeat |
| **Cron: 사이트맵(1h)/RSS(30m)** | Redis 저장 후 엔드포인트 서빙 |
| **SEO 극대화** | 구글/네이버/빙 인증태그, og:locale, dable, IndexNow 힌트 |
| **관리 패널** | `/panel` SPA: 대시보드, 캐시, 라우팅, LB, 애널리틱스, IP 차단 |

---

## 🚀 빠른 시작

### 1. Upstash Redis 설정 (필수)
1. [https://upstash.com](https://upstash.com) 가입 → Redis 데이터베이스 생성
2. **Global** 지역 선택 (엣지 레이턴시 최소화)
3. **REST API URL**과 **REST Token** 복사

### 2. wrangler.toml 수정
```toml
[vars]
UPSTASH_REDIS_URL   = "https://YOUR-DB.upstash.io"
UPSTASH_REDIS_TOKEN = "YOUR-TOKEN"
PANEL_SECRET        = "강력한-비밀키-입력"
SITE_BASE_URL       = "https://yourdomain.com"
SITE_TITLE          = "내 블로그 이름"

# 선택: 검색엔진 인증
GOOGLE_SITE_VERIFY  = "google 서치콘솔 인증 코드"
NAVER_SITE_VERIFY   = "네이버 서치어드바이저 인증 코드"
BING_SITE_VERIFY    = "빙 웹마스터 인증 코드"

# 선택: CF Workers AI (FAQ 자동 추출)
AI_FAQ_ENABLED      = "true"
```

### 3. KV 네임스페이스 설정
```toml
[[kv_namespaces]]
binding = "SLUG_KV"
id      = "기존 KV ID 유지"
```

### 4. 배포
```bash
npm install
wrangler deploy
```

### 5. Workers AI 바인딩 (FAQ 자동 추출, 선택)
```toml
# wrangler.toml에 추가
[ai]
binding = "AI"
```

---

## 🛡️ 관리 패널

`https://yourdomain.com/panel` 접속 → 시크릿 키 입력

| 탭 | 기능 |
|----|------|
| 📊 대시보드 | 총 요청, 에러율, 레이턴시, 워커 부하, 상태 코드 분포 |
| 💾 캐시 관리 | Cache Reserve 현황, 전체 삭제 |
| 🌐 라우팅 상태 | 지역별 캐시 히트율 (KR/JP/US/EU/SG/AU) |
| ⚖️ 로드밸런서 | 활성 인스턴스 목록, 부하 현황 |
| 📈 캐시 애널리틱스 | 캐시 HIT/MISS, 페이지뷰, 지역/디바이스 분포 |
| 🛡️ 보안/IP 관리 | IP 차단/해제, 차단 목록 조회 |
| 🗺️ 사이트맵/RSS | 즉시 생성, Cron 스케줄 확인 |

---

## 📡 API 엔드포인트

| 경로 | 설명 |
|------|------|
| `/sitemap.xml` | 자동 생성 사이트맵 (1시간 캐시) |
| `/rss.xml` | 자동 생성 RSS 피드 (30분 캐시) |
| `/atom.xml` | RSS와 동일 |
| `/__debug` | 워커 상태 정보 |
| `/__metrics` | 실시간 메트릭 (JSON) |
| `/__lb_status` | 로드밸런서 상태 |
| `/__cache_stats` | Cache Reserve 통계 |
| `/panel` | 관리 패널 SPA |

---

## 🏗️ 아키텍처

```
요청 → IP 차단 체크 → Priority Routing (티어 결정)
     → Argo Smart Routing (지역 선택)
     → Rate Limit
     → Cache Reserve L2 조회 (Redis)
       ├─ HIT → 반환 (SWR이면 백그라운드 재검증)
       └─ MISS → 슬러그 라우팅 → Load Balancer
               → Origin Fetch (Argo 경로)
               → HTML 변환 파이프라인
                 ├─ 스키마 마크업 (Article/FAQ/Breadcrumb/Product)
                 ├─ SEO 태그 (구글/네이버/빙)
                 ├─ 모바일/데스크탑 최적화
                 └─ 성능 최적화
               → Cache Reserve 저장 (4h TTL)
               → 응답 반환
```

---

## ⚙️ 스키마 마크업 동작

| 스키마 | 조건 | AI 사용 |
|--------|------|---------|
| WebSite | 항상 | ❌ |
| Article | 포스트/페이지 | ❌ |
| FAQPage | HTML에 Q&A 패턴 or AI 추출 | ✅ (선택) |
| BreadcrumbList | URL 경로 2단계+ | ❌ |
| Product | 가격 패턴 감지 | ❌ |

---

## 🔧 환경 변수 전체 목록

| 변수 | 필수 | 설명 |
|------|------|------|
| `UPSTASH_REDIS_URL` | ✅ | Upstash Redis REST URL |
| `UPSTASH_REDIS_TOKEN` | ✅ | Upstash 인증 토큰 |
| `PANEL_SECRET` | ✅ | 관리 패널 시크릿 키 |
| `SITE_BASE_URL` | ✅ | 사이트 기본 URL (사이트맵용) |
| `SITE_TITLE` | 권장 | 사이트 이름 (RSS용) |
| `RATE_LIMIT_PER_MIN` | 선택 | 분당 요청 제한 (기본 600) |
| `CACHE_RESERVE_TTL_SEC` | 선택 | 캐시 만료 (기본 14400 = 4h) |
| `GOOGLE_SITE_VERIFY` | 선택 | 구글 서치콘솔 인증 |
| `NAVER_SITE_VERIFY` | 선택 | 네이버 서치어드바이저 인증 |
| `BING_SITE_VERIFY` | 선택 | 빙 웹마스터 인증 |
| `AI_FAQ_ENABLED` | 선택 | AI FAQ 추출 활성화 (true/false) |
