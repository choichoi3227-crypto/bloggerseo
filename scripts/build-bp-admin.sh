#!/usr/bin/env bash
# bp-admin (Astro 관리자 패널) 빌드 스크립트
# ─────────────────────────────────────────────────────────────────────
# 1. bp-admin-src/ 에서 Astro 정적 빌드 실행 (astro.config.mjs: base='/bp-admin')
# 2. 산출물을 레포 루트의 bp-admin-dist/ 로 복사
#    - astro.config.mjs의 base='/bp-admin' 때문에 HTML 안의 모든 링크/에셋
#      URL은 이미 '/bp-admin/...' 프리픽스가 박혀 나온다. 반면 실제 파일
#      출력 위치는 build.format='file' 특성상 아래와 같이 나뉜다:
#        dist/bp-admin.html          (루트 페이지)
#        dist/bp-admin/login.html    (하위 페이지, astro가 자동으로 하위
#                                      경로 파일들은 폴더를 만들어 배치)
#        dist/_astro/*.js            (에셋은 base와 무관하게 항상 루트)
#    - 이 스크립트는 _astro/ 를 bp-admin/_astro/ 로도 복사해 브라우저가
#      요청하는 '/bp-admin/_astro/x.js' 경로와 실제 파일 위치를 맞춘다.
#    - worker.js/bp-admin-router.js는 이 결과물을 rewrite 없이 그대로
#      env.BP_ADMIN_ASSETS.fetch(request)로 넘기기만 하면 된다.
#
# 사용법: 레포 루트에서 `bash scripts/build-bp-admin.sh` 실행 후
#         `wrangler deploy` (또는 `npm run deploy`)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/bp-admin-src"
OUT_DIR="$ROOT_DIR/bp-admin-dist"

echo "▶ bp-admin Astro 빌드 시작 ($SRC_DIR)"
cd "$SRC_DIR"

if [ ! -d node_modules ]; then
  echo "  node_modules 없음 → npm install 실행"
  npm install
fi

rm -rf .astro dist
npm run build

echo "▶ 산출물을 $OUT_DIR 로 복사"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/bp-admin"

# 루트 페이지 (dist/bp-admin.html)
cp "$SRC_DIR/dist/bp-admin.html" "$OUT_DIR/bp-admin.html"

# 하위 페이지들 (dist/bp-admin/*.html)
if [ -d "$SRC_DIR/dist/bp-admin" ]; then
  cp -r "$SRC_DIR/dist/bp-admin/." "$OUT_DIR/bp-admin/"
fi

# 정적 에셋: dist/_astro → bp-admin-dist/bp-admin/_astro
# (브라우저가 '/bp-admin/_astro/...' 로 요청하기 때문)
if [ -d "$SRC_DIR/dist/_astro" ]; then
  cp -r "$SRC_DIR/dist/_astro" "$OUT_DIR/bp-admin/_astro"
fi

echo "▶ 완료. 산출물 목록:"
find "$OUT_DIR" -type f | sort

echo ""
echo "다음 단계: wrangler deploy (또는 npm run deploy) 로 배포하세요."
