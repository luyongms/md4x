#!/usr/bin/env bash
# corpus/render-all.sh — render every corpus/*.md to PDF using md4x.
#
# Usage:
#   corpus/render-all.sh                      # all md → PDF (one PDF per template per md)
#   corpus/render-all.sh --template magazine  # only the magazine template
#   corpus/render-all.sh --md 03-research-linear-algebra-deep-dive.md
#
# Outputs land in corpus/out/<template>/<stem>.pdf.

set -euo pipefail

CORPUS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$CORPUS_DIR/.." && pwd)"
MD4X="${MD4X:-$REPO_DIR/target/release/md4x}"

if [[ ! -x "$MD4X" ]]; then
  echo "md4x not found at $MD4X — run 'cargo build --release' first" >&2
  exit 1
fi

TEMPLATES=(magazine swiss stem tufte newyorker brutalist)
FILTER_TEMPLATE=""
FILTER_MD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --template) FILTER_TEMPLATE="$2"; shift 2 ;;
    --md)       FILTER_MD="$2"; shift 2 ;;
    -h|--help)  sed -n '2,9p' "$0"; exit 0 ;;
    *)          echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$FILTER_TEMPLATE" ]]; then
  TEMPLATES=("$FILTER_TEMPLATE")
fi

shopt -s nullglob
MDS=("$CORPUS_DIR"/*.md)
if [[ -n "$FILTER_MD" ]]; then
  MDS=("$CORPUS_DIR/$FILTER_MD")
fi

mkdir -p "$CORPUS_DIR/out"

start_total=$(date +%s)
for tpl in "${TEMPLATES[@]}"; do
  outdir="$CORPUS_DIR/out/$tpl"
  mkdir -p "$outdir"
  for md in "${MDS[@]}"; do
    stem="$(basename "$md" .md)"
    out="$outdir/$stem.pdf"
    printf '· %-9s %s …' "$tpl" "$stem"
    start=$(date +%s)
    if "$MD4X" "$md" --template "$tpl" -o "$out" >/dev/null 2>&1; then
      end=$(date +%s)
      size=$(wc -c < "$out" | tr -d ' ')
      printf ' ok  %4ds  %7d bytes\n' "$((end - start))" "$size"
    else
      printf ' FAIL\n'
      "$MD4X" "$md" --template "$tpl" -o "$out" || true
    fi
  done
done
end_total=$(date +%s)
echo
echo "Done in $((end_total - start_total))s. Output under $CORPUS_DIR/out/"
