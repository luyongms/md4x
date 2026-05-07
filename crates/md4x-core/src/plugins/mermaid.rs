//! MermaidPlugin: rewrites ```` ```mermaid ```` fences into `<pre class="mermaid">`
//! and contributes the bundled `mermaid.min.js` plus the init script that
//! `mermaid.initialize` runs against on page load.

use anyhow::{Context, Result};
use comrak::nodes::{AstNode, NodeHtmlBlock, NodeValue};
use std::fs;
use std::path::Path;

use super::{html_escape, Plugin};

static MERMAID_JS: &[u8] = include_bytes!("../../mermaid.min.js");

pub fn mermaid_js() -> &'static [u8] { MERMAID_JS }

const HEAD_HTML: &str = "<script src=\"mermaid.min.js\"></script>\n";

// Two interlocking issues — both must be addressed:
//
// 1. `startOnLoad:false` + explicit `mermaid.run()`. Mermaid auto-attaches a
//    `window.load` listener when its script loads. Our config call inside a
//    DOMContentLoaded handler races with that auto-init — when mermaid wins
//    (often on WKWebView), the auto-render uses default config and our later
//    `initialize()` call can't undo it. Disabling `startOnLoad` removes the
//    race; calling `run()` explicitly gives us deterministic config-then-render.
//
// 2. `htmlLabels:false`. WKWebView has long-standing foreignObject HTML
//    rendering bugs (WebKit #23113, #165516) — mermaid v11's stateDiagram-v2
//    renders labels via `<foreignObject><div>` by default, and WKWebView
//    misrenders the font-size cascade producing 2x oversized text. Chrome
//    (the CLI/PDF path) handles foreignObject correctly, hence the divergence.
//    Forcing native SVG `<text>` sidesteps the WebKit-only path. See
//    mermaid-js/mermaid#7565 for the same workaround in another embedded
//    webview environment (JCEF/IntelliJ).
// Two interlocking config flags, both required for correct WKWebView render:
//
// 1. `htmlLabels:false` — render labels with native SVG `<text>` instead of
//    `<foreignObject><div>`. WKWebView has long-standing foreignObject quirks
//    (WebKit #23113); forcing SVG text removes the engine-divergent path.
//
// 2. Per-diagram `useMaxWidth:false` — mermaid's default is to set
//    `width="100%"` on the rendered SVG. When the SVG's natural viewBox is
//    smaller than its container (typical for stateDiagram-v2: ~370px in our
//    ~620px content area), the SVG scales UP to fill, dragging text along
//    by the same factor (e.g. 16px → ~27px visually). Setting useMaxWidth
//    false makes mermaid emit explicit pixel widths so SVGs render at
//    natural size. Headless Chrome (CLI/PDF path) doesn't show the bug
//    because print layout uses different sizing rules.
//
// `startOnLoad:false` + explicit `mermaid.run()` removes the race between
// mermaid's window-load auto-init and our DOMContentLoaded handler — the
// config above must be applied before any rendering happens.
const INIT_JS: &str = "\
    mermaid.initialize({\
        startOnLoad:false,\
        htmlLabels:false,\
        flowchart:{useMaxWidth:false},\
        sequence:{useMaxWidth:false},\
        state:{useMaxWidth:false},\
        class:{useMaxWidth:false},\
        er:{useMaxWidth:false},\
        gantt:{useMaxWidth:false},\
        journey:{useMaxWidth:false}\
    });\
    mermaid.run();\
";

pub struct MermaidPlugin;

impl Plugin for MermaidPlugin {
    fn name(&self) -> &'static str {
        "mermaid"
    }

    fn rewrite_ast<'a>(&self, root: &'a AstNode<'a>) {
        rewrite(root);
    }

    fn extract_assets(&self, scratch: &Path) -> Result<()> {
        fs::write(scratch.join("mermaid.min.js"), MERMAID_JS)
            .with_context(|| format!("writing mermaid.min.js to {}", scratch.display()))
    }

    fn head_html(&self) -> &str {
        HEAD_HTML
    }

    fn init_js(&self) -> &str {
        INIT_JS
    }
}

fn rewrite<'a>(node: &'a AstNode<'a>) {
    for child in node.children() {
        let mut data = child.data.borrow_mut();
        let mermaid_src = match &data.value {
            NodeValue::CodeBlock(cb) if cb.info.trim().eq_ignore_ascii_case("mermaid") => {
                Some(cb.literal.clone())
            }
            _ => None,
        };
        if let Some(src) = mermaid_src {
            let hash = super::block_hash(&src);
            // Preserve the AST node's source position on the rewritten HTML
            // so the GUI's block-level scroll sync (which keys off
            // data-sourcepos) finds this block at its correct source line.
            let sp = data.sourcepos;
            let pos = format!(
                "{}:{}-{}:{}",
                sp.start.line, sp.start.column, sp.end.line, sp.end.column
            );
            let html = format!(
                "<pre class=\"mermaid\" data-md4x-hash=\"{hash}\" data-sourcepos=\"{pos}\">{}</pre>",
                html_escape(&src)
            );
            data.value = NodeValue::HtmlBlock(NodeHtmlBlock { block_type: 0, literal: html });
            continue;
        }
        drop(data);
        rewrite(child);
    }
}
