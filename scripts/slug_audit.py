#!/usr/bin/env python3
"""
BloggerSEO 슬러그 KV 감사/마이그레이션 스크립트

사용법:
  python3 scripts/slug_audit.py list           # 모든 슬러그 출력
  python3 scripts/slug_audit.py migrate        # v4 → v5 키 네임스페이스 마이그레이션
  python3 scripts/slug_audit.py clean-old      # 구 키 (origin:*, alias:*) 삭제
  python3 scripts/slug_audit.py stats          # 통계 출력
  python3 scripts/slug_audit.py export <file>  # JSON으로 내보내기

환경변수:
  CF_ACCOUNT_ID   : Cloudflare 계정 ID
  CF_API_TOKEN    : Cloudflare API 토큰 (KV 읽기/쓰기 권한)
  SLUG_KV_ID      : KV 네임스페이스 ID (wrangler.toml의 id)

예시:
  CF_ACCOUNT_ID=xxx CF_API_TOKEN=yyy SLUG_KV_ID=4fe8b16... python3 scripts/slug_audit.py list
"""

import os
import sys
import json
import re
import time
import argparse
import urllib.request
import urllib.error
from urllib.parse import quote

CF_API_BASE = "https://api.cloudflare.com/client/v4"

def get_env():
    account_id = os.environ.get("CF_ACCOUNT_ID", "")
    api_token  = os.environ.get("CF_API_TOKEN", "")
    kv_id      = os.environ.get("SLUG_KV_ID", "4fe8b16587f04703abe9e913763f58f7")
    if not account_id or not api_token:
        print("[ERROR] CF_ACCOUNT_ID, CF_API_TOKEN 환경변수 필요")
        sys.exit(1)
    return account_id, api_token, kv_id

def cf_request(method, path, token, body=None):
    url = f"{CF_API_BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[ERROR] HTTP {e.code}: {e.read().decode()[:300]}")
        return None

def list_kv_keys(account_id, token, kv_id, prefix="", cursor=None):
    """KV 키 목록 페이지 반환"""
    path = f"/accounts/{account_id}/storage/kv/namespaces/{kv_id}/keys?limit=1000"
    if prefix: path += f"&prefix={quote(prefix)}"
    if cursor: path += f"&cursor={cursor}"
    return cf_request("GET", path, token)

def get_kv_value(account_id, token, kv_id, key):
    """KV 값 조회"""
    path = f"/accounts/{account_id}/storage/kv/namespaces/{kv_id}/values/{quote(key, safe='')}"
    url = f"{CF_API_BASE}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.read().decode()
    except:
        return None

def put_kv_value(account_id, token, kv_id, key, value):
    """KV 값 쓰기"""
    path = f"/accounts/{account_id}/storage/kv/namespaces/{kv_id}/values/{quote(key, safe='')}"
    url = f"{CF_API_BASE}{path}"
    req = urllib.request.Request(url, data=value.encode(), method="PUT")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "text/plain")
    try:
        with urllib.request.urlopen(req):
            return True
    except:
        return False

def delete_kv_key(account_id, token, kv_id, key):
    """KV 키 삭제"""
    path = f"/accounts/{account_id}/storage/kv/namespaces/{kv_id}/values/{quote(key, safe='')}"
    url = f"{CF_API_BASE}{path}"
    req = urllib.request.Request(url, method="DELETE")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req):
            return True
    except:
        return False

def iter_all_keys(account_id, token, kv_id, prefix=""):
    """전체 키 이터레이터"""
    cursor = None
    while True:
        resp = list_kv_keys(account_id, token, kv_id, prefix, cursor)
        if not resp or not resp.get("success"):
            break
        for key in resp.get("result", []):
            yield key["name"]
        info = resp.get("result_info", {})
        cursor = info.get("cursor")
        if not cursor:
            break
        time.sleep(0.1)  # 레이트리밋 방지

def cmd_list(account_id, token, kv_id):
    """모든 슬러그 출력"""
    print(f"{'KEY':<60} VALUE")
    print("-" * 80)
    count = 0
    for key in iter_all_keys(account_id, token, kv_id):
        val = get_kv_value(account_id, token, kv_id, key)
        if val and len(val) > 80: val = val[:77] + "..."
        print(f"{key:<60} {val}")
        count += 1
        time.sleep(0.05)
    print(f"\n총 {count}개 키")

def cmd_migrate(account_id, token, kv_id):
    """v4 키 네임스페이스(origin:*, alias:*) → v5(slug:origin:*, slug:alias:*)로 마이그레이션"""
    migrated = 0
    skipped  = 0

    print("[마이그레이션] origin:* → slug:origin:* ...")
    for key in iter_all_keys(account_id, token, kv_id, "origin:"):
        new_key = "slug:" + key
        # 이미 존재하면 스킵
        existing = get_kv_value(account_id, token, kv_id, new_key)
        if existing:
            skipped += 1
            continue
        val = get_kv_value(account_id, token, kv_id, key)
        if val and put_kv_value(account_id, token, kv_id, new_key, val):
            migrated += 1
            print(f"  {key} → {new_key}")
        time.sleep(0.1)

    print("[마이그레이션] alias:* → slug:alias:* ...")
    for key in iter_all_keys(account_id, token, kv_id, "alias:"):
        new_key = "slug:" + key
        existing = get_kv_value(account_id, token, kv_id, new_key)
        if existing:
            skipped += 1
            continue
        val = get_kv_value(account_id, token, kv_id, key)
        if val and put_kv_value(account_id, token, kv_id, new_key, val):
            migrated += 1
            print(f"  {key} → {new_key}")
        time.sleep(0.1)

    print(f"\n완료: 마이그레이션 {migrated}개, 스킵 {skipped}개")

def cmd_clean_old(account_id, token, kv_id):
    """구 키(origin:*, alias:*, cname_ok:*, lb:*, compute:*, metrics:*, rl:*) 삭제"""
    old_prefixes = ["origin:", "alias:", "cname_ok:", "lb:", "compute:", "metrics:", "rl:"]
    total_deleted = 0
    for prefix in old_prefixes:
        deleted = 0
        for key in iter_all_keys(account_id, token, kv_id, prefix):
            if delete_kv_key(account_id, token, kv_id, key):
                deleted += 1
                print(f"  삭제: {key}")
            time.sleep(0.05)
        print(f"  [{prefix}*] {deleted}개 삭제")
        total_deleted += deleted
    print(f"\n총 {total_deleted}개 구 키 삭제 완료")

def cmd_stats(account_id, token, kv_id):
    """KV 통계"""
    key_counts = {}
    total = 0
    for key in iter_all_keys(account_id, token, kv_id):
        prefix = key.split(":")[0] + (":" + key.split(":")[1] if ":" in key else "")
        key_counts[prefix] = key_counts.get(prefix, 0) + 1
        total += 1
        time.sleep(0.01)
    print(f"\n=== KV 통계 ===")
    print(f"총 키 수: {total}")
    for prefix, count in sorted(key_counts.items(), key=lambda x: -x[1]):
        print(f"  {prefix}*  : {count}개")

def cmd_export(account_id, token, kv_id, filename):
    """JSON으로 내보내기"""
    data = {}
    for key in iter_all_keys(account_id, token, kv_id):
        val = get_kv_value(account_id, token, kv_id, key)
        try:
            data[key] = json.loads(val)
        except:
            data[key] = val
        time.sleep(0.05)
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"내보내기 완료: {filename} ({len(data)}개 키)")

def main():
    parser = argparse.ArgumentParser(description="BloggerSEO 슬러그 KV 관리")
    subparsers = parser.add_subparsers(dest="cmd")
    subparsers.add_parser("list",       help="전체 키 목록")
    subparsers.add_parser("migrate",    help="v4→v5 키 마이그레이션")
    subparsers.add_parser("clean-old",  help="구 키 삭제")
    subparsers.add_parser("stats",      help="통계")
    exp = subparsers.add_parser("export", help="JSON 내보내기")
    exp.add_argument("file", help="출력 파일명")
    args = parser.parse_args()

    if not args.cmd:
        parser.print_help()
        sys.exit(0)

    account_id, token, kv_id = get_env()
    print(f"KV 네임스페이스: {kv_id}\n")

    if args.cmd == "list":          cmd_list(account_id, token, kv_id)
    elif args.cmd == "migrate":     cmd_migrate(account_id, token, kv_id)
    elif args.cmd == "clean-old":   cmd_clean_old(account_id, token, kv_id)
    elif args.cmd == "stats":       cmd_stats(account_id, token, kv_id)
    elif args.cmd == "export":      cmd_export(account_id, token, kv_id, args.file)

if __name__ == "__main__":
    main()
