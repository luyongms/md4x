//! scratch/sync-probe harness — Comrak side.
//!
//! Reads a markdown file from argv[1], runs the FULL preprocessor chain
//! (admonish → numthm → mermaid → macros → katex), parses with comrak,
//! and emits one JSON line per top-level block to stdout:
//!
//!     [{"i":0,"kind":"heading","sourcepos":"1:1-1:7","text":"Title"}, …]
//!
//! Sourcepos is in POST-preprocessor coordinates (what the preview HTML
//! sees). Plain text is the inline-walk of the block, math/code literals
//! preserved.

use comrak::nodes::{AstNode, NodeValue};
use md4x_core::plugins::Registry;
use std::env;
use std::fs;

fn main() {
    let path = env::args().nth(1).expect("usage: block_probe <md>");
    let raw = fs::read_to_string(&path).expect("read md");
    let md = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).to_string();

    let registry = Registry::default();
    let preprocessed = registry.preprocess_markdown(&md);

    let mut opts = comrak::ComrakOptions::default();
    opts.extension.table = true;
    opts.extension.footnotes = true;
    opts.extension.strikethrough = true;
    opts.extension.tasklist = true;
    opts.extension.autolink = true;
    opts.extension.superscript = true;
    opts.render.unsafe_ = true;
    opts.render.sourcepos = true;
    registry.configure_parse(&mut opts);

    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, &preprocessed, &opts);
    registry.rewrite_ast(root);

    let mut blocks: Vec<String> = Vec::new();
    for (i, child) in root.children().enumerate() {
        let data = child.data.borrow();
        let kind = node_kind(&data.value);
        let sp = format!(
            "{}:{}-{}:{}",
            data.sourcepos.start.line,
            data.sourcepos.start.column,
            data.sourcepos.end.line,
            data.sourcepos.end.column
        );
        // Capture the block's own literal for self-contained leaf nodes
        // (HtmlBlock, CodeBlock, Math) so we can recognize admonish wrappers
        // and code-fence content downstream. walk_text only descends into
        // CHILDREN, which leaves these nodes' content empty otherwise.
        let mut text = String::new();
        match &data.value {
            NodeValue::HtmlBlock(h) => text.push_str(&h.literal),
            NodeValue::CodeBlock(c) => text.push_str(&c.literal),
            NodeValue::Math(m) => text.push_str(&m.literal),
            _ => {}
        }
        drop(data);
        walk_text(child, &mut text);
        let text = text.trim().to_string();
        blocks.push(format!(
            r#"{{"i":{i},"kind":"{kind}","sourcepos":"{sp}","text":{}}}"#,
            json_string(&text)
        ));
    }
    println!("[{}]", blocks.join(","));
}

fn node_kind(v: &NodeValue) -> &'static str {
    match v {
        NodeValue::Document => "document",
        NodeValue::Heading(_) => "heading",
        NodeValue::Paragraph => "paragraph",
        NodeValue::CodeBlock(_) => "code",
        NodeValue::HtmlBlock(_) => "html",
        NodeValue::List(_) => "list",
        NodeValue::BlockQuote => "blockquote",
        NodeValue::ThematicBreak => "hr",
        NodeValue::Table(_) => "table",
        NodeValue::FootnoteDefinition(_) => "footnote",
        NodeValue::DescriptionList => "deflist",
        NodeValue::MultilineBlockQuote(_) => "blockquote",
        NodeValue::Math(_) => "math",
        NodeValue::Item(_) => "item",
        _ => "other",
    }
}

fn walk_text<'a>(node: &'a AstNode<'a>, out: &mut String) {
    for child in node.children() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::Text(s) => out.push_str(s),
            NodeValue::Code(c) => out.push_str(&c.literal),
            NodeValue::Math(m) => out.push_str(&m.literal),
            NodeValue::CodeBlock(c) => out.push_str(&c.literal),
            NodeValue::HtmlBlock(h) => out.push_str(&h.literal),
            NodeValue::HtmlInline(s) => out.push_str(s),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            _ => {
                drop(data);
                walk_text(child, out);
            }
        }
    }
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
