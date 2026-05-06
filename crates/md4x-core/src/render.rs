//! Kernel: orchestrates the markdown-to-PDF pipeline. The kernel does not
//! import plugin modules by name — it holds a [`Registry`] and calls trait
//! methods. See `docs/spec/plugin-architecture.md`.

use anyhow::{anyhow, bail, Context, Result};
use comrak::nodes::{AstNode, NodeValue};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::plugins::{html_escape, Registry};
use crate::templates;

pub struct CoverValues {
    pub title: String,
    pub subtitle: String,
    pub eyebrow: String,
    pub author: String,
    pub date: String,
}

/// Strip a leading UTF-8 BOM (`U+FEFF`) if present. Files saved by some
/// editors include one; downstream parsers (comrak, our own line-walking)
/// would otherwise see it as content and produce wrong output.
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

pub fn extract_cover_values(md: &str, stem: &str) -> CoverValues {
    // Sanitize: BOM strip + run the same plugin preprocess as rendering, so
    // multi-line $$ blocks don't trigger Setext H1 detection inside cover
    // extraction.
    let md = strip_bom(md);
    let registry = Registry::default();
    let md = registry.preprocess_markdown(md);

    let arena = comrak::Arena::new();
    let mut opts = comrak::ComrakOptions::default();
    registry.configure_parse(&mut opts);
    let root = comrak::parse_document(&arena, &md, &opts);

    let title = first_h1_text(root).unwrap_or_else(|| stem.to_string());
    let subtitle = first_prose_paragraph_text(root).unwrap_or_default();
    let eyebrow = stem.replace('-', " ").to_uppercase();
    let date = chrono::Local::now()
        .format("%B %Y")
        .to_string()
        .to_uppercase();
    CoverValues {
        title,
        subtitle,
        eyebrow,
        author: String::new(),
        date,
    }
}

/// First H1 in the AST, as plain text. AST-based so a BOM-stripped, properly
/// parsed `# Title` is found regardless of where it sits relative to other
/// content.
fn first_h1_text<'a>(root: &'a AstNode<'a>) -> Option<String> {
    for child in root.children() {
        let data = child.data.borrow();
        if let NodeValue::Heading(ref h) = data.value {
            if h.level == 1 {
                drop(data);
                let mut text = String::new();
                walk_inline_plain(child, &mut text);
                let t = text.trim().to_string();
                if !t.is_empty() {
                    return Some(t);
                }
            }
        }
    }
    None
}

/// First paragraph that contains real prose (Text / Strong / Emph / Link /
/// Image). Paragraphs whose only inline content is math, code, or raw HTML
/// are skipped — they aren't suitable as a cover subtitle. Returns the
/// paragraph text with `**bold**` / `*emph*` / `` `code` `` markers
/// preserved (so the user's intent is visible), then strips a leading
/// `**Label:** ` if present.
fn first_prose_paragraph_text<'a>(root: &'a AstNode<'a>) -> Option<String> {
    for child in root.children() {
        let data = child.data.borrow();
        let is_paragraph = matches!(data.value, NodeValue::Paragraph);
        drop(data);
        if !is_paragraph || !is_prose_paragraph(child) {
            continue;
        }
        let raw = inline_text_with_markers(child);
        let stripped = strip_leading_label(&raw);
        let s = stripped.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    None
}

fn is_prose_paragraph<'a>(para: &'a AstNode<'a>) -> bool {
    for inline in para.children() {
        let data = inline.data.borrow();
        match &data.value {
            NodeValue::Math(_) | NodeValue::Code(_) | NodeValue::HtmlInline(_) => continue,
            _ => return true,
        }
    }
    false
}

fn walk_inline_plain<'a>(node: &'a AstNode<'a>, out: &mut String) {
    for child in node.children() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::Text(s) => out.push_str(s),
            NodeValue::Code(c) => out.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            _ => {
                drop(data);
                walk_inline_plain(child, out);
            }
        }
    }
}

fn inline_text_with_markers<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    emit_inline_with_markers(node, &mut out);
    out
}

fn emit_inline_with_markers<'a>(node: &'a AstNode<'a>, out: &mut String) {
    for child in node.children() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::Text(s) => out.push_str(s),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            NodeValue::Strong => {
                out.push_str("**");
                drop(data);
                emit_inline_with_markers(child, out);
                out.push_str("**");
            }
            NodeValue::Emph => {
                out.push('*');
                drop(data);
                emit_inline_with_markers(child, out);
                out.push('*');
            }
            NodeValue::Code(c) => {
                out.push('`');
                out.push_str(&c.literal);
                out.push('`');
            }
            _ => {
                drop(data);
                emit_inline_with_markers(child, out);
            }
        }
    }
}

/// Strip a leading `**Label:** ` from a paragraph text, preserving any
/// further `**bold**` markers in the rest of the line. Replaces the old
/// `out.replace("**", "")` sledgehammer that destroyed all bolds.
fn strip_leading_label(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("**") {
        if let Some(end) = rest.find(":**") {
            return rest[end + 3..].trim_start().to_string();
        }
    }
    s.to_string()
}

/// Substitute cover values into the cover.html template, using `registry` to
/// rewrite text fields (KaTeX claims `$...$` in title/subtitle).
pub fn substitute_cover_with(template: &str, cv: &CoverValues, registry: &Registry) -> String {
    template
        .replace("{{title}}", &registry.rewrite_cover_text(&cv.title))
        .replace("{{subtitle}}", &registry.rewrite_cover_text(&cv.subtitle))
        .replace("{{eyebrow}}", &html_escape(&cv.eyebrow))
        .replace("{{author}}", &html_escape(&cv.author))
        .replace("{{date}}", &html_escape(&cv.date))
}

/// Convenience wrapper using the default registry. Used by integration tests.
pub fn substitute_cover(template: &str, cv: &CoverValues) -> String {
    substitute_cover_with(template, cv, &Registry::default())
}

/// Render markdown to HTML using the default registry.
pub fn markdown_to_html(md: &str) -> String {
    markdown_to_html_with(md, &Registry::default())
}

pub fn markdown_to_html_with(md: &str, registry: &Registry) -> String {
    use comrak::{parse_document, Arena, ComrakOptions};

    let preprocessed = registry.preprocess_markdown(md);

    let mut options = ComrakOptions::default();
    options.extension.table = true;
    options.extension.footnotes = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.superscript = true;
    options.render.unsafe_ = true;
    registry.configure_parse(&mut options);

    let arena = Arena::new();
    let root = parse_document(&arena, &preprocessed, &options);
    registry.rewrite_ast(root);

    let mut comrak_plugins = comrak::Plugins::default();
    comrak_plugins.render.codefence_syntax_highlighter = registry.syntax_highlighter();

    let mut buf = Vec::new();
    comrak::format_html_with_plugins(root, &options, &mut buf, &comrak_plugins)
        .expect("format_html");
    String::from_utf8(buf).expect("utf8")
}

pub fn render_pdf(input: &Path, output: &Path, template: &str) -> Result<()> {
    let style_css = templates::style_css(template)?;
    let cover_template = templates::cover_html()?;

    let raw = fs::read_to_string(input)
        .with_context(|| format!("reading input {}", input.display()))?;
    // Strip a UTF-8 BOM if the file came from an editor that adds one;
    // otherwise downstream parsers see U+FEFF as content.
    let md = strip_bom(&raw).to_string();
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");

    // Fail fast if Chrome is missing — before we render HTML or create a scratch dir.
    let chrome = locate_chrome()?;

    let registry = Registry::default();
    let cover_values = extract_cover_values(&md, stem);
    let cover_html = substitute_cover_with(&cover_template, &cover_values, &registry);
    let body_html = markdown_to_html_with(&md, &registry);

    let scratch = scratch_dir(output);
    fs::create_dir_all(&scratch)
        .with_context(|| format!("creating scratch dir {}", scratch.display()))?;
    // `file://` URLs handed to Chrome must be absolute. If the user passed a
    // relative `-o` path, the scratch dir is relative too and Chrome rejects
    // `file://relative/path/...` with ERR_INVALID_URL — silently breaking
    // mermaid + KaTeX which load via that page. Canonicalize once.
    let scratch = scratch
        .canonicalize()
        .with_context(|| format!("canonicalizing scratch dir {}", scratch.display()))?;
    let keep_scratch = env::var("KEEP_WORK").map(|v| is_truthy(&v)).unwrap_or(false);

    fs::write(scratch.join("style.css"), style_css.as_bytes())
        .with_context(|| format!("writing style.css to {}", scratch.display()))?;
    registry.extract_assets(&scratch)?;

    let html_doc = format!(
        "<!DOCTYPE html>\n<html><head>\n\
         <meta charset=\"utf-8\">\n\
         <title>{title}</title>\n\
         <link rel=\"stylesheet\" href=\"style.css\">\n\
         {head}\
         <script>document.addEventListener('DOMContentLoaded',function(){{\n{init}}});</script>\n\
         </head><body>\n{cover}\n{body}\n</body></html>\n",
        title = html_escape(&cover_values.title),
        head = registry.head_html(),
        init = registry.init_js(),
        cover = cover_html,
        body = body_html,
    );
    let html_path = scratch.join("index.html");
    fs::write(&html_path, html_doc.as_bytes())
        .with_context(|| format!("writing {}", html_path.display()))?;

    // Build the file:// URL via `url::Url::from_file_path`, which percent-
    // encodes path bytes per RFC 3986. Naively concatenating the path into a
    // file:// URL string fails for any path containing `&`, `'`, `"`, `$`,
    // `?`, `#`, `%`, or any non-ASCII byte.
    let html_url = file_url(&html_path)?;
    let budget = chrome_budget_ms(&md);

    let status = Command::new(&chrome)
        .args(["--headless", "--disable-gpu", "--no-pdf-header-footer"])
        .arg(format!("--virtual-time-budget={budget}"))
        .arg(format!("--print-to-pdf={}", output.display()))
        .arg(&html_url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("spawning chrome at {}", chrome.display()))?;

    if !status.success() {
        bail!(
            "chrome failed (exit {:?}); scratch dir kept at {}",
            status.code(),
            scratch.display()
        );
    }
    if !output.is_file() || fs::metadata(output).map(|m| m.len()).unwrap_or(0) == 0 {
        bail!(
            "chrome produced no output at {}; scratch dir kept at {}",
            output.display(),
            scratch.display()
        );
    }

    if !keep_scratch {
        let _ = fs::remove_dir_all(&scratch);
    }
    Ok(())
}

/// Per-render scratch directory adjacent to the output. Salted with PID +
/// nanosecond timestamp so that two concurrent `md4x` runs writing to the
/// same output path don't collide on the same scratch dir (Bug J).
pub fn scratch_dir(output: &Path) -> PathBuf {
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut name = output
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".work-{pid}-{nanos}"));
    output.with_file_name(name)
}

/// Build a `file://` URL from an absolute filesystem path with **aggressive**
/// percent-encoding. Chrome's `file://` URL parser is stricter than RFC 3986
/// — it does not accept the sub-delim set (`& ' ( ) * + , ; = ! $`) raw in
/// path components, even though the RFC allows them. Encoding everything
/// except the unreserved set (`A-Z a-z 0-9 - . _ ~`) plus `/` keeps Chrome
/// happy without losing path-segment structure.
pub fn file_url(p: &Path) -> Result<String> {
    use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
    /// Encode every byte except the RFC 3986 unreserved set + `/`.
    const FILE_PATH: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'/')
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~');
    if !p.is_absolute() {
        bail!(
            "cannot build file:// URL from {} (must be absolute)",
            p.display()
        );
    }
    let s = p
        .to_str()
        .ok_or_else(|| anyhow!("non-UTF-8 path: {}", p.display()))?;
    let encoded: String = utf8_percent_encode(s, FILE_PATH).collect();
    Ok(format!("file://{encoded}"))
}

/// Truthy env-var parsing — accepts the common Unix-tool conventions.
/// Used for `KEEP_WORK` so `KEEP_WORK=true`, `=yes`, `=on`, `=1` all behave
/// the same.
pub fn is_truthy(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Compute Chrome's `--virtual-time-budget` for this document. Mermaid is
/// rendered in-browser at print time; each diagram does dozens of DOM
/// operations that advance virtual time, so the fixed 10s budget we used
/// to ship was inadequate for diagram-heavy docs (50+ blocks rendered
/// partially). Scale the budget linearly with mermaid block count, capped
/// at 60s so absurd inputs don't translate into multi-minute waits.
pub fn chrome_budget_ms(md: &str) -> u32 {
    let mermaid_count = md
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t == "```mermaid" || t.starts_with("```mermaid ") || t.starts_with("```mermaid\t")
        })
        .count() as u32;
    const BASE_MS: u32 = 5_000;
    const PER_MERMAID_MS: u32 = 300;
    const SAFETY_MS: u32 = 2_000;
    const CAP_MS: u32 = 60_000;
    BASE_MS
        .saturating_add(mermaid_count.saturating_mul(PER_MERMAID_MS))
        .saturating_add(SAFETY_MS)
        .min(CAP_MS)
}

/// Locate a Chrome (or Chromium-based) browser binary.
/// Search order:
///   1. `CHROME` env var (must exist as an executable file)
///   2. `/Applications/Google Chrome.app/...` (macOS system install)
///   3. `~/Applications/Google Chrome.app/...` (per-user install)
///   4. `which google-chrome` / `chromium` / `chromium-browser`
/// On total miss, returns a multi-line error with install guidance.
pub fn locate_chrome() -> Result<PathBuf> {
    if let Ok(p) = env::var("CHROME") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Ok(pb);
        }
        bail!(
            "CHROME env var points at {:?}, but no such executable exists.\n\
             Set CHROME to the path of a Chrome / Chromium binary, or unset it to use auto-detection.",
            p
        );
    }
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    if let Ok(home) = env::var("HOME") {
        candidates.push(PathBuf::from(format!(
            "{home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        )));
    }
    for c in &candidates {
        if c.is_file() {
            return Ok(c.clone());
        }
    }
    for name in ["google-chrome", "chromium", "chromium-browser"] {
        if let Ok(out) = Command::new("which").arg(name).output() {
            if out.status.success() {
                let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !line.is_empty() {
                    return Ok(PathBuf::from(line));
                }
            }
        }
    }
    bail!("{}", chrome_install_help())
}

/// Multi-line install guidance shown when Chrome can't be located. Public so
/// CLI / tests can render it consistently.
pub fn chrome_install_help() -> String {
    "\
Chrome is required for PDF rendering, but no Chrome / Chromium browser was found.

Install Google Chrome:
  • Download:  https://www.google.com/chrome/
  • Homebrew:  brew install --cask google-chrome

If Chrome is installed at a non-standard path, point md4x at it:
  CHROME=/path/to/chrome md4x ...

md4x will not run without Chrome — there is no fallback renderer."
        .to_string()
}
