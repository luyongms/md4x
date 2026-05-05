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

const INIT_JS: &str = "mermaid.initialize({startOnLoad:true});";

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
            let html = format!("<pre class=\"mermaid\" data-md4x-hash=\"{hash}\">{}</pre>", html_escape(&src));
            data.value = NodeValue::HtmlBlock(NodeHtmlBlock { block_type: 0, literal: html });
            continue;
        }
        drop(data);
        rewrite(child);
    }
}
