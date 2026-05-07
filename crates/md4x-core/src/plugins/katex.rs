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

// Default KaTeX options + macros, shared with the post-morphdom render path
// in app.js. Stored on window.MD4X_KATEX_OPTIONS. Generated in JS so the
// `\cA`-`\cZ` and family don't need 100 hand-typed lines.
//
// Scope: GENERAL math notation only — things you'd see in any math book.
// Document-specific shortcuts (crypto adversaries, pseudocode commands,
// per-author renames) belong in `<filename>.macros.json` next to the source.
const INIT_JS: &str = r#"
(function(){
  var macros = {};
  // Programmatic letter-prefix families:
  //   \cA-\cZ    -> \mathcal{A}-\mathcal{Z}
  //   \bA-\bZ    -> \mathbf{A}-\mathbf{Z}
  //   \fA-\fZ    -> \mathfrak{A}-\mathfrak{Z}
  //   \bbA-\bbZ  -> \mathbb{A}-\mathbb{Z}
  //   \frakA-\frakZ -> \mathfrak{A}-\mathfrak{Z}
  for (var i = 0; i < 26; i++) {
    var L = String.fromCharCode(65 + i);
    macros['\\c' + L]    = '\\mathcal{'  + L + '}';
    macros['\\b' + L]    = '\\mathbf{'   + L + '}';
    macros['\\f' + L]    = '\\mathfrak{' + L + '}';
    macros['\\bb' + L]   = '\\mathbb{'   + L + '}';
    macros['\\frak' + L] = '\\mathfrak{' + L + '}';
  }
  // Common single-letter blackboard shorthands (general math).
  Object.assign(macros, {
    '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}', '\\Z':  '\\mathbb{Z}',
    '\\QQ': '\\mathbb{Q}', '\\Q':  '\\mathbb{Q}',
    '\\RR': '\\mathbb{R}', '\\R':  '\\mathbb{R}',
    '\\CC': '\\mathbb{C}', '\\C':  '\\mathbb{C}',
    '\\FF': '\\mathbb{F}', '\\F':  '\\mathbb{F}',
    '\\GG': '\\mathbb{G}', '\\HH': '\\mathbb{H}',
    '\\AA': '\\mathbb{A}', '\\BB': '\\mathbb{B}', '\\DD': '\\mathbb{D}',
    '\\PP': '\\mathbb{P}', '\\EE': '\\mathbb{E}',
    '\\KK': '\\mathbb{K}', '\\TT': '\\mathbb{T}',
    '\\1':  '\\mathbf{1}',
  });
  // Math operators / shorthand (general).
  Object.assign(macros, {
    '\\defeq':   '\\stackrel{\\mathrm{def}}{=}',
    '\\eqdef':   '\\stackrel{\\mathrm{def}}{=}',
    '\\divides': '\\mid',
    '\\nmid':    '\\not\\mid',
    '\\setm':    '\\setminus',
    '\\sample':  '\\stackrel{\\$}{\\leftarrow}',
    '\\To':      '\\Rightarrow',
    '\\iff':     '\\Leftrightarrow',
    '\\im':      '\\operatorname{im}',
    '\\ker':     '\\operatorname{ker}',
    '\\rank':    '\\operatorname{rank}',
    '\\span':    '\\operatorname{span}',
    '\\lcm':     '\\operatorname{lcm}',
    '\\Hom':     '\\operatorname{Hom}',
    '\\End':     '\\operatorname{End}',
    '\\Aut':     '\\operatorname{Aut}',
    '\\Res':     '\\operatorname{Res}',
    '\\diag':    '\\operatorname{diag}',
    '\\sgn':     '\\operatorname{sgn}',
    '\\abs':     '\\#',
    '\\bigO':    '\\mathcal{O}',
    '\\smallO':  '\\mathit{o}',
    '\\cl':      '[#1]',
  });
  // Probability / complexity (general).
  Object.assign(macros, {
    '\\negl':   '\\mathsf{negl}',
    '\\poly':   '\\mathsf{poly}',
    '\\pr':     '\\Pr\\!\\left[#1\\right]',
    '\\Expect': '\\mathbb{E}',
  });
  // Snapshot the defaults BEFORE merging user macros, so a later macros.json
  // edit can be applied cleanly without losing builtins.
  window.MD4X_DEFAULT_MACROS = Object.assign({}, macros);
  // Per-document overrides: render_html injects `window.MD4X_USER_MACROS`
  // BEFORE this script runs, loaded from `<file>.macros.json` next to the
  // markdown source. User entries win over our defaults.
  if (window.MD4X_USER_MACROS && typeof window.MD4X_USER_MACROS === 'object') {
    Object.assign(macros, window.MD4X_USER_MACROS);
  }
  window.MD4X_KATEX_OPTIONS = {
    // throwOnError: true so undefined control sequences raise — the
    // catch handler in the render loop converts every throw into a
    // synthetic `.katex-error[title]` span which the GUI scanner reads.
    // With throwOnError:false + strict:'ignore' the previous setup
    // silently text-rendered unknown commands and the warning pill
    // never fired.
    throwOnError: true,
    strict: 'warn',
    macros: macros,
  };
  // Live-update path: app.js calls this when `<file>.macros.json` changes
  // without reloading the iframe. Rebuilds MD4X_KATEX_OPTIONS.macros from
  // the snapshot + the new user object.
  window.md4xUpdateMacros = function(userMacros) {
    var fresh = Object.assign({}, window.MD4X_DEFAULT_MACROS, userMacros || {});
    window.MD4X_KATEX_OPTIONS.macros = fresh;
  };

  // Sanitize math source for KaTeX. Two specific patterns crash the
  // entire \[...\] block in our KaTeX bundle even when individually they
  // could be parsed:
  //   1. \text{\underline{X}}  — KaTeX's text mode doesn't allow
  //      \underline (math-mode only). Swap to \underline{\text{X}}.
  //   2. \def\X{body} / \newcommand{\X}{body} — KaTeX *supports* these
  //      but if the body references an undefined macro, the WHOLE math
  //      block fails. Strip them; the user's macros.json is the right
  //      place for definitions.
  window.md4xSanitizeMath = function(s) {
    if (typeof s !== 'string') return s;
    // Strip TeX-style macro definitions. Handle one level of brace
    // nesting in the body. Repeat until stable to catch chained defs.
    for (var n = 0; n < 6; n++) {
      var prev = s;
      // \def\X{body}, \def\X#1#2{body}, \edef \xdef \gdef variants
      s = s.replace(/\\(?:def|edef|xdef|gdef)\\[a-zA-Z]+(?:#\d)*\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
      // \newcommand{\X}{body}, \providecommand etc., with optional [arity]
      s = s.replace(/\\(?:newcommand|providecommand|renewcommand)\s*\{?\\[a-zA-Z]+\}?(?:\s*\[\d+\])?(?:\s*\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
      if (s === prev) break;
    }
    // Swap \text{\underline{X}} → \underline{\text{X}} (text mode has
    // no \underline; the inverse nesting puts \underline back in math
    // mode where it works).
    s = s.replace(/\\text\{\\underline\{([^}]*)\}\}/g, '\\underline{\\text{$1}}');
    return s;
  };
})();
function md4xKatexOpts(display){
  return Object.assign({displayMode:!!display}, window.MD4X_KATEX_OPTIONS);
}
// Store the original math source on each span before rendering so
// app.js can re-render the same block with updated macros later
// (KaTeX replaces the span's contents on render — source would be lost).
document.querySelectorAll('span[data-math-style]').forEach(function(el){
  if (!el.dataset.mathSrc) el.dataset.mathSrc = el.textContent;
});
// On any KaTeX render failure (e.g. an undefined control sequence
// that KaTeX *does* throw on despite throwOnError:false in some
// bundles), inject a synthetic `.katex-error[title="..."]` span so
// the GUI's scanAndReportUndefMacros scanner can surface a warning
// pill for the user. Without this, the catch swallowed silently and
// the math just rendered as raw text with no error signal.
function md4xFailMath(el, src, e) {
  el.textContent = '';
  var span = document.createElement('span');
  span.className = 'katex-error';
  var msg = (e && e.message) ? e.message : String(e || 'KaTeX error');
  span.setAttribute('title', msg);
  span.textContent = src;
  el.appendChild(span);
}
document.querySelectorAll('span[data-math-style="inline"]').forEach(function(el){
  var src = el.dataset.mathSrc || el.textContent;
  try { katex.render(window.md4xSanitizeMath(src), el, md4xKatexOpts(false)); }
  catch(e){ md4xFailMath(el, src, e); }
});
document.querySelectorAll('span[data-math-style="display"]').forEach(function(el){
  var src = el.dataset.mathSrc || el.textContent;
  try { katex.render(window.md4xSanitizeMath(src), el, md4xKatexOpts(true)); }
  catch(e){ md4xFailMath(el, src, e); }
});
"#;

pub struct KatexPlugin;

impl Plugin for KatexPlugin {
    fn name(&self) -> &'static str {
        "katex"
    }

    fn preprocess_markdown(&self, md: &str) -> Option<String> {
        // Three passes:
        //   (1) `\[...\]` → single-line `$$...$$` (char-stream, handles inline
        //       openers/closers like `\[\begin{aligned}` ... `\end{aligned}\]*`)
        //   (2) `\(...\)` inline → `$...$`
        //   (3) collapse multi-line user-written `$$...$$` blocks to one line
        //       so comrak's inline-level math_dollars extension claims them.
        let s = rewrite_latex_brackets(md);
        let s = rewrite_inline_latex_delims(&s);
        Some(collapse_display_math_blocks(&s))
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
///
/// Fenced code blocks are skipped — `$$` inside ```` ``` ```` is left alone.
/// `\[ ... \]` LaTeX2e display math is handled by [`rewrite_latex_brackets`]
/// in an earlier pass.
pub fn collapse_display_math_blocks(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut in_code_fence = false;
    let mut in_math = false;
    let mut buf = String::new();

    for line in md.lines() {
        let trimmed_start = line.trim_start();

        if !in_math && (trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~")) {
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

    if in_math {
        out.push_str(&buf);
    }
    out
}

/// Rewrite display LaTeX2e math `\[ ... \]` → single-line `$$ ... $$`.
///
/// Char-stream parser. Tolerates content before/after the delimiters on the
/// same line (e.g. `\[\begin{aligned} ... \end{aligned}\]*` or
/// `\[ x = 1 \]`). Multi-line content is joined with spaces so the math
/// fits on one line for comrak's inline-level math_dollars extension.
///
/// Code-fence-aware: text inside ```` ``` ```` / `~~~` blocks is untouched.
/// Inside math, the `\]` closer is detected without escape checks (LaTeX
/// math has no `\\]` escape). Outside math, `\\[` (escaped backslash + `[`)
/// is left alone.
pub fn rewrite_latex_brackets(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut in_code_fence = false;
    let mut in_math = false;
    let mut math_buf = String::new();

    for line in md.lines() {
        // Code fence tracking only when not in a math block — math can't
        // span across a code fence in any sane document.
        if !in_math {
            let trimmed = line.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
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
        }

        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            let prev = if i == 0 { '\0' } else { chars[i - 1] };

            if in_math {
                if c == '\\' && next == Some(']') {
                    out.push_str("$$ ");
                    out.push_str(math_buf.trim());
                    out.push_str(" $$");
                    math_buf.clear();
                    in_math = false;
                    i += 2;
                    continue;
                }
                math_buf.push(c);
                i += 1;
                continue;
            }

            if c == '\\' && next == Some('[') && prev != '\\' {
                in_math = true;
                math_buf.clear();
                i += 2;
                continue;
            }

            out.push(c);
            i += 1;
        }

        if in_math {
            // Preserve newline as a space so multi-line math joins cleanly.
            math_buf.push(' ');
        } else {
            out.push('\n');
        }
    }

    if in_math {
        // Unclosed — restore the opener so content survives to the user.
        out.push_str("\\[");
        out.push_str(&math_buf);
    }

    out
}

/// Rewrite inline LaTeX2e math delimiters `\(...\)` → `$...$` so comrak's
/// math extension claims them. Code-fence-aware. Display `\[...\]` is
/// handled by [`rewrite_latex_brackets`].
pub fn rewrite_inline_latex_delims(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut in_code_fence = false;
    for line in md.lines() {
        let trimmed_start = line.trim_start();
        if trimmed_start.starts_with("```") {
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
        // Two-char delimiter swap; backslash-escaped variants `\\(` are
        // left alone by checking the preceding char. Char-iterated so
        // multi-byte UTF-8 stays intact.
        let chars: Vec<char> = line.chars().collect();
        let mut buf = String::with_capacity(line.len());
        let mut i = 0;
        while i < chars.len() {
            let prev = if i == 0 { '\0' } else { chars[i - 1] };
            if chars[i] == '\\' && i + 1 < chars.len() && prev != '\\' {
                let next = chars[i + 1];
                if next == '(' || next == ')' {
                    buf.push('$');
                    i += 2;
                    continue;
                }
            }
            buf.push(chars[i]);
            i += 1;
        }
        out.push_str(&buf);
        out.push('\n');
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
