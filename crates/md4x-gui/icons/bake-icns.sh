#!/usr/bin/env bash
# bake-icns.sh — render app/doc SVGs to PNGs at every macOS icon size and
# pack them into .icns files. Single-shot: edit the SVGs, re-run this.
#
# Requires: rsvg-convert (brew install librsvg), iconutil (macOS).

set -euo pipefail
cd "$(dirname "$0")"

APP_SVG="${APP_SVG:-app-masthead.svg}"
DOC_SVG="${DOC_SVG:-doc.svg}"

OUT="build"
APP_SET="$OUT/app.iconset"
DOC_SET="$OUT/doc.iconset"

rm -rf "$OUT"
mkdir -p "$APP_SET" "$DOC_SET"

# (filename suffix, pixel size). macOS expects this exact set inside an
# .iconset for iconutil to produce a valid .icns at all retina densities.
SIZES=(
  "16x16:16"
  "16x16@2x:32"
  "32x32:32"
  "32x32@2x:64"
  "128x128:128"
  "128x128@2x:256"
  "256x256:256"
  "256x256@2x:512"
  "512x512:512"
  "512x512@2x:1024"
)

bake_one() {
  local src="$1" set_dir="$2" label="$3"
  for entry in "${SIZES[@]}"; do
    local suffix="${entry%%:*}"
    local px="${entry##*:}"
    local out="$set_dir/icon_${suffix}.png"
    rsvg-convert -w "$px" -h "$px" "$src" -o "$out"
    printf "  %-12s %4dpx  %s\n" "$label" "$px" "$out"
  done
}

echo "Baking app icon ($APP_SVG)…"
bake_one "$APP_SVG" "$APP_SET" "app"

echo "Baking document icon ($DOC_SVG)…"
bake_one "$DOC_SVG" "$DOC_SET" "doc"

if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns -o "$OUT/icon.icns" "$APP_SET"
  iconutil -c icns -o "$OUT/doc.icns"  "$DOC_SET"
  echo "Built $OUT/icon.icns and $OUT/doc.icns"
else
  echo "iconutil not found; .icns not packed (PNGs are in $APP_SET)"
fi

echo "Done."
