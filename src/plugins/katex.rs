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

    fn configure_parse(&self, opts: &mut comrak::ComrakOptions) {
        opts.extension.math_dollars = true;
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

/// Walk `s`, converting `$...$` regions into KaTeX inline-math spans.
/// Non-math text is HTML-escaped. Unmatched `$` survives as a literal dollar.
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
