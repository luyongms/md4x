#!/usr/bin/env bash
# scripts/dist-gui.sh — build a shippable macOS .dmg of the md4x GUI.
#
# Unsigned bundle. First-launch on a friend's machine: right-click → Open,
# or `xattr -d com.apple.quarantine /Applications/md4x.app`.
#
# Usage:
#   scripts/dist-gui.sh              # arm64 only (default)
#   scripts/dist-gui.sh x86_64       # Intel
#
# Output:
#   dist/md4x-gui-<version>-macos-<arch>.dmg
#   dist/md4x-gui-<version>-macos-<arch>.dmg.sha256

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VERSION="$(awk -F'"' '/^version *= *"/ {print $2; exit}' Cargo.toml)"
[[ -n "$VERSION" ]] || { echo "could not parse version from Cargo.toml" >&2; exit 1; }

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64)  RUST_TARGET=aarch64-apple-darwin; DMG_ARCH=aarch64 ;;
  x86_64) RUST_TARGET=x86_64-apple-darwin;  DMG_ARCH=x64 ;;
  *) echo "unknown arch: $ARCH (expected arm64 or x86_64)" >&2; exit 2 ;;
esac

# Keep tauri.conf.json's version in sync with Cargo.toml so the bundle
# filename and the app's "About" dialog match what we shipped.
TAURI_CONF="crates/md4x-gui/tauri.conf.json"
CONF_VERSION="$(awk -F'"' '/"version" *:/ {print $4; exit}' "$TAURI_CONF")"
if [[ "$CONF_VERSION" != "$VERSION" ]]; then
  echo "==> syncing $TAURI_CONF version $CONF_VERSION → $VERSION"
  /usr/bin/sed -i '' "s/\"version\": \"$CONF_VERSION\"/\"version\": \"$VERSION\"/" "$TAURI_CONF"
fi

echo "==> md4x-gui $VERSION dist build ($ARCH → $RUST_TARGET)"

# Build via Tauri CLI fetched on demand by npx — no global install needed.
( cd crates/md4x-gui && \
  npx -y @tauri-apps/cli@^2 build --target "$RUST_TARGET" --bundles dmg )

SRC_DMG="target/${RUST_TARGET}/release/bundle/dmg/md4x_${VERSION}_${DMG_ARCH}.dmg"
[[ -f "$SRC_DMG" ]] || { echo "expected DMG not found: $SRC_DMG" >&2; exit 3; }

mkdir -p dist
OUT_DMG="dist/md4x-gui-${VERSION}-macos-${ARCH}.dmg"
cp "$SRC_DMG" "$OUT_DMG"
( cd dist && shasum -a 256 "$(basename "$OUT_DMG")" > "$(basename "$OUT_DMG").sha256" )

SIZE="$(du -h "$OUT_DMG" | awk '{print $1}')"
echo "==> $OUT_DMG ($SIZE)"
echo
echo "Tell your friends:"
echo "  1. Drag md4x.app from the .dmg to /Applications."
echo "  2. First launch: right-click md4x.app → Open → Open."
echo "     (Or: xattr -d com.apple.quarantine /Applications/md4x.app)"
