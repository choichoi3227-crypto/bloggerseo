# BloggerSEO Worker v7

## 📋 신규 기능 (v6 → v7)

| 기능 | 설명 |
|------|------|
| **100% 자체 제작 서버리스 Redis** | Durable Objects(SQLite storage) 기반, 64-way 샤딩으로 자체 한도를 우회해 확장. KV/D1 미사용, Upstash 미사용도 가능 |
| **자동 스키마 마크업** | 필수: Article, FAQ(AI 추출) / 선택: Breadcrumb, Product |
| **Argo Smart Routing** | 지역 레이턴시 기반 최적 경로 자동 선택 (KR→JP→US→EU) |
| **Regional Tiered Cache** | 지역별 캐시 계층 구조 + DO Redis 영속 히트율 추적 |
| **Priority Routing** | 봇(Tier1) > 모바일(Tier2) > 데스크탑(Tier3) 우선순위 처리 |
| **Cache Reserve (4h)** | SWR 지원, 백그라운드 재검증, URL 단위 무효화 |
| **Load Balancer** | inFlight 기반, 503+Retry-After, 워커 heartbeat |
| **Cron: 사이트맵(1h)/RSS(30m)** | DO Redis 저장 후 엔드포인트 서빙 |
| **SEO 극대화** | 구글/네이버/빙 인증태그, og:locale, IndexNow 힌트 |
| **관리 패널** | `/panel` SPA: 대시보드, 캐시, **Redis 클러스터 관리**, 라우팅, LB, 애널리틱스, IP 차단 |

---

## 🏗️ 스토리지 아키텍처 (v7 핵심 변경)

```
읽기 우선순위:
  1순위 DO Redis (자체 제작, Durable Objects)  ← 메인
  2순위 SLUG_KV (Cloudflare KV)                ← 백업
  3순위 Upstash Redis (REST API, 선택)         ← 추가 백업
  4순위 L1 메모리 (30초 TTL)                    ← 초고속 폴백
  5순위 L4 메모리 (TTL 없음)                    ← 최후 안전망

쓰기: 위 1~3순위 모두에 동시 기록 (하나가 죽어도 나머지로 즉시 폴백)
```

### ⚠️ "무한 용량"에 대한 정확한 설명
Durable Object 1개의 SQLite storage는 계정/플랜에 따라 자체 한도를 가집니다. 이 구현은
키를 해시로 `REDIS_SHARD_COUNT`개(기본 64개)의 **독립된 DO 인스턴스**에 분산시켜,
**총 용량 = 샤드 수 × 1개 DO 한도**로 선형 확장합니다. 샤드 수를 늘리면 코드 변경 없이
용량이 그만큼 늘어나며, 실용적으로는 거의 닿기 어려운 수준까지 커지지만 수학적으로
완전한 "무한"은 아닙니다. `wrangler.toml`의 `REDIS_SHARD_COUNT`만 조절하면 됩니다.

### Workers Free 플랜에서 동작하는 이유
Durable Objects는 SQLite storage backend를 사용하면 **Workers Free 플랜에서도 생성·사용 가능**합니다
(Key-Value storage backend는 유료 플랜 전용). 이 레포의 `MyDurableObject` 클래스는 SQLite storage만 사용하므로
별도 결제 없이 동작합니다. 단, Free 플랜에는 요청 수·GB-초 등의 일일 한도가 있으니
트래픽이 많다면 Workers Paid 플랜($5/월)으로 업그레이드를 검토하세요.

---

## 🚀 빠른 시작

### 1. 시크릿 설정 (필수, wrangler.toml에 직접 적지 않습니다)

```bash
# 관리 패널 인증 키 (필수)
wrangler secret put PANEL_SECRET

# Upstash Redis — 선택 사항(자체 DO Redis의 추가 백업이 필요할 때만)
wrangler secret put UPSTASH_REDIS_URL
wrangler secret put UPSTASH_REDIS_TOKEN

# 관리 패널의 Cloudflare 연동 기능(워커/라우트 자동 관리)을 쓸 경우
wrangler secret put CF_API_TOKEN
```

> 기존에 `wrangler.toml`에 평문으로 들어있던 Upstash URL/토�큰과 `PANEL_SECRET`은
> 모두 제거되었습니다. 이미 깃허브에 커밋된 적이 있다면 **반드시 해당 자격증명을
> 폐기(rotate)** 하세요 — git 히스토리에 남아있는 과거 값은 더 이상 유효하지 않은
> 새 값으로 교체해도 히스토리 자체에서는 지워지지 않습니다.

### 2. wrangler.toml의 비밀 아님 값만 직접 수정

```toml
[vars]
SITE_BASE_URL       = "https://yourdomain.com"
SITE_TITLE          = "내 블로그 이름"
REDIS_SHARD_COUNT   = "64"   # 자체 Redis 샤드 수 — 늘릴수록 총 용량 선형 증가
GOOGLE_SITE_VERIFY  = "..."
NAVER_SITE_VERIFY   = "..."
BING_SITE_VERIFY    = "..."
AI_FAQ_ENABLED      = "true"
```

### 3. KV 네임스페이스 (백업용, 선택이지만 권장)

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

첫 배포 시 `wrangler.toml`의 `[[migrations]]` 설정에 따라 `MyDurableObject` Durable Object
클래스가 자동으로 등록됩니다. 별도 작업이 필요 없습니다.

### 5. Workers AI 바인딩 (FAQ 자동 추출, 기본 포함됨)

`wrangler.toml`에 이미 `[ai]` 바인딩이 설정되어 있습니다. FAQ 추출에 사용하는 모델은
`@cf/meta/llama-3.1-8b-instruct-fast`입니다. Workers **Free** 플랜은 하루 10,000 neurons
한도가 있으므로, AI FAQ 추출 트래픽이 많다면 사용량을 모니터링하세요.

---

## 🛡️ 관리 패널

`https://yourdomain.com/panel` 접속 → 시크릿 키 입력

| 탭 | 기능 |
|----|------|
| 📊 대시보드 | 총 요청, 에러율, 레이턴시, 워커 부하, 상태 코드 분포 |
| 💾 캐시 관리 | Cache Reserve 현황, 전체 삭제 |
| 🧬 **Redis 관리** | **DO 샤드별 키 개수/용량, 전체 비우기(FLUSHALL)** |
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
| `/__debug` | 워커 상태 정보 (DO Redis 연동 여부 포함) |
| `/__metrics` | 실시간 메트릭 (JSON) |
| `/__lb_status` | 로드밸런서 상태 |
| `/__cache_stats` | Cache Reserve 통계 |
| `/panel` | 관리 패널 SPA |
| `/panel/api/redis_stats` | DO Redis 클러스터 통계 (인증 필요) |
| `/panel/api/redis_flush` | DO Redis 전체 비우기 (POST, 인증 필요) |

---

## 🏗️ 아키텍처

```
요청 → IP 차단 체크 → Priority Routing (티어 결정)
     → Argo Smart Routing (지역 선택)
     → Rate Limit
     → Cache Reserve L2 조회 (DO Redis 1순위 → KV → Upstash)
       ├─ HIT → 반환 (SWR이면 백그라운드 재검증)
       └─ MISS → 슬러그 라우팅 → Load Balancer
               → Origin Fetch (Argo 경로)
               → HTML 변환 파이프라인
                 ├─ 스키마 마크업 (필수: Article/FAQ, 선택: Breadcrumb/Product)
                 ├─ SEO 태그 (구글/네이버/빙)
                 ├─ 모바일/데스크탑 최적화
                 └─ 성능 최적화
               → Cache Reserve 저장 (4h TTL, DO Redis + KV + Upstash 동시 기록)
               → 응답 반환
```

---

## ⚙️ 스키마 마크업 동작

| 스키마 | 필수/선택 | 조건 | AI 사용 |
|--------|-----------|------|---------|
| WebSite | - | 항상 | ❌ |
| Article | **필수** | 포스트/페이지 | ❌ |
| FAQPage | **필수** | HTML에 Q&A 패턴 or AI 추출 | ✅ (Workers AI) |
| BreadcrumbList | 선택 | URL 경로 2단계+ | ❌ |
| Product | 선택 | 가격 패턴 감지 | ❌ |

---

## 🔧 환경 변수 / 시크릿 전체 목록

### 시크릿 (`wrangler secret put`으로 등록)
| 이름 | 필수 | 설명 |
|------|------|------|
| `PANEL_SECRET` | ✅ | 관리 패널 인증 키 |
| `UPSTASH_REDIS_URL` | 선택 | DO Redis의 추가 백업용 (없어도 정상 동작) |
| `UPSTASH_REDIS_TOKEN` | 선택 | 위와 동일 |
| `CF_API_TOKEN` | 선택 | 관리 패널의 Cloudflare 연동 기능용 |

### 변수 (`wrangler.toml`의 `[vars]`)
| 변수 | 필수 | 설명 |
|------|------|------|
| `SITE_BASE_URL` | ✅ | 사이트 기본 URL (사이트맵용) |
| `SITE_TITLE` | 권장 | 사이트 이름 (RSS용) |
| `REDIS_SHARD_COUNT` | 선택 | 자체 Redis 샤드 수 (기본 64, 늘릴수록 총 용량 증가) |
| `RATE_LIMIT_PER_MIN` | 선택 | 분당 요청 제한 (기본 600) |
| `CACHE_RESERVE_TTL_SEC` | 선택 | 캐시 만료 (기본 14400 = 4h) |
| `GOOGLE_SITE_VERIFY` | 선택 | 구글 서치콘솔 인증 |
| `NAVER_SITE_VERIFY` | 선택 | 네이버 서치어드바이저 인증 |
| `BING_SITE_VERIFY` | 선택 | 빙 웹마스터 인증 |
| `AI_FAQ_ENABLED` | 선택 | AI FAQ 추출 활성화 (true/false, 기본 true) |

---

## 🔎 참고: 무료 서버리스 Redis 대체 서비스 5종 (조사 자료)

이 레포는 DO 기반 자체 Redis를 1순위로 사용하지만, 비교 참고용으로 무료 티어가
있는 서버리스 Redis 호환 서비스 5개를 정리합니다. (2026년 6월 기준, 변동 가능)

| 서비스 | 무료 티어 | 특징 |
|--------|-----------|------|
| **Upstash Redis** | 월 50만 커맨드, 256MB, 대역폭 10GB/월 | HTTP REST API로 Cloudflare Workers/Vercel Edge 등에서 직접 사용 가능. 표준 Redis 프로토콜과 호환. 이 레포에서 선택적 백업으로 지원 |
| **Momento Cache** | 매달 50GB 무료 | AWS ElastiCache 팀 출신이 만든 서버리스 캐시로, Lambda 등과 연동이 쉬움. Redis 프로토콜이 아닌 자체 SDK 사용 |
| **Redis Cloud (Redis Ltd. 공식)** | Free 플랜 제공 | 공식 Redis 서비스로 RediSearch, RedisJSON 등 모듈 생태계가 가장 풍부하지만 TCP 전용이라 서버리스/엣지 런타임에서는 별도 프록시가 필요 |
| **Vercel Marketplace Redis (Upstash 기반)** | Upstash Redis를 그대로 사용하지만 커맨드당 2배 요금 | Vercel 대시보드에서 원클릭 연동, Vercel 생태계에 한정하면 설정이 가장 단순 |
| **AWS ElastiCache Serverless** | AWS 프리티어 가입 시점에 따라 일부 무료 사용량 제공(신규 가입자 기준) | VPC 내부에서만 동작, Cloudflare Workers 같은 외부 엣지 런타임에서는 직접 연결 불가 |

> 참고: Cloudflare 자체 KV/D1도 무료 티어를 제공하지만 Redis 호환 명령어(LPUSH, SCAN
> 등)를 지원하지 않으므로 이 비교에서는 제외했습니다. 이 레포는 정확히 그 빈틈을
> DO 기반 자체 Redis 구현으로 메우는 방식입니다.
