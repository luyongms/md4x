//! Kernel: orchestrates the markdown-to-PDF pipeline. The kernel does not
//! import plugin modules by name — it holds a [`Registry`] and calls trait
//! methods. See `docs/spec/plugin-architecture.md`.

use anyhow::{bail, Context, Result};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::plugins::{html_escape, Registry};
use crate::templates;

pub struct CoverValues {
    pub title: String,
    pub subtitle: String,
    pub eyebrow: String,
    pub author: String,
    pub date: String,
}

pub fn extract_cover_values(md: &str, stem: &str) -> CoverValues {
    let title = first_h1(md).unwrap_or_else(|| stem.to_string());
    let subtitle = first_body_line(md).unwrap_or_default();
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

fn first_h1(md: &str) -> Option<String> {
    for line in md.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("# ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

fn first_body_line(md: &str) -> Option<String> {
    let mut seen_h1 = false;
    for line in md.lines() {
        let t = line.trim();
        if !seen_h1 {
            if t.starts_with("# ") {
                seen_h1 = true;
            }
            continue;
        }
        if t.is_empty() || t.starts_with('#') || t.starts_with("---") {
            continue;
        }
        return Some(strip_label_and_bold(t));
    }
    None
}

fn strip_label_and_bold(s: &str) -> String {
    let mut out = s.to_string();
    if out.starts_with("**") {
        if let Some(end) = out[2..].find(":**") {
            out = out[2 + end + 3..].trim_start().to_string();
        }
    }
    out.replace("**", "")
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
    let root = parse_document(&arena, md, &options);
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

    let md = fs::read_to_string(input)
        .with_context(|| format!("reading input {}", input.display()))?;
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
    let keep_scratch = env::var("KEEP_WORK").as_deref() == Ok("1");

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

    let status = Command::new(&chrome)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--virtual-time-budget=10000",
        ])
        .arg(format!("--print-to-pdf={}", output.display()))
        .arg(format!("file://{}", html_path.display()))
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

fn scratch_dir(output: &Path) -> PathBuf {
    let mut name = output
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(".work");
    output.with_file_name(name)
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
