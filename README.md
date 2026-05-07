# md4x

Convert Markdown to **magazine-quality PDF**. Rust, desktop-only, single-binary.

A CLI for batch rendering and a Tauri-based desktop GUI for live preview.

> **Status:** pre-v1 prototype (`v0.N.M`). Treat as experimental — APIs and
> templates may shift.

## Features

- Six built-in templates: `magazine`, `swiss`, `stem`, `tufte`, `newyorker`, `brutalist`
- Mermaid diagrams + KaTeX math, both pre-rendered into the PDF
- Cover page synthesized from `# Title` + first paragraph
- A4 layout, real `@page` margins, drop caps, running headers
- GUI: live preview, hot-swap templates, export PDF, open file
  (Cmd+O / Cmd+S), zoom-to-fit page rendering

## Requirements

- **Rust** 1.75+ (stable)
- **Google Chrome** (or Chromium) — used as the headless print engine
  for PDF generation. The CLI shells out to `/Applications/Google Chrome.app/...`
  on macOS, or `google-chrome`/`chromium` on PATH. Override with `CHROME=/path`.
- **macOS** for the GUI (Tauri 2 + WKWebView). The CLI is cross-platform.

## Build

```sh
cargo build --release -p md4x-cli   # CLI
cargo build --release -p md4x-gui   # GUI (Tauri app)
```

Both end up in `target/release/`.

## CLI usage

```sh
md4x README.md                                # → README.pdf, magazine template
md4x README.md --template tufte               # → README.pdf, tufte template
md4x README.md --template stem -o paper.pdf   # explicit output

md4x docs/*.md --template swiss               # batch — each → <stem>.pdf
```

`md4x --help` for the full flag list.

## GUI usage

```sh
./target/release/md4x-gui
```

The window opens with editor on the left, live preview on the right. Type or
paste Markdown — the preview updates with no flash. Switch templates from the
toolbar dropdown. **File → Open…** (Cmd+O) to load a `.md` file,
**File → Export PDF…** (Cmd+S) to save.

## Project structure

```
crates/
  md4x-core/     # rendering kernel (markdown → HTML → PDF), plugin registry
  md4x-cli/      # command-line interface
  md4x-gui/      # Tauri desktop app (live preview + export)
templates/       # six template stylesheets and per-template covers
corpus/          # test markdown documents (rendered into corpus/out/)
docs/
  spec/          # design specs (v0.2.0 GUI, v0.3.0 layout engine, ...)
  design/        # mockups
```

## Design principles

- **Spec → tests → code.** Every behavioral claim has a test. Specs live in
  `docs/spec/`. Implementation order is non-negotiable.
- **Portable.** Single binary, copy-to-bin install. No installer, no registry,
  no global config. Templates and assets are bundled at build time.
- **Dogfood.** Markdown files under `docs/` are auto-rendered to PDF on every
  edit (project hook in `.claude/settings.json` → `scripts/md-to-pdf-hook.sh`).
  As md4x evolves, the hook will swap the bash script for the md4x binary.

## Templates

| Template    | Vibe                                     |
|-------------|------------------------------------------|
| `magazine`  | Default — long-form article, drop caps   |
| `swiss`     | Grid, Helvetica-feel, structured         |
| `stem`      | Technical paper, two-column-ish, math-friendly |
| `tufte`     | Sidenotes, asymmetric margins            |
| `newyorker` | Editorial, serif, refined                |
| `brutalist` | Asymmetric grid, raw, mono headlines     |

## License

[AGPL-3.0-only](LICENSE).
