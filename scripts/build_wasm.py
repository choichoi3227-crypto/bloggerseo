#!/usr/bin/env python3
"""
WASM 빌드 자동화 스크립트
사용법: python3 scripts/build_wasm.py [--test]
  --test : 빌드 후 슬러그 생성 테스트 실행
"""

import sys
import os
import subprocess
import base64
import hashlib
import argparse
import struct
from pathlib import Path

ROOT     = Path(__file__).parent.parent
WASM_DIR = ROOT / "wasm-src"
WASM_OUT = WASM_DIR / "bloggerseo.wasm"
BLOB_OUT = WASM_DIR / "wasm-blob.js"

def build():
    print("[WASM] AssemblyScript 컴파일 시작...")
    result = subprocess.run(
        ["npx", "asc", "assembly/index.ts", "-o", "bloggerseo.wasm",
         "--target", "release", "-O3", "--runtime", "stub", "--exportRuntime"],
        cwd=WASM_DIR, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"[ERROR] 컴파일 실패:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")
        return False

    if not WASM_OUT.exists():
        print(f"[ERROR] 출력 파일 없음: {WASM_OUT}")
        return False

    wasm_bytes = WASM_OUT.read_bytes()
    size = len(wasm_bytes)
    digest = hashlib.sha256(wasm_bytes).hexdigest()

    # WebAssembly magic + version 검증
    if wasm_bytes[:4] != b'\x00asm':
        print(f"[ERROR] 유효하지 않은 WASM: magic={wasm_bytes[:4].hex()}")
        return False
    version = struct.unpack_from("<I", wasm_bytes, 4)[0]
    print(f"[WASM] 컴파일 완료: {size} bytes, version={version}, sha256={digest[:32]}...")

    # wasm-blob.js 생성
    b64 = base64.b64encode(wasm_bytes).decode()
    blob = f"""// 자동 생성 파일 — 직접 수정하지 말 것
// 생성: scripts/build_wasm.py
// bloggerseo WASM v5 ({size} bytes)
// sha256: {digest}
export const WASM_BASE64 = "{b64}";
"""
    BLOB_OUT.write_text(blob, encoding="utf-8")
    print(f"[WASM] wasm-blob.js 생성 완료 ({BLOB_OUT.stat().st_size} bytes)")
    return True

def test_slug_generation():
    """Node.js로 슬러그 생성 테스트"""
    print("\n[TEST] 슬러그 생성 테스트...")
    test_script = """
import { WASM_BASE64 } from './wasm-blob.js';

async function run() {
  const bin = atob(WASM_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { abort() {}, trace() {}, seed() { return 1.0; } }
  });
  const { rawGenerateSlug, getInputPtr, getOutputPtr, memory } = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const cases = [
    ["안녕하세요 테스트 제목", "안녕하세요-테스트-제목"],
    ["Hello World Test", "hello-world-test"],
    ["블로그 포스트 제목입니다", "블로그-포스트-제목입니다"],
    ["blog-post", "blog-post"],
    ["  앞뒤 공백  ", "앞뒤-공백"],
    ["한글 + English Mix 123", "한글-english-mix-123"],
  ];

  let passed = 0;
  for (const [input, expected] of cases) {
    const inPtr = Number(getInputPtr());
    const encoded = enc.encode(input);
    new Uint8Array(memory.buffer).set(encoded, inPtr);
    const outLen = rawGenerateSlug(encoded.length);
    const outPtr = Number(getOutputPtr());
    const result = dec.decode(new Uint8Array(memory.buffer, outPtr, Number(outLen)));
    const ok = result === expected;
    console.log(\`  [\${ok ? 'OK' : 'FAIL'}] "\${input}" → "\${result}" (expected: "\${expected}")\`);
    if (ok) passed++;
  }
  console.log(\`\\n결과: \${passed}/\${cases.length} 통과\`);
  if (passed < cases.length) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
"""
    test_file = WASM_DIR / "_test_slug.mjs"
    test_file.write_text(test_script, encoding="utf-8")
    try:
        result = subprocess.run(
            ["node", "_test_slug.mjs"],
            cwd=WASM_DIR, capture_output=False
        )
        return result.returncode == 0
    finally:
        test_file.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description="WASM 빌드 자동화")
    parser.add_argument("--test", action="store_true", help="빌드 후 슬러그 생성 테스트")
    args = parser.parse_args()

    if not build():
        sys.exit(1)

    if args.test:
        if not test_slug_generation():
            print("[FAIL] 슬러그 생성 테스트 실패")
            sys.exit(1)
        print("[PASS] 모든 테스트 통과")

    print("\n✅ 완료")

if __name__ == "__main__":
    main()
