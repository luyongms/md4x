//! Plugin architecture for md4x.
//!
//! The kernel (src/render.rs) holds a [`Registry`] of [`Plugin`]s. Each plugin
//! contributes one capability — a markdown-AST rewrite, a comrak syntax
//! highlighter, runtime assets, head HTML, init JS, or a cover-text rewrite —
//! and the kernel calls trait methods rather than importing plugin modules by
//! name. See `docs/spec/plugin-architecture.md` for the contract and pipeline.

use anyhow::Result;
use std::path::Path;

pub mod katex;
pub mod mermaid;
pub mod syntect;

/// Contract every md4x capability extension implements.
///
/// Methods other than [`Plugin::name`] all default to no-op so each plugin
/// only overrides what it actually contributes.
pub trait Plugin: Send + Sync {
    /// Stable, lowercase, hyphenated identifier (`"mermaid"`, `"katex"`, …).
    fn name(&self) -> &'static str;

    /// Pre-process the raw markdown source before comrak parses it. Returning
    /// `Some(s)` replaces the input; chained across plugins in registry order.
    /// Used by KaTeX to collapse multi-line `$$...$$` blocks (which would
    /// otherwise trigger CommonMark Setext-heading detection on a bare `=`
    /// line).
    fn preprocess_markdown(&self, _md: &str) -> Option<String> {
        None
    }

    /// Configure the markdown parser before parsing.
    fn configure_parse(&self, _opts: &mut comrak::ComrakOptions) {}

    /// In-place AST rewrite after parse.
    fn rewrite_ast<'a>(&self, _root: &'a comrak::nodes::AstNode<'a>) {}

    /// Provide a comrak code-fence syntax highlighter, if any.
    fn syntax_highlighter(&self) -> Option<&dyn comrak::adapters::SyntaxHighlighterAdapter> {
        None
    }

    /// Write the plugin's runtime assets into the per-render scratch dir.
    fn extract_assets(&self, _scratch: &Path) -> Result<()> {
        Ok(())
    }

    /// HTML to inject into `<head>`.
    fn head_html(&self) -> &str {
        ""
    }

    /// JavaScript appended to the `DOMContentLoaded` init block.
    fn init_js(&self) -> &str {
        ""
    }

    /// Optional rewrite for plain-text cover values (title/subtitle).
    /// Returning `Some(html)` short-circuits the kernel's html-escape fallback.
    fn rewrite_cover_text(&self, _text: &str) -> Option<String> {
        None
    }
}

/// Ordered list of plugins driving a render.
pub struct Registry {
    plugins: Vec<Box<dyn Plugin>>,
}

impl Registry {
    pub fn new(plugins: Vec<Box<dyn Plugin>>) -> Self {
        Self { plugins }
    }

    pub fn plugins(&self) -> &[Box<dyn Plugin>] {
        &self.plugins
    }

    pub fn preprocess_markdown(&self, md: &str) -> String {
        let mut current = md.to_string();
        for p in &self.plugins {
            if let Some(next) = p.preprocess_markdown(&current) {
                current = next;
            }
        }
        current
    }

    pub fn configure_parse(&self, opts: &mut comrak::ComrakOptions) {
        for p in &self.plugins {
            p.configure_parse(opts);
        }
    }

    pub fn rewrite_ast<'a>(&self, root: &'a comrak::nodes::AstNode<'a>) {
        for p in &self.plugins {
            p.rewrite_ast(root);
        }
    }

    /// First plugin to provide a highlighter wins.
    pub fn syntax_highlighter(&self) -> Option<&dyn comrak::adapters::SyntaxHighlighterAdapter> {
        self.plugins.iter().find_map(|p| p.syntax_highlighter())
    }

    pub fn extract_assets(&self, scratch: &Path) -> Result<()> {
        for p in &self.plugins {
            p.extract_assets(scratch)?;
        }
        Ok(())
    }

    /// Concatenate each plugin's head HTML in registry order.
    pub fn head_html(&self) -> String {
        let mut out = String::new();
        for p in &self.plugins {
            let h = p.head_html();
            if !h.is_empty() {
                out.push_str(h);
                if !h.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
        out
    }

    /// Concatenate each plugin's init JS in registry order.
    pub fn init_js(&self) -> String {
        let mut out = String::new();
        for p in &self.plugins {
            let js = p.init_js();
            if !js.is_empty() {
                out.push_str(js);
                if !js.ends_with(';') && !js.ends_with('\n') {
                    out.push(';');
                }
                out.push('\n');
            }
        }
        out
    }

    /// First plugin to claim the text wins; otherwise html-escape the input.
    pub fn rewrite_cover_text(&self, text: &str) -> String {
        for p in &self.plugins {
            if let Some(out) = p.rewrite_cover_text(text) {
                return out;
            }
        }
        html_escape(text)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new(vec![
            Box::new(mermaid::MermaidPlugin),
            Box::new(katex::KatexPlugin),
            Box::new(syntect::SyntectPlugin::new()),
        ])
    }
}

/// HTML-escape `s` (`&`, `<`, `>`, `"`, `'`).
pub fn html_escape(s: &str) -> String {
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

/// Test helpers — used by integration tests in `tests/*_plugin.rs`.
pub mod testing {
    use super::*;

    /// Run `md` through comrak with a single plugin's hooks engaged. Used to
    /// drive plugin AST/highlighter behavior from tests in isolation.
    pub fn format_with_plugin<P: Plugin>(plugin: &P, md: &str) -> String {
        let mut opts = comrak::ComrakOptions::default();
        opts.extension.table = true;
        opts.extension.footnotes = true;
        opts.extension.strikethrough = true;
        opts.extension.tasklist = true;
        opts.extension.autolink = true;
        opts.extension.superscript = true;
        opts.render.unsafe_ = true;
        plugin.configure_parse(&mut opts);

        let arena = comrak::Arena::new();
        let root = comrak::parse_document(&arena, md, &opts);
        plugin.rewrite_ast(root);

        let mut comrak_plugins = comrak::Plugins::default();
        comrak_plugins.render.codefence_syntax_highlighter = plugin.syntax_highlighter();

        let mut buf = Vec::new();
        comrak::format_html_with_plugins(root, &opts, &mut buf, &comrak_plugins).unwrap();
        String::from_utf8(buf).unwrap()
    }
}
