#!/usr/bin/env bash
# scripts/dist.sh — build a shippable macOS tarball.
#
# Bundles templates into the binary (--features bundle-templates) so the
# tarball is just `md4x` + a README. Lipos arm64 + x86_64 into one
# universal binary. Run from the repo root.
#
# Usage:
#   scripts/dist.sh
#
# Output:
#   dist/md4x-<version>-macos-universal.tar.gz
#   dist/md4x-<version>-macos-universal.tar.gz.sha256

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VERSION="$(awk -F'"' '/^version *= *"/ {print $2; exit}' Cargo.toml)"
[[ -n "$VERSION" ]] || { echo "could not parse version from Cargo.toml" >&2; exit 1; }

NAME="md4x-${VERSION}"
DIST="dist/${NAME}"
TARBALL="dist/${NAME}-macos-universal.tar.gz"

echo "==> md4x ${VERSION} dist build"

rm -rf "$DIST" "$TARBALL" "$TARBALL.sha256"
mkdir -p "$DIST"

if ! rustup target list --installed | grep -q '^x86_64-apple-darwin$'; then
  echo "==> installing x86_64-apple-darwin Rust target"
  rustup target add x86_64-apple-darwin >/dev/null
fi

echo "==> cargo build --features bundle-templates --target aarch64-apple-darwin"
cargo build --release --features bundle-templates --target aarch64-apple-darwin
echo "==> cargo build --features bundle-templates --target x86_64-apple-darwin"
cargo build --release --features bundle-templates --target x86_64-apple-darwin

echo "==> lipo universal binary"
lipo -create -output "$DIST/md4x" \
  "target/aarch64-apple-darwin/release/md4x" \
  "target/x86_64-apple-darwin/release/md4x"
file "$DIST/md4x"

cat > "$DIST/README.txt" <<EOF
md4x ${VERSION} — Markdown to magazine-quality PDF
====================================================

Self-contained build. Universal binary works on Apple Silicon and Intel Macs.
Templates and all renderer assets (KaTeX, mermaid) are embedded in the binary.

REQUIREMENTS
  - macOS
  - Google Chrome (or Chromium) — md4x shells out to it for PDF rendering.
    If Chrome is at the standard location it's auto-detected; otherwise
    set CHROME=/path/to/chrome.

INSTALL
  1. Extract the tarball anywhere (e.g. ~/Applications/${NAME}/).
  2. macOS may quarantine the binary on first run. If you see
     "cannot be opened because the developer cannot be verified", run:
         xattr -d com.apple.quarantine ~/Applications/${NAME}/md4x
     or right-click the binary in Finder and choose Open.
  3. Optionally add the directory to your PATH:
         echo 'export PATH="\$HOME/Applications/${NAME}:\$PATH"' >> ~/.zshrc

USAGE
  md4x INPUT.md                              # → INPUT.pdf, magazine template
  md4x INPUT.md --template swiss             # swiss layout
  md4x INPUT.md --template stem -o out.pdf   # stem (math/textbook) + custom output

  Templates: magazine (default), swiss, stem.

  Keep the work directory for inspection:
      KEEP_WORK=1 md4x foo.md

WHAT IT HANDLES
  - GFM markdown, footnotes, tables, task lists
  - KaTeX math (inline \$..\$ and display \$\$..\$\$)
  - Mermaid diagrams (in \`\`\`mermaid fences)
  - Syntax-highlighted code (~150 languages)
  - Inline SVG and data-URI images

LIMITATIONS
  - Single-file Markdown input
  - No external image fetching at render time (use data URIs or absolute paths)
  - Chrome must be installed
EOF

echo "==> tarball"
( cd dist && tar -czf "${NAME}-macos-universal.tar.gz" "${NAME}" )
shasum -a 256 "$TARBALL" | tee "$TARBALL.sha256"

SIZE=$(ls -lh "$TARBALL" | awk '{print $5}')
echo
echo "Wrote: $TARBALL ($SIZE)"
echo "       $TARBALL.sha256"
