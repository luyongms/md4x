//! KatexPlugin: enables comrak's `math_dollars` extension so `$...$` and
//! `$$...$$` are preserved verbatim, ships the embedded `katex/` tree, and
//! contributes the init JS that walks `[data-math-style]` spans and renders
//! them. Also rewrites cover-text values so the cover page can typeset
//! inline math.

use anyhow::{Context, Result};
use include_dir::{include_dir, Dir};
use std::fs;
use std::path::Path;

use super::{html_escape, Plugin};

static KATEX_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/katex");

pub fn katex_dir() -> &'static Dir<'static> { &KATEX_DIR }

const HEAD_HTML: &str = "\
<link rel=\"stylesheet\" href=\"katex/katex.min.css\">\n\
<script src=\"katex/katex.min.js\"></script>\n";

const INIT_JS: &str = "\
document.querySelectorAll('span[data-math-style=\"inline\"]').forEach(function(el){\
  try { katex.render(el.textContent, el, {throwOnError:false, displayMode:false}); } catch(e){}\
});\
document.querySelectorAll('span[data-math-style=\"display\"]').forEach(function(el){\
  try { katex.render(el.textContent, el, {throwOnError:false, displayMode:true}); } catch(e){}\
});";

pub struct KatexPlugin;

impl Plugin for KatexPlugin {
    fn name(&self) -> &'static str {
        "katex"
    }

    fn preprocess_markdown(&self, md: &str) -> Option<String> {
        Some(collapse_display_math_blocks(md))
    }

    fn configure_parse(&self, opts: &mut comrak::ComrakOptions) {
        opts.extension.math_dollars = true;
    }

    fn rewrite_ast<'a>(&self, root: &'a comrak::nodes::AstNode<'a>) {
        add_math_hashes(root);
    }

    fn extract_assets(&self, scratch: &Path) -> Result<()> {
        extract_dir(&KATEX_DIR, &scratch.join("katex"))
            .with_context(|| format!("extracting katex/ to {}", scratch.display()))
    }

    fn head_html(&self) -> &str {
        HEAD_HTML
    }

    fn init_js(&self) -> &str {
        INIT_JS
    }

    fn rewrite_cover_text(&self, text: &str) -> Option<String> {
        // Always claim — cover text gets html-escaped here, plus inline math turned into spans.
        Some(render_inline_math(text))
    }
}

/// Collapse multi-line `$$...$$` display-math blocks into a single line so
/// comrak's *inline-level* `math_dollars` extension can recognize them.
///
/// Without this, a markdown like:
///
/// ```text
/// $$
/// \mathbf{A}\cdot\mathbf{x}
/// =
/// \mathbf{b}
/// $$
/// ```
///
/// gets parsed by CommonMark's Setext rule as an H1 (the bare `=` line is a
/// level-1 underline), shredding the math block before math processing runs.
/// Collapsing to `$$ \mathbf{A}\cdot\mathbf{x} = \mathbf{b} $$` on a single
/// line lets comrak's math extension claim it.
///
/// Fenced code blocks are skipped — `$$` inside ```` ``` ```` is left alone.
pub fn collapse_display_math_blocks(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut in_code_fence = false;
    let mut in_math = false;
    let mut buf = String::new();

    for line in md.lines() {
        let trimmed_start = line.trim_start();

        if !in_math && trimmed_start.starts_with("```") {
            in_code_fence = !in_code_fence;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_code_fence {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        if line.trim() == "$$" {
            if in_math {
                buf.push_str("$$");
                out.push_str(&buf);
                out.push('\n');
                buf.clear();
                in_math = false;
            } else {
                in_math = true;
                buf.clear();
                buf.push_str("$$ ");
            }
            continue;
        }
        if in_math {
            buf.push_str(line.trim());
            buf.push(' ');
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }

    // Unclosed math block — emit raw rather than dropping content.
    if in_math {
        out.push_str(&buf);
    }
    out
}

/// Walk `s`, converting `$...$` regions into KaTeX inline-math spans.
///
/// Uses pandoc's / CommonMark math-extension delimiter rules to disambiguate
/// math from literal `$`:
///   - A `$` is a math *opener* only if the following char is non-whitespace
///     and non-digit (so `$5` is literal currency, not the start of math).
///   - A `$` is a math *closer* only if the preceding char is non-whitespace
///     (so a sentence ending with ` $` doesn't accidentally close math).
///
/// If a candidate opener has no valid closer, we emit a literal `$` and keep
/// scanning. Non-math text is HTML-escaped in chunks; `$` itself is not an
/// HTML metacharacter so we never need to escape it.
fn render_inline_math(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' {
            let next = chars.get(i + 1).copied();
            let is_opener = matches!(next, Some(c) if !c.is_whitespace() && !c.is_ascii_digit());
            if is_opener {
                if let Some(close) = find_math_close(&chars, i + 1) {
                    let math_src: String = chars[i + 1..close].iter().collect();
                    out.push_str("<span data-math-style=\"inline\">");
                    out.push_str(&html_escape(&math_src));
                    out.push_str("</span>");
                    i = close + 1;
                    continue;
                }
            }
            // Literal dollar sign.
            out.push('$');
            i += 1;
        } else {
            // Run-of-non-`$` chunk: html-escape once.
            let start = i;
            while i < chars.len() && chars[i] != '$' {
                i += 1;
            }
            let chunk: String = chars[start..i].iter().collect();
            out.push_str(&html_escape(&chunk));
        }
    }
    out
}

/// Find the index of a valid math closer starting from `from`. A `$` is a
/// valid closer only if the previous char is non-whitespace.
fn find_math_close(chars: &[char], from: usize) -> Option<usize> {
    let mut j = from;
    while j < chars.len() {
        if chars[j] == '$' && j > 0 && !chars[j - 1].is_whitespace() {
            return Some(j);
        }
        j += 1;
    }
    None
}

fn add_math_hashes<'a>(node: &'a comrak::nodes::AstNode<'a>) {
    use comrak::nodes::NodeValue;
    for child in node.children() {
        let math = {
            let d = child.data.borrow();
            match &d.value {
                NodeValue::Math(m) => Some((m.literal.clone(), m.display_math)),
                _ => None,
            }
        };
        if let Some((literal, display)) = math {
            let style = if display { "display" } else { "inline" };
            let hash = super::block_hash(&literal);
            let escaped = super::html_escape(&literal);
            let s = format!(
                "<span data-math-style=\"{style}\" data-md4x-hash=\"{hash}\">{escaped}</span>"
            );
            child.data.borrow_mut().value = NodeValue::HtmlInline(s);
        } else {
            add_math_hashes(child);
        }
    }
}

fn extract_dir(dir: &Dir<'_>, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("creating {}", dst.display()))?;
    for entry in dir.entries() {
        let name = entry
            .path()
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("embedded entry has no file name"))?;
        let to = dst.join(name);
        match entry {
            include_dir::DirEntry::File(f) => {
                fs::write(&to, f.contents())
                    .with_context(|| format!("writing {}", to.display()))?;
            }
            include_dir::DirEntry::Dir(d) => extract_dir(d, &to)?,
        }
    }
    Ok(())
}
