# md4x plugin architecture (v0.1.2)

## Goal

Move mermaid, KaTeX, and syntect from inline kernel code into named
plugins behind a uniform contract. The kernel orchestrates; plugins
contribute capabilities. This is a *structural* refactor — output is
unchanged from v0.1.1. The point is that *adding a fourth capability
later* (paged.js, plantuml, d2, …) becomes a new file plus one line in
the registry, not an edit to the kernel.

## Layers

After the refactor the codebase has four layers:

1. **Kernel** (`src/render.rs`) — parse markdown, walk AST, format HTML,
   extract cover values, assemble `<head>`/`<body>`, write scratch dir,
   spawn Chrome, clean up. Knows nothing about specific plugins.
2. **Plugins** (`src/plugins/{mermaid,katex,syntect}.rs`) — each plugin
   owns one capability and the assets needed to deliver it.
3. **Templates** (`templates/<name>/style.css` + `templates/cover.html`) —
   on-disk styles and the shared cover HTML. Unchanged from v0.1.1.
4. **Shell** (`src/cli.rs`) — clap entry point; constructs the kernel
   pipeline and runs it. Unchanged from v0.1.1.

The kernel does not import any plugin module by name. It holds a
`Registry<Box<dyn Plugin>>` and calls trait methods.

## Plugin trait

```rust
pub trait Plugin: Send + Sync {
    /// Stable identifier. Lowercase, hyphenated.
    fn name(&self) -> &'static str;

    /// Configure the markdown parser before parsing. Default: no-op.
    fn configure_parse(&self, _opts: &mut comrak::ComrakOptions) {}

    /// In-place AST rewrite after parse. Default: no-op.
    fn rewrite_ast<'a>(&self, _root: &'a comrak::nodes::AstNode<'a>) {}

    /// Provide a comrak code-fence syntax highlighter. Default: none.
    fn syntax_highlighter(
        &self,
    ) -> Option<&dyn comrak::adapters::SyntaxHighlighterAdapter> {
        None
    }

    /// Write the plugin's runtime assets into the scratch dir.
    /// Default: no-op.
    fn extract_assets(&self, _scratch: &std::path::Path) -> anyhow::Result<()> {
        Ok(())
    }

    /// HTML to inject into <head>. Default: empty.
    fn head_html(&self) -> &str { "" }

    /// JavaScript appended to the DOMContentLoaded init block. Default: empty.
    fn init_js(&self) -> &str { "" }

    /// Optional rewrite for plain-text cover values (title/subtitle).
    /// Returning `Some(html)` short-circuits default html-escaping.
    /// Default: `None`.
    fn rewrite_cover_text(&self, _text: &str) -> Option<String> { None }
}
```

Every method except `name` has a default. Most plugins implement two or
three.

## Pipeline

The kernel's `render_pdf` runs in this fixed order:

1. **Build registry**: `Registry::default()` returns
   `[MermaidPlugin, KatexPlugin, SyntectPlugin]`. Order is the
   composition order for `head_html` and `init_js`.
2. **Configure parse**: each plugin's `configure_parse(&mut options)`
   runs (KaTeX enables `math_dollars`).
3. **Parse**: comrak builds the AST.
4. **AST rewrite**: each plugin's `rewrite_ast(root)` runs in registry
   order (Mermaid converts ```` ```mermaid ```` fences into
   `<pre class="mermaid">` HTML blocks).
5. **Format HTML**: comrak renders to HTML, using the *first* plugin
   that returns `Some` from `syntax_highlighter` (Syntect).
6. **Extract cover values**: title/subtitle/eyebrow/author/date.
7. **Rewrite cover text**: title and subtitle pass through each plugin's
   `rewrite_cover_text`; first `Some` wins. Falls back to html-escape.
   (KaTeX converts `$...$` regions into math spans.)
8. **Substitute cover.html**.
9. **Extract plugin assets**: each plugin's `extract_assets(scratch)`
   runs (Mermaid writes `mermaid.min.js`, KaTeX writes the `katex/`
   tree).
10. **Assemble HTML**: `<head>` includes the template's style.css
    followed by each plugin's `head_html()` in registry order. The
    closing `</head>` is preceded by a `<script>` block that runs each
    plugin's `init_js()` at `DOMContentLoaded`.
11. **Spawn Chrome** with `--print-to-pdf` and the same flags as v0.1.1.
    Stderr is discarded.
12. **Cleanup**: scratch dir removed unless `KEEP_WORK=1`.

## Plugin definitions

### MermaidPlugin
- `name`: `"mermaid"`.
- `rewrite_ast`: walks the AST; `CodeBlock` nodes whose info string is
  `mermaid` (case-insensitive) become `HtmlBlock` containing
  `<pre class="mermaid">{escaped source}</pre>`.
- `extract_assets`: writes embedded `mermaid.min.js` to
  `<scratch>/mermaid.min.js`.
- `head_html`: `<script src="mermaid.min.js"></script>`.
- `init_js`: `mermaid.initialize({startOnLoad:true});`.

### KatexPlugin
- `name`: `"katex"`.
- `configure_parse`: sets `extension.math_dollars = true`.
- `extract_assets`: extracts the embedded `katex/` directory tree to
  `<scratch>/katex/`.
- `head_html`: `<link rel="stylesheet" href="katex/katex.min.css">` and
  `<script src="katex/katex.min.js"></script>`.
- `init_js`: walks `span[data-math-style="inline"]` and
  `span[data-math-style="display"]` and calls `katex.render`.
- `rewrite_cover_text`: walks `s` and converts `$...$` regions into
  `<span data-math-style="inline">` blocks; non-math text is
  html-escaped.

### SyntectPlugin
- `name`: `"syntect"`.
- `syntax_highlighter`: lazy-builds a `SyntectAdapter` from the
  `two-face` extended bundle with the `InspiredGitHub` theme.

## Asset lifecycle

The kernel does not know what assets a plugin needs. It calls
`extract_assets(scratch)` once per plugin, then assembles the HTML doc
under the assumption that each plugin's referenced paths now exist
relative to the scratch dir. If a plugin's assets fail to extract, the
render aborts and the scratch dir is preserved for debugging.

## Testing

Each plugin gets a unit-test file:

- `tests/mermaid_plugin.rs`: AST rewrite produces `<pre class="mermaid">`
  for ```` ```mermaid ```` fences; non-mermaid fences are untouched.
  `head_html` and `init_js` are non-empty.
- `tests/katex_plugin.rs`: `configure_parse` enables `math_dollars`;
  `rewrite_cover_text` converts `$\mathbb{R}$` into a math span; mismatched
  `$` falls back to escaped literal.
- `tests/syntect_plugin.rs`: `syntax_highlighter` returns `Some`; using
  the adapter via `format_html_with_plugins` produces styled spans for
  Rust, TypeScript, Elixir, Kotlin code.
- `tests/registry.rs`: a `Registry::default()` exposes plugins in the
  documented order; `head_html()` concatenates in order; `init_js()`
  does too.

The integration tests in `tests/render.rs` (cover extraction,
mermaid-fence emission via `markdown_to_html`, math `$$_..._$$`
preservation) keep their assertions but are now testing the kernel +
default registry, not inline kernel code.

## What we are *not* doing in v0.1.2

- No registry on disk (no central pack repository).
- No dynamic loading (plugins are statically linked into the binary).
- No plugin manifest format.
- No CLI flag to enable/disable plugins.
- No new content capability — output is identical to v0.1.1.

Those land later, once the trait surface has settled.
