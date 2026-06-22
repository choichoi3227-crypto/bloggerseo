# Blogspot SEO & Performance Optimization Worker

Cloudflare Workers 기반 Blogger 커스텀 도메인 SEO 최적화 워커.  
**환경변수/Secret 설정 불필요. Route 추가만 하면 즉시 동작.**

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
- **성능 최적화**: dns-prefetch, preconnect, lazy-load img, defer scripts
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
| `slug:{path}` | 포스트 슬러그 기록 |
| `canonical:{path}` | 슬러그 변경 시 리다이렉트 대상 |
| `lb:rtt:{host}` | RTT EWMA 기록 |
| `lb:bw:{host}` | 대역폭 기록 |
