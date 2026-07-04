#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
QUALITY="${IMAGE_QUALITY:-82}"
if ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
  echo "ImageMagick is required: install 'magick' or 'convert'" >&2
  exit 127
fi
IM="magick"
command -v magick >/dev/null 2>&1 || IM="convert"
find "$ROOT" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) \
  ! -path '*/node_modules/*' ! -path '*/.git/*' -print0 |
while IFS= read -r -d '' img; do
  case "${img,,}" in
    *.png) "$IM" "$img" -strip -define png:compression-level=9 "$img" ;;
    *.jpg|*.jpeg) "$IM" "$img" -auto-orient -strip -interlace Plane -quality "$QUALITY" "$img" ;;
  esac
  webp="${img%.*}.webp"
  "$IM" "$img" -auto-orient -strip -quality "$QUALITY" "$webp"
done
