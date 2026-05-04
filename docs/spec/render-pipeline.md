# md4x render pipeline (v0.1.1)

## Goal

Convert a Markdown file to a magazine-quality PDF. Single binary, single
external dependency at runtime: Google Chrome (or Chromium). No bun, no
npx, no pandoc, no mmdc. Output is a self-contained PDF.

## CLI

    md4x [--to pdf] [--template <name>] [-o OUTPUT] <INPUT.md>

- `--to` — optional; defaults to `pdf`. Only `pdf` is accepted in v0.1.1.
- `--template` — optional; defaults to `magazine`. Valid values:
  `magazine`, `swiss`, `stem`. An unknown name is a hard error.
- `-o`, `--output` — optional; defaults to `<INPUT stem>.pdf` next to the
  input file.
- `<INPUT>` — required; must exist and be readable.

## Asset discovery

md4x reads its templates from the directory containing the running binary
(`std::env::current_exe()` parent), with no fallbacks and no env-var
overrides. The expected layout at deploy time is exactly two things:

    <bin_dir>/md4x
    <bin_dir>/templates/cover.html
    <bin_dir>/templates/<template>/style.css

`mermaid.min.js` and the entire `katex/` directory are **embedded into
the binary** at compile time (via `include_bytes!` and `include_dir!`)
because they are vendored libraries that are not tweaked during normal
md4x development. They are extracted to the per-render scratch dir at
runtime so Chrome can `file://`-load them. Source copies live at the
repo root (`mermaid.min.js`, `katex/`) so they are tracked but only used
at compile time.

Missing template assets are a hard error with a message that names the
missing path.

## Pipeline

1. **Read** the input markdown into memory.
2. **Extract cover values** from the markdown:
   - `title` — text of the first ATX H1; if absent, the input file's
     stem.
   - `subtitle` — first non-blank, non-heading, non-thematic-break line
     after the H1. Strip a leading `**Label:**` prefix and any remaining
     `**` markers.
   - `eyebrow` — input file stem, dashes → spaces, uppercased.
   - `author` — empty in v0.1.1 (templates that do not show it hide it
     via CSS).
   - `date` — current month and year, e.g. `MAY 2026`.
3. **Render markdown to HTML** via comrak with GFM extensions
   (tables, footnotes, strikethrough, tasklist, autolink, superscript).
   Mermaid fenced blocks (```` ```mermaid ````) become
   `<pre class="mermaid">...source...</pre>`; the source is HTML-escaped
   but otherwise untouched. All other code blocks render normally.
4. **Substitute cover values** into `cover.html`. The cover template
   uses double-brace placeholders `{{title}}`, `{{subtitle}}`,
   `{{eyebrow}}`, `{{author}}`, `{{date}}`. Cover values are
   HTML-escaped before substitution.
5. **Assemble HTML**: `<!DOCTYPE html><html><head>` with a `<link>` to
   the chosen template's `style.css` (relative path, since Chrome reads
   from the scratch dir), plus a `<script>` tag for `mermaid.min.js`
   followed by an inline `mermaid.initialize({startOnLoad:true})`. The
   `<body>` contains the cover HTML followed by the rendered article
   HTML.
6. **Write to scratch dir** at `<output>.work/`: write `index.html`,
   copy `style.css` from the chosen template into the scratch dir, and
   extract the embedded `mermaid.min.js` and `katex/` tree to the
   scratch dir so Chrome can `file://`-load them.
7. **Spawn Chrome** with `--headless --disable-gpu
   --no-pdf-header-footer --virtual-time-budget=10000
   --print-to-pdf=<output>` against `file://<scratch>/index.html`.
   `--virtual-time-budget` gives mermaid time to render before printing.
   Chrome path resolution: `CHROME` env var → macOS default →
   `google-chrome` → `chromium`. Missing Chrome is a hard error with a
   message naming `CHROME=`.
8. **Cleanup**: remove the scratch dir on success. Preserve it if
   `KEEP_WORK=1`. On failure, the scratch dir is preserved unconditionally
   for debugging.

## Success criteria (testable)

- CLI accepts `<input>` alone and defaults `--to=pdf`,
  `--template=magazine`.
- CLI accepts `--template magazine|swiss|stem`; rejects others.
- Missing input file → nonzero exit, stderr names the path.
- `extract_cover_values` derives title, subtitle, eyebrow, date as
  specified above for representative inputs.
- `substitute_cover` replaces all five placeholders in the shared
  `cover.html`; HTML-escapes values.
- `markdown_to_html` emits `<pre class="mermaid">` for ```` ```mermaid ````
  fences, preserving the diagram source verbatim (HTML-escaped).
- `find_assets` returns paths relative to `current_exe()` and errors
  helpfully when assets are missing.
- End-to-end PDF render (gated `#[ignore]`, requires Chrome): runs
  against `templates/magazine/sample.md`, produces a non-empty PDF,
  removes the scratch dir.
