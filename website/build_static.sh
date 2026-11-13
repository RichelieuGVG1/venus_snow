#!/usr/bin/env bash
# Assembles the static Venus Atlas site into one folder (default: dist).
# The result works on any static hosting and on GitHub Pages, from any folder.
# Usage: bash website/build_static.sh [output_dir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-dist}"
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
EXPORT="$ROOT/venus_snow/results/export_3d"

rm -rf "$OUT"
mkdir -p "$OUT/export_3d"
cp -r "$ROOT/website/index.html" "$ROOT/website/desktop-only.html" \
      "$ROOT/website/css" "$ROOT/website/js" "$ROOT/website/vendor" "$ROOT/website/data" "$OUT/"
cp "$EXPORT"/*.glb "$OUT/export_3d/"
cp -r "$EXPORT/textures" "$OUT/export_3d/"
find "$OUT" -name ".DS_Store" -delete
touch "$OUT/.nojekyll"
echo "Static site assembled in $OUT ($(du -sh "$OUT" | cut -f1))"
