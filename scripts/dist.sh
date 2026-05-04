#!/usr/bin/env bash
# scripts/dist.sh — build shippable per-arch macOS tarballs.
#
# Bundles templates into the binary (--features bundle-templates) so each
# tarball is just `md4x` + a README. One tarball per architecture
# (no universal binary — half the size, friend picks the matching one).
#
# Usage:
#   scripts/dist.sh                  # build both arm64 and x86_64
#   scripts/dist.sh arm64            # only arm64 (Apple Silicon)
#   scripts/dist.sh x86_64           # only x86_64 (Intel)
#
# Output:
#   dist/md4x-<version>-macos-<arch>.tar.gz
#   dist/md4x-<version>-macos-<arch>.tar.gz.sha256

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VERSION="$(awk -F'"' '/^version *= *"/ {print $2; exit}' Cargo.toml)"
[[ -n "$VERSION" ]] || { echo "could not parse version from Cargo.toml" >&2; exit 1; }

rust_target_for() {
  case "$1" in
    arm64)  echo aarch64-apple-darwin ;;
    x86_64) echo x86_64-apple-darwin ;;
    *)      echo "unknown arch: $1 (expected arm64 or x86_64)" >&2; return 2 ;;
  esac
}

if [[ $# -eq 0 ]]; then
  ARCHES=(arm64 x86_64)
else
  ARCHES=("$@")
fi

for arch in "${ARCHES[@]}"; do
  rust_target_for "$arch" >/dev/null
done

echo "==> md4x ${VERSION} dist build (${ARCHES[*]})"

for arch in "${ARCHES[@]}"; do
  tgt="$(rust_target_for "$arch")"
  name="md4x-${VERSION}"
  staging="dist/${name}-macos-${arch}"
  tarball="dist/${name}-macos-${arch}.tar.gz"

  rm -rf "$staging" "$tarball" "$tarball.sha256"

  if ! rustup target list --installed | grep -q "^${tgt}\$"; then
    echo "==> installing $tgt Rust target"
    rustup target add "$tgt" >/dev/null
  fi

  echo "==> cargo build --features bundle-templates --target $tgt"
  cargo build --release --features bundle-templates --target "$tgt"

  mkdir -p "$staging"
  cp "target/${tgt}/release/md4x" "$staging/md4x"
  file "$staging/md4x"

  cat > "$staging/README.txt" <<EOF
md4x ${VERSION} — Markdown to magazine-quality PDF (macOS ${arch})
====================================================================

Self-contained build. Templates and all renderer assets (KaTeX, mermaid)
are embedded in the binary; the tarball is just \`md4x\` and this README.

This build is for ${arch} Macs. Verify with \`uname -m\` — should print:
  ${arch}
${arch} = $(if [[ $arch == arm64 ]]; then echo "Apple Silicon (M1/M2/M3/M4)"; else echo "Intel"; fi).

REQUIREMENTS
  - macOS
  - Google Chrome (or Chromium) — md4x shells out to it for PDF rendering.
    If Chrome is at the standard location it's auto-detected; otherwise
    set CHROME=/path/to/chrome.

INSTALL
  1. Extract the tarball anywhere (e.g. ~/Applications/md4x-${VERSION}/).
  2. macOS may quarantine the binary on first run. If you see
     "cannot be opened because the developer cannot be verified", run:
         xattr -d com.apple.quarantine ~/Applications/md4x-${VERSION}/md4x
     or right-click the binary in Finder and choose Open.
  3. Optionally add the directory to your PATH:
         echo 'export PATH="\$HOME/Applications/md4x-${VERSION}:\$PATH"' >> ~/.zshrc

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

  ( cd dist && tar -czf "${name}-macos-${arch}.tar.gz" "${name}-macos-${arch}" )
  shasum -a 256 "$tarball" | tee "$tarball.sha256"

  size=$(ls -lh "$tarball" | awk '{print $5}')
  echo "Wrote: $tarball ($size)"
  echo
done

echo "Done."
