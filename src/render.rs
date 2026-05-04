use anyhow::{anyhow, bail, Context, Result};
use include_dir::{include_dir, Dir};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// mermaid.js is embedded — never tweaked, no reason to ship it on disk.
static MERMAID_JS: &[u8] = include_bytes!("../mermaid.min.js");

/// KaTeX (CSS, JS, fonts, contrib/auto-render.min.js) is embedded for the same reason.
static KATEX_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/katex");

pub struct CoverValues {
    pub title: String,
    pub subtitle: String,
    pub eyebrow: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug)]
pub struct Assets {
    pub templates_dir: PathBuf,
    pub cover_html: PathBuf,
}

pub fn extract_cover_values(md: &str, stem: &str) -> CoverValues {
    let title = first_h1(md).unwrap_or_else(|| stem.to_string());
    let subtitle = first_body_line(md).unwrap_or_default();
    let eyebrow = stem.replace('-', " ").to_uppercase();
    let date = chrono::Local::now().format("%B %Y").to_string().to_uppercase();
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

pub fn substitute_cover(template: &str, cv: &CoverValues) -> String {
    // Title and subtitle commonly contain inline math like `$\mathbb{R}$`; the rest are plain.
    template
        .replace("{{title}}", &render_inline_math(&cv.title))
        .replace("{{subtitle}}", &render_inline_math(&cv.subtitle))
        .replace("{{eyebrow}}", &html_escape(&cv.eyebrow))
        .replace("{{author}}", &html_escape(&cv.author))
        .replace("{{date}}", &html_escape(&cv.date))
}

/// HTML-escape `s`, except convert `$...$` regions into `<span data-math-style="inline">` so
/// the cover-page picks up KaTeX rendering. Unmatched `$` is treated as a literal dollar.
fn render_inline_math(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut buf = String::new();
    let mut in_math = false;
    for c in s.chars() {
        if c == '$' {
            if in_math {
                out.push_str("<span data-math-style=\"inline\">");
                out.push_str(&html_escape(&buf));
                out.push_str("</span>");
                buf.clear();
                in_math = false;
            } else {
                out.push_str(&html_escape(&buf));
                buf.clear();
                in_math = true;
            }
        } else {
            buf.push(c);
        }
    }
    if in_math {
        out.push('$');
        out.push_str(&html_escape(&buf));
    } else {
        out.push_str(&html_escape(&buf));
    }
    out
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn markdown_to_html(md: &str) -> String {
    use comrak::nodes::{AstNode, NodeValue};
    use comrak::{parse_document, Arena, ComrakOptions};

    let mut options = ComrakOptions::default();
    options.extension.table = true;
    options.extension.footnotes = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.superscript = true;
    options.extension.math_dollars = true;
    options.render.unsafe_ = true;

    let arena = Arena::new();
    let root = parse_document(&arena, md, &options);

    fn walk<'a>(node: &'a AstNode<'a>) {
        for child in node.children() {
            let mut data = child.data.borrow_mut();
            let mermaid_src = match &data.value {
                NodeValue::CodeBlock(cb) if cb.info.trim().eq_ignore_ascii_case("mermaid") => {
                    Some(cb.literal.clone())
                }
                _ => None,
            };
            if let Some(src) = mermaid_src {
                let html = format!("<pre class=\"mermaid\">{}</pre>", html_escape(&src));
                data.value = NodeValue::HtmlBlock(comrak::nodes::NodeHtmlBlock {
                    block_type: 0,
                    literal: html,
                });
                continue;
            }
            drop(data);
            walk(child);
        }
    }
    walk(root);

    // Server-side syntax highlighting via syntect, using `two-face`'s extended bundle
    // (covers TypeScript, Elixir, Kotlin, etc. — beyond syntect's default ~70 languages).
    let adapter = comrak::plugins::syntect::SyntectAdapterBuilder::new()
        .syntax_set(two_face::syntax::extra_newlines())
        .theme("InspiredGitHub")
        .build();
    let mut plugins = comrak::Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&adapter);

    let mut buf = Vec::new();
    comrak::format_html_with_plugins(root, &options, &mut buf, &plugins).expect("format_html");
    String::from_utf8(buf).expect("utf8")
}

pub fn find_assets(bin_dir: &Path) -> Result<Assets> {
    let templates_dir = bin_dir.join("templates");
    let cover_html = templates_dir.join("cover.html");

    if !templates_dir.is_dir() {
        bail!("missing assets: templates/ not found at {}", templates_dir.display());
    }
    if !cover_html.is_file() {
        bail!("missing assets: cover.html not found at {}", cover_html.display());
    }
    Ok(Assets { templates_dir, cover_html })
}

pub fn assets_from_exe() -> Result<Assets> {
    let exe = env::current_exe().context("locating current executable")?;
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("current_exe has no parent: {}", exe.display()))?;
    find_assets(dir)
}

pub fn render_pdf(input: &Path, output: &Path, template: &str) -> Result<()> {
    let assets = assets_from_exe()?;
    let style_css = assets.templates_dir.join(template).join("style.css");
    if !style_css.is_file() {
        bail!(
            "template '{}' not found: {} missing",
            template,
            style_css.display()
        );
    }

    let md = fs::read_to_string(input)
        .with_context(|| format!("reading input {}", input.display()))?;
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");

    let cover_template = fs::read_to_string(&assets.cover_html)
        .with_context(|| format!("reading {}", assets.cover_html.display()))?;
    let cover_values = extract_cover_values(&md, stem);
    let cover_html = substitute_cover(&cover_template, &cover_values);
    let body_html = markdown_to_html(&md);

    let scratch = scratch_dir(output);
    fs::create_dir_all(&scratch)
        .with_context(|| format!("creating scratch dir {}", scratch.display()))?;
    let keep_scratch = env::var("KEEP_WORK").as_deref() == Ok("1");

    fs::copy(&style_css, scratch.join("style.css"))
        .with_context(|| format!("copying {}", style_css.display()))?;
    fs::write(scratch.join("mermaid.min.js"), MERMAID_JS)
        .with_context(|| format!("writing mermaid.min.js to {}", scratch.display()))?;
    extract_embedded_dir(&KATEX_DIR, &scratch.join("katex"))
        .with_context(|| format!("extracting embedded katex/ to {}", scratch.display()))?;

    let html_doc = format!(
        "<!DOCTYPE html>\n<html><head>\n\
         <meta charset=\"utf-8\">\n\
         <title>{title}</title>\n\
         <link rel=\"stylesheet\" href=\"katex/katex.min.css\">\n\
         <link rel=\"stylesheet\" href=\"style.css\">\n\
         <script src=\"katex/katex.min.js\"></script>\n\
         <script src=\"mermaid.min.js\"></script>\n\
         <script>mermaid.initialize({{startOnLoad:true}});</script>\n\
         <script>{katex_init}</script>\n\
         </head><body>\n{cover}\n{body}\n</body></html>\n",
        title = html_escape(&cover_values.title),
        katex_init = KATEX_INIT_JS,
        cover = cover_html,
        body = body_html,
    );
    let html_path = scratch.join("index.html");
    fs::write(&html_path, html_doc.as_bytes())
        .with_context(|| format!("writing {}", html_path.display()))?;

    let chrome = locate_chrome()?;
    let status = Command::new(&chrome)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--virtual-time-budget=10000",
        ])
        .arg(format!("--print-to-pdf={}", output.display()))
        .arg(format!("file://{}", html_path.display()))
        // Chrome headless emits benign macOS warnings (TASK_CATEGORY_POLICY etc.) on stderr.
        // Discard both streams; if Chrome fails, we report the exit code with the scratch path.
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

/// Render math nodes (emitted by comrak's math_dollars extension) with KaTeX.
/// Runs at DOMContentLoaded so it completes within Chrome's --virtual-time-budget.
const KATEX_INIT_JS: &str = "\
document.addEventListener('DOMContentLoaded', function() {\
  document.querySelectorAll('span[data-math-style=\"inline\"]').forEach(function(el){\
    try { katex.render(el.textContent, el, {throwOnError:false, displayMode:false}); } catch(e){}\
  });\
  document.querySelectorAll('span[data-math-style=\"display\"]').forEach(function(el){\
    try { katex.render(el.textContent, el, {throwOnError:false, displayMode:true}); } catch(e){}\
  });\
});";

fn extract_embedded_dir(dir: &Dir<'_>, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)
        .with_context(|| format!("creating {}", dst.display()))?;
    for entry in dir.entries() {
        let name = entry
            .path()
            .file_name()
            .ok_or_else(|| anyhow!("embedded entry has no file name"))?;
        let to = dst.join(name);
        match entry {
            include_dir::DirEntry::File(f) => {
                fs::write(&to, f.contents())
                    .with_context(|| format!("writing {}", to.display()))?;
            }
            include_dir::DirEntry::Dir(d) => extract_embedded_dir(d, &to)?,
        }
    }
    Ok(())
}

fn scratch_dir(output: &Path) -> PathBuf {
    let mut name = output.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    name.push(".work");
    output.with_file_name(name)
}

fn locate_chrome() -> Result<PathBuf> {
    if let Ok(p) = env::var("CHROME") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
        bail!("CHROME env var set but not executable: {}", pb.display());
    }
    let mac = PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    if mac.is_file() {
        return Ok(mac);
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
    bail!("Chrome not found; set CHROME=/path/to/chrome")
}
