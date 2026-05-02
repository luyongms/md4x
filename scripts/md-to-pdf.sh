#!/usr/bin/env bash
# md-to-pdf.sh — render a Markdown file (with mermaid code blocks) to a nicely-formatted PDF.
#
# Pipeline:
#   1. Extract ```mermaid fenced blocks from the input .md
#   2. Render each block to SVG via @mermaid-js/mermaid-cli (via bunx)
#   3. Substitute <img> refs back into a working copy of the markdown
#   4. pandoc → standalone HTML using the bundled print CSS
#   5. Google Chrome headless --print-to-pdf → final PDF
#
# Requirements:
#   - bun (for bunx --bun @mermaid-js/mermaid-cli)
#   - pandoc
#   - Google Chrome (macOS path by default; override via CHROME env var)
#
# Usage:
#   scripts/md-to-pdf.sh <input.md> [output.pdf]
#
# Env overrides:
#   CHROME     path to Chrome/Chromium binary
#   WORK_DIR   scratch dir (default: <output>.work/)
#   KEEP_WORK  =1 to preserve the scratch dir after success

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input.md> [output.pdf]" >&2
  exit 1
fi

INPUT="$1"
if [[ ! -f "$INPUT" ]]; then
  echo "Input not found: $INPUT" >&2
  exit 1
fi

OUTPUT="${2:-${INPUT%.md}.pdf}"
# Resolve to absolute paths so tool invocations don't depend on CWD.
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
OUTPUT_DIR="$(cd "$(dirname "$OUTPUT")" && pwd)"
OUTPUT_ABS="$OUTPUT_DIR/$(basename "$OUTPUT")"

WORK_DIR="${WORK_DIR:-${OUTPUT_ABS}.work}"
DIAG_DIR="$WORK_DIR/diagrams"
mkdir -p "$DIAG_DIR"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$CHROME" ]]; then
  if command -v google-chrome >/dev/null 2>&1; then CHROME="$(command -v google-chrome)"
  elif command -v chromium >/dev/null 2>&1; then CHROME="$(command -v chromium)"
  else echo "Chrome not found; set CHROME=/path/to/chrome" >&2; exit 1
  fi
fi

command -v bunx   >/dev/null 2>&1 || { echo "bunx (bun) is required" >&2; exit 1; }
command -v pandoc >/dev/null 2>&1 || { echo "pandoc is required" >&2; exit 1; }

# --- write bundled config files into the work dir --------------------------

cat > "$WORK_DIR/mermaid.json" <<'JSON'
{
  "theme": "default",
  "themeVariables": {
    "fontFamily": "Helvetica, Arial, sans-serif",
    "fontSize": "14px"
  },
  "flowchart": { "htmlLabels": true, "curve": "basis" },
  "sequence": { "useMaxWidth": true },
  "maxTextSize": 90000
}
JSON

cat > "$WORK_DIR/puppeteer.json" <<'JSON'
{ "args": ["--no-sandbox"] }
JSON

cat > "$WORK_DIR/style.css" <<'CSS'
/* =====================================================================
   Magazine / long-form article stylesheet — PDF magic docs
   Goals: Medium.com / The Atlantic-style readability, restrained
   palette, real serif body, generous rhythm. macOS system fonts only.
   ===================================================================== */

@page {
  size: A4;
  margin: 22mm 22mm 24mm 22mm;
  @top-left {
    content: string(doc-title);
    font-family: "SF Pro Text", -apple-system, "Helvetica Neue", sans-serif;
    font-size: 8pt;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #999;
  }
  @top-right {
    content: string(section-title);
    font-family: "SF Pro Text", -apple-system, "Helvetica Neue", sans-serif;
    font-size: 8pt;
    letter-spacing: 0.06em;
    color: #999;
    font-style: italic;
  }
  @bottom-center {
    content: counter(page);
    font-family: "Iowan Old Style", "Charter", Georgia, serif;
    font-size: 9pt;
    color: #999;
  }
}

/* Cover page — no header/footer */
@page :first {
  margin: 0;
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-center { content: none; }
}

html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

body {
  font-family: "Iowan Old Style", "Charter", "Cambria", "Source Serif Pro", Georgia, serif;
  font-size: 11pt;
  line-height: 1.65;
  color: #1d1d1f;
  background: #ffffff;
  hyphens: auto;
  -webkit-hyphens: auto;
  text-rendering: geometricPrecision;
  font-feature-settings: "kern" 1, "liga" 1, "onum" 1;
  margin: 0;
  padding: 0;
  max-width: none;
}

/* Cover page ----------------------------------------------------------- */
.cover-page {
  position: relative;
  /* Escape the @page margins (22mm sides, 22mm top, 24mm bottom)
     so the cover background fills the entire physical page. */
  width: calc(100% + 44mm);
  height: 297mm;
  margin: -22mm -22mm 0 -22mm;
  page-break-after: always;
  break-after: page;
  background: #faf7f0;
  padding: 0;
  overflow: hidden;
}
.cover-content {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  max-width: 170mm;
  text-align: center;
  padding: 0 20mm;
  box-sizing: border-box;
}
.cover-eyebrow {
  font-family: "SF Pro Text", -apple-system, sans-serif;
  font-size: 9pt;
  text-transform: uppercase;
  letter-spacing: 0.4em;
  color: #b91c1c;
  margin: 0 0 22mm 0;
  font-weight: 600;
}
.cover-title {
  font-family: "New York", "Iowan Old Style", "Charter", Georgia, serif;
  font-size: 38pt;
  line-height: 1.08;
  letter-spacing: -0.02em;
  font-weight: 700;
  color: #0c0c0c;
  margin: 0 auto 12mm;
  max-width: 150mm;
}
.cover-subtitle {
  font-family: "Iowan Old Style", Georgia, serif;
  font-size: 13pt;
  font-style: italic;
  line-height: 1.5;
  color: #555;
  max-width: 130mm;
  margin: 0 auto 16mm;
}
.cover-rule {
  width: 60px;
  height: 2px;
  background: #1d1d1f;
  margin: 6mm auto;
}
.cover-meta {
  font-family: "SF Pro Text", -apple-system, sans-serif;
  font-size: 9pt;
  text-transform: uppercase;
  letter-spacing: 0.25em;
  color: #888;
  margin: 4mm 0 0;
}
.cover-meta strong {
  color: #1d1d1f;
  font-weight: 600;
}

/* Hide pandoc's auto-generated title block (we use our cover instead) */
header#title-block-header { display: none; }

/* Hide the article's first H1 (cover already shows it) */
body > h1:first-of-type { display: none; }

/* String-set for running headers */
h1 { string-set: doc-title content(); }
h2 { string-set: section-title content(); }

h1, h2, h3, h4, h5, h6 {
  font-family: "SF Pro Display", "New York", -apple-system, "Helvetica Neue", sans-serif;
  color: #0c0c0c;
  page-break-after: avoid;
  break-after: avoid;
  font-weight: 700;
}

h1 {
  font-size: 26pt;
  line-height: 1.15;
  letter-spacing: -0.025em;
  margin: 0 0 0.5em;
}

/* Force a page break before each top-level article section (not the cover title) */
body > h1:not(:first-of-type) {
  page-break-before: always;
  break-before: page;
}

h2 {
  font-size: 17pt;
  line-height: 1.2;
  letter-spacing: -0.018em;
  margin: 2em 0 0.5em;
  padding-top: 0.3em;
}

h3 {
  font-size: 11pt;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-weight: 700;
  color: #b91c1c;
  margin: 1.6em 0 0.4em;
}

h4 {
  font-family: "Iowan Old Style", Georgia, serif;
  font-size: 11.5pt;
  font-style: italic;
  font-weight: 600;
  color: #2a2a2a;
  margin: 1.3em 0 0.3em;
}

/* Drop cap on the first paragraph after each H1 */
h1 + p::first-letter {
  float: left;
  font-family: "Big Caslon", "New York", "Iowan Old Style", Georgia, serif;
  font-size: 1.76em;
  line-height: 0.85;
  margin: 0.05em 0.08em -0.1em -0.04em;
  font-weight: 700;
  color: #b91c1c;
}

/* Lead paragraph (first after each H1) */
h1 + p {
  font-size: 12.5pt;
  line-height: 1.55;
  color: #2a2a2a;
  margin-bottom: 1.2em;
}

p {
  margin: 0 0 0.75em;
  text-align: justify;
  orphans: 3;
  widows: 3;
}

/* The first paragraph after H2/H3 should not be justified — looks better */
h2 + p, h3 + p { text-align: left; }

blockquote {
  margin: 1.4em 1em 1.4em 0;
  padding: 0.1em 0 0.1em 1.3em;
  border-left: 3px solid #b91c1c;
  font-style: italic;
  font-size: 12pt;
  line-height: 1.55;
  color: #3a3a3a;
  background: none;
  page-break-inside: avoid;
}

code {
  font-family: "JetBrains Mono", "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  font-size: 9.2pt;
  background: #f4f1ec;
  padding: 1px 5px;
  border-radius: 3px;
  color: #6b3410;
  font-weight: 500;
  font-feature-settings: "calt" 0;
}

pre {
  background: #e9d8a6;
  color: #2a2418;
  padding: 1em 1.2em;
  border-radius: 6px;
  overflow: hidden;
  font-size: 8.6pt;
  line-height: 1.55;
  page-break-inside: avoid;
  margin: 1em 0;
  border: 1px solid #d4c084;
}

pre code {
  background: none;
  color: inherit;
  padding: 0;
  font-size: inherit;
  font-weight: 400;
}

/* Magazine-style tables — top/bottom rules only */
table {
  border-collapse: collapse;
  width: 100%;
  margin: 1.2em 0;
  font-size: 9.5pt;
  font-family: "SF Pro Text", -apple-system, "Helvetica Neue", sans-serif;
  page-break-inside: avoid;
  border-top: 2px solid #1d1d1f;
  border-bottom: 2px solid #1d1d1f;
}

th {
  text-align: left;
  padding: 8px 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 8pt;
  color: #1d1d1f;
  border-bottom: 1px solid #1d1d1f;
}

td {
  padding: 7px 10px;
  border-bottom: 1px solid #ececec;
  vertical-align: top;
  color: #2a2a2a;
}

tr:last-child td { border-bottom: none; }

/* Lists */
ul, ol {
  margin: 0.5em 0 1em 1.4em;
  padding: 0;
}

li {
  margin: 0.3em 0;
  line-height: 1.6;
}

li > p { margin: 0 0 0.4em; text-align: left; }

/* Ornamental rule */
hr {
  border: none;
  text-align: center;
  margin: 2em 0;
  height: 1em;
}

hr::after {
  content: "* * *";
  letter-spacing: 0.5em;
  color: #b91c1c;
  font-size: 13pt;
  font-family: "Iowan Old Style", Georgia, serif;
}

/* Diagrams */
p.diagram {
  text-align: center;
  margin: 1.5em 0;
  page-break-inside: avoid;
}

p.diagram img {
  max-width: 100%;
  max-height: 220mm;
  height: auto;
  border: none;
  padding: 0;
}

/* Inline emphasis */
strong { font-weight: 700; color: #0c0c0c; }
em { font-style: italic; }

a {
  color: #b91c1c;
  text-decoration: none;
  border-bottom: 1px solid rgba(185, 28, 28, 0.25);
}

/* Footnotes / definition lists / details */
dl { margin: 1em 0; }
dt { font-weight: 700; color: #0c0c0c; margin-top: 0.6em; }
dd { margin: 0.2em 0 0 1.2em; color: #3a3a3a; }

/* Small caps utility class (use in cover meta if desired) */
.small-caps {
  font-variant-caps: small-caps;
  letter-spacing: 0.05em;
}

/* Avoid page break right after a heading */
h1, h2, h3, h4 { break-after: avoid-page; }
table, pre, blockquote, p.diagram { break-inside: avoid; }
CSS

# --- 1. extract mermaid blocks ----------------------------------------------

awk -v diagdir="$DIAG_DIR" '
/^```mermaid[[:space:]]*$/ { in_m=1; n++; out=sprintf("%s/diagram-%02d.mmd", diagdir, n); next }
in_m && /^```[[:space:]]*$/ { in_m=0; next }
in_m { print > out }
' "$INPUT_ABS"

shopt -s nullglob
MMD_FILES=("$DIAG_DIR"/*.mmd)
echo "Found ${#MMD_FILES[@]} mermaid blocks"

# --- 2. render each to SVG ---------------------------------------------------

for f in "${MMD_FILES[@]+"${MMD_FILES[@]}"}"; do
  out="${f%.mmd}.svg"
  name="$(basename "$f")"
  if bunx --bun @mermaid-js/mermaid-cli \
        -i "$f" -o "$out" -b white \
        -c "$WORK_DIR/mermaid.json" \
        -p "$WORK_DIR/puppeteer.json" \
        >/dev/null 2>&1; then
    echo "  rendered $name"
  else
    echo "  FAILED  $name — see $f for the offending source" >&2
    exit 2
  fi
done

# --- 3. substitute <img> refs into a rendered .md ---------------------------

RENDERED_MD="$WORK_DIR/rendered.md"
awk '
BEGIN { n=0; in_m=0 }
/^```mermaid[[:space:]]*$/ { in_m=1; n++; next }
in_m && /^```[[:space:]]*$/ {
  in_m=0
  printf("\n<p class=\"diagram\"><img src=\"diagrams/diagram-%02d.svg\" alt=\"diagram %d\" /></p>\n\n", n, n)
  next
}
in_m { next }
{ print }
' "$INPUT_ABS" > "$RENDERED_MD"

# --- 4. pandoc → HTML -------------------------------------------------------

TITLE="$(head -1 "$INPUT_ABS" | sed -E 's/^#+[[:space:]]*//')"
[[ -z "$TITLE" ]] && TITLE="$(basename "$INPUT_ABS" .md)"

# Subtitle: first non-empty, non-heading, non-blank line after the H1.
# Strip leading "**Document:**", "**Generated:**", etc. labels and bold markers.
SUBTITLE="$(awk '
  NR==1 { next }                              # skip H1
  /^[[:space:]]*$/ { next }                   # skip blank
  /^#/ { next }                               # skip later headings
  /^---/ { next }
  { print; exit }
' "$INPUT_ABS" | sed -E 's/^\*\*[^:]+:\*\*[[:space:]]*//' | sed -E 's/\*\*//g')"

# Date: today, in "Month YYYY" form
COVER_DATE="$(date +'%B %Y')"

# Eyebrow: try to derive from filename (e.g. v0.15-to-v0.17-features → "v0.15 → v0.17  ·  Features Guide")
EYEBROW="$(basename "$INPUT_ABS" .md | sed -E 's/-/ /g; s/v([0-9]+\.[0-9]+)/v\1/g' | tr '[:lower:]' '[:upper:]')"

cat > "$WORK_DIR/cover.html" <<HTML
<div class="cover-page">
  <div class="cover-content">
    <div class="cover-eyebrow">${EYEBROW}</div>
    <h1 class="cover-title">${TITLE}</h1>
    <div class="cover-subtitle">${SUBTITLE}</div>
    <div class="cover-rule"></div>
    <div class="cover-meta">PDF MAGIC  &nbsp;·&nbsp;  <strong>${COVER_DATE}</strong></div>
  </div>
</div>
HTML

HTML="$WORK_DIR/out.html"
pandoc "$RENDERED_MD" \
  --from=gfm --to=html5 --standalone \
  --metadata title="$TITLE" \
  --css=style.css \
  --include-before-body="$WORK_DIR/cover.html" \
  -o "$HTML"

# --- 5. Chrome headless → PDF -----------------------------------------------

"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$OUTPUT_ABS" \
  "file://$HTML" >/dev/null 2>&1

echo "Wrote $OUTPUT_ABS"

if [[ "${KEEP_WORK:-0}" != "1" ]]; then
  rm -rf "$WORK_DIR"
else
  echo "(scratch dir kept at $WORK_DIR)"
fi
