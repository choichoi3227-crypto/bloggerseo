#!/usr/bin/env python3
"""
BloggerSEO 배포 자동화 스크립트
사용법: python3 scripts/deploy.py [--wasm] [--dry-run]
  --wasm    : WASM 재빌드 후 배포
  --dry-run : wrangler deploy 실제 실행 안 함 (검증만)
"""

import argparse
import subprocess
import sys
import os
import json
import base64
import hashlib
from pathlib import Path

ROOT = Path(__file__).parent.parent

def run(cmd, cwd=None, check=True):
    """명령 실행 + 출력"""
    print(f"▶ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd or ROOT, capture_output=False, check=check)
    return result.returncode == 0

def build_wasm():
    """WASM AssemblyScript 재빌드 + wasm-blob.js 생성"""
    wasm_dir = ROOT / "wasm-src"
    print("\n[WASM] AssemblyScript 빌드 중...")

    # asc 빌드
    result = subprocess.run(
        ["npx", "asc", "assembly/index.ts", "-o", "bloggerseo.wasm",
         "--target", "release", "-O3", "--runtime", "stub", "--exportRuntime"],
        cwd=wasm_dir, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"[ERROR] asc 빌드 실패:\n{result.stderr}")
        return False

    wasm_path = wasm_dir / "bloggerseo.wasm"
    wasm_bytes = wasm_path.read_bytes()
    wasm_size = len(wasm_bytes)
    b64 = base64.b64encode(wasm_bytes).decode()
    digest = hashlib.sha256(wasm_bytes).hexdigest()[:16]

    blob_content = f"""// 자동 생성 파일 — 직접 수정하지 말 것.
// 생성: scripts/deploy.py --wasm
// WASM v5 ({wasm_size} bytes, sha256={digest}...)
export const WASM_BASE64 = "{b64}";
"""
    (wasm_dir / "wasm-blob.js").write_text(blob_content, encoding="utf-8")
    print(f"[WASM] 완료: {wasm_size} bytes (sha256={digest}...)")
    return True

def validate_files():
    """필수 파일 존재 확인"""
    required = [
        ROOT / "worker.js",
        ROOT / "wrangler.toml",
        ROOT / "src" / "wasm-loader.js",
        ROOT / "src" / "store.js",
        ROOT / "wasm-src" / "wasm-blob.js",
    ]
    ok = True
    for f in required:
        if not f.exists():
            print(f"[ERROR] 파일 없음: {f}")
            ok = False
        else:
            size = f.stat().st_size
            print(f"[OK]  {f.relative_to(ROOT)} ({size} bytes)")
    return ok

def check_wasm_blob():
    """wasm-blob.js가 올바른 base64 포함하는지 확인"""
    blob = (ROOT / "wasm-src" / "wasm-blob.js").read_text()
    if "WASM_BASE64" not in blob:
        print("[ERROR] wasm-blob.js에 WASM_BASE64 없음")
        return False
    # base64 추출 검증
    import re
    m = re.search(r'WASM_BASE64\s*=\s*"([^"]+)"', blob)
    if not m:
        print("[ERROR] WASM_BASE64 파싱 실패")
        return False
    try:
        data = base64.b64decode(m.group(1))
        # WebAssembly magic bytes: 0x00 0x61 0x73 0x6d
        if data[:4] != b'\x00asm':
            print(f"[ERROR] 유효하지 않은 WASM magic bytes: {data[:4].hex()}")
            return False
        print(f"[OK]  WASM 유효 ({len(data)} bytes)")
    except Exception as e:
        print(f"[ERROR] base64 디코딩 실패: {e}")
        return False
    return True

def check_wrangler_toml():
    """wrangler.toml 파싱 검증"""
    try:
        # toml 파싱 (Python 3.11+ 내장 tomllib, 하위 버전은 텍스트 검색)
        content = (ROOT / "wrangler.toml").read_text()
        checks = {
            "name": "bloggerseo" in content,
            "SLUG_KV binding": "SLUG_KV" in content,
            "no GITHUB vars": "GITHUB_TOKEN" not in content and "GITHUB_OWNER" not in content,
            "no CNAME_KV": "CNAME_KV" not in content,
            "no CACHE_RESERVE_KV": "CACHE_RESERVE_KV" not in content,
        }
        for k, v in checks.items():
            status = "[OK] " if v else "[WARN]"
            print(f"{status} wrangler.toml: {k}")
        return all(checks.values())
    except Exception as e:
        print(f"[ERROR] wrangler.toml 읽기 실패: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="BloggerSEO 배포 자동화")
    parser.add_argument("--wasm", action="store_true", help="WASM 재빌드")
    parser.add_argument("--dry-run", action="store_true", help="배포 안 함 (검증만)")
    args = parser.parse_args()

    print("=" * 60)
    print("BloggerSEO v5 배포 자동화")
    print("=" * 60)

    # 1. WASM 빌드 (--wasm 플래그 시)
    if args.wasm:
        if not build_wasm():
            sys.exit(1)

    # 2. 파일 검증
    print("\n[검증] 필수 파일 확인...")
    if not validate_files():
        sys.exit(1)

    # 3. WASM blob 검증
    print("\n[검증] WASM 바이너리 확인...")
    if not check_wasm_blob():
        sys.exit(1)

    # 4. wrangler.toml 검증
    print("\n[검증] wrangler.toml 확인...")
    check_wrangler_toml()

    # 5. 배포
    if args.dry_run:
        print("\n[DRY-RUN] 배포 건너뜀. --dry-run 없이 실행하면 배포됩니다.")
    else:
        print("\n[배포] wrangler deploy 실행...")
        run(["npx", "wrangler", "deploy"])
        print("\n✅ 배포 완료!")

if __name__ == "__main__":
    main()
