# Blogspot SEO Worker

Cloudflare Workers 기반 Blogspot SEO & 성능 최적화 프록시.

## 필수 설정 (Secret 1개만)

**Cloudflare 대시보드** → Workers & Pages → `blogspot-seo-worker` → Settings → Variables and Secrets

| Secret 이름 | 값 | 설명 |
|---|---|---|
| `BLOGGER_API_KEY` | `AIza...` | Google Cloud Console에서 발급한 Blogger API 키 |

### Blogger API 키 발급 방법

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. APIs & Services → Library → **Blogger API v3** 검색 후 활성화
3. APIs & Services → Credentials → **Create Credentials → API key**
4. 발급된 키를 Cloudflare Workers Secret에 `BLOGGER_API_KEY`로 추가

---

## 배포

```bash
# 의존성 없음, wrangler만 필요
npm install -g wrangler

# KV 네임스페이스 생성 (처음 한 번만)
wrangler kv:namespace create SLUG_KV
wrangler kv:namespace create CACHE_RESERVE_KV

# wrangler.toml의 id 값을 위 명령 출력값으로 교체 후:
wrangler deploy
```

---

## 동작 원리

### Origin 탐지 순서
1. **KV 캐시** — 이미 탐지된 경우 즉시 반환
2. **Blogger API v3** — `BLOGGER_API_KEY`로 커스텀 도메인의 blogspot URL 조회
3. **HTTP fetch 폴백** — 301 Location 헤더 또는 HTML 본문에서 blogspot URL 파싱
4. **수동 설정** — `BLOGSPOT_ORIGIN` Secret으로 직접 지정 (최후 수단)

### 기능
- **SEO 최적화**: meta description, canonical, OG tags, Twitter Card, Schema.org JSON-LD 자동 주입
- **성능 최적화**: DNS prefetch, preconnect, lazy loading, script defer
- **KV 캐시**: HTML 응답 30분 캐시
- **슬러그 관리**: 포스트 제목 기반 SEO slug 생성 및 canonical 리다이렉트
- **로드 밸런싱**: 7가지 알고리즘 (단일 블로그는 오버헤드 없이 직통)

---

## 선택적 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `BLOGSPOT_ORIGIN` | 수동 blogspot URL (예: `https://xxxx.blogspot.com`) | - |
| `LB_ALGO` | 로드밸런서 알고리즘 | `least_rtt` |
| `LB_WEIGHTS` | 가중 RR 가중치 JSON | - |
| `LB_GEO_MAP` | 지역별 origin 매핑 JSON | - |
