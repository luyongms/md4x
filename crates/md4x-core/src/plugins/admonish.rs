//! AdmonishPlugin: mdbook-admonish-style callout boxes.
//!
//! Recognized syntax (preprocessed before comrak parses):
//!
//! ```text
//! ```admonish KIND [args]
//! body markdown
//! ```
//! ```
//!
//! KIND is one of: note, info, tip, warning, danger, example, success,
//! question, quote, abstract, proof, jump, remark. Anything else
//! falls back to `note` styling with the kind capitalized as the title.
//!
//! `collapsible=true` in args wraps the box in `<details>` so the body
//! is hidden until the user clicks the title.
//!
//! Body is left as markdown — comrak processes it because the surrounding
//! `<div>`/`<details>` HTML block is broken by blank lines around the
//! content (CommonMark spec).

use super::Plugin;

const HEAD_HTML: &str = "\
<style>\n\
.admonish { margin: 1em 0; border-left: 4px solid #888; background: rgba(0,0,0,0.04); border-radius: 4px; padding: 12px 16px 12px 14px; overflow: hidden; }\n\
.admonish > .admonish-title { font-weight: 600; font-size: 0.95em; margin-bottom: 0.4em; color: #555; letter-spacing: 0.01em; }\n\
.admonish > .admonish-body > :first-child { margin-top: 0; }\n\
.admonish > .admonish-body > :last-child { margin-bottom: 0; }\n\
details.admonish > summary.admonish-title { cursor: pointer; list-style: none; }\n\
details.admonish > summary.admonish-title::-webkit-details-marker { display: none; }\n\
details.admonish > summary.admonish-title::before { content: '\\25B8'; display: inline-block; margin-right: 0.4em; transition: transform 140ms ease; color: #999; }\n\
details.admonish[open] > summary.admonish-title::before { transform: rotate(90deg); }\n\
.admonish-note     { border-left-color: #6c7280; }\n\
.admonish-info     { border-left-color: #0ea5e9; }\n\
.admonish-tip      { border-left-color: #10b981; }\n\
.admonish-warning  { border-left-color: #f59e0b; background: rgba(245,158,11,0.06); }\n\
.admonish-danger   { border-left-color: #ef4444; background: rgba(239,68,68,0.06); }\n\
.admonish-example  { border-left-color: #06b6d4; background: rgba(6,182,212,0.05); }\n\
.admonish-success  { border-left-color: #22c55e; }\n\
.admonish-question { border-left-color: #a855f7; }\n\
.admonish-quote    { border-left-color: #94a3b8; font-style: italic; }\n\
.admonish-abstract { border-left-color: #3b82f6; }\n\
.admonish-proof    { border-left-color: #5e5ce6; background: rgba(94,92,230,0.04); }\n\
.admonish-jump     { border-left-color: #2ea043; background: rgba(46,160,67,0.05); }\n\
.admonish-remark   { border-left-color: #d97706; background: rgba(217,119,6,0.05); }\n\
</style>";

pub struct AdmonishPlugin;

impl Plugin for AdmonishPlugin {
    fn name(&self) -> &'static str {
        "admonish"
    }
    fn preprocess_markdown(&self, md: &str) -> Option<String> {
        Some(admonish_preprocess(md))
    }
    fn head_html(&self) -> &str {
        HEAD_HTML
    }
}

fn title_for(kind: &str) -> String {
    match kind {
        "note" => "Note",
        "info" => "Info",
        "tip" => "Tip",
        "warning" | "warn" => "Warning",
        "danger" | "error" | "fail" | "failure" => "Danger",
        "example" => "Example",
        "success" | "check" | "done" => "Success",
        "question" | "help" | "faq" => "Question",
        "quote" | "cite" => "Quote",
        "abstract" | "summary" | "tldr" => "Abstract",
        "proof" => "Proof",
        "jump" => "See also",
        "remark" => "Remark",
        _ => return cap_first(kind),
    }
    .to_string()
}

fn cap_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => "Note".into(),
    }
}

pub fn admonish_preprocess(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let mut out = String::with_capacity(md.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();

        // Match `\`\`\`admonish ARGS`, `\`\`\` admonish ARGS`, and ~~~ variants.
        // mdbook authors use both styles.
        let after_fence = trimmed
            .strip_prefix("```")
            .or_else(|| trimmed.strip_prefix("~~~"));
        let admonish_args: Option<&str> =
            after_fence.and_then(|r| r.trim_start().strip_prefix("admonish"));

        if let Some(rest) = admonish_args {
            // Find matching closing fence (line that's just ``` or ~~~).
            let mut j = i + 1;
            while j < lines.len() {
                let t = lines[j].trim();
                if t == "```" || t == "~~~" {
                    break;
                }
                j += 1;
            }
            if j >= lines.len() {
                out.push_str(line);
                out.push('\n');
                i += 1;
                continue;
            }

            let args = rest.trim();
            let mut tokens = args.split_whitespace();
            let kind = tokens
                .next()
                .map(|s| s.to_lowercase())
                .unwrap_or_else(|| "note".into());
            let collapsible = args.contains("collapsible=true");
            // Optional explicit title="..." would override; mdbook-admonish
            // syntax allows title="My Title". We support a barebones form.
            let custom_title = extract_title_arg(args);
            let title = custom_title.unwrap_or_else(|| title_for(&kind));

            let body: &[&str] = &lines[i + 1..j];

            let (open_tag, close_tag, title_tag) = if collapsible {
                (
                    format!("<details class=\"admonish admonish-{kind}\">"),
                    "</details>".to_string(),
                    "summary",
                )
            } else {
                (
                    format!("<div class=\"admonish admonish-{kind}\">"),
                    "</div>".to_string(),
                    "div",
                )
            };

            out.push_str(&open_tag);
            out.push('\n');
            out.push_str(&format!(
                "<{title_tag} class=\"admonish-title\">{}</{title_tag}>\n",
                html_escape_text(&title)
            ));
            out.push_str("<div class=\"admonish-body\">\n\n");
            for bl in body {
                out.push_str(bl);
                out.push('\n');
            }
            out.push_str("\n</div>\n");
            out.push_str(&close_tag);
            out.push('\n');
            i = j + 1;
            continue;
        }
        out.push_str(line);
        out.push('\n');
        i += 1;
    }
    out
}

fn extract_title_arg(args: &str) -> Option<String> {
    // Match `title="..."`. Hand-rolled.
    let bytes = args.as_bytes();
    let needle = b"title=\"";
    if bytes.len() < needle.len() {
        return None;
    }
    for i in 0..=bytes.len() - needle.len() {
        if &bytes[i..i + needle.len()] == needle {
            let start = i + needle.len();
            let mut j = start;
            while j < bytes.len() && bytes[j] != b'"' {
                j += 1;
            }
            if j > start {
                return Some(args[start..j].to_string());
            }
        }
    }
    None
}

fn html_escape_text(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}
