//! NumthmPlugin: numbered theorem-environment counters and references,
//! mirroring the `mdbook-numthm` preprocessor surface.
//!
//! Recognized syntax (preprocessed before comrak parses):
//!   `{{TYPE}}`                          counter only
//!   `{{TYPE}}{LABEL}`                   counter + anchor
//!   `{{TYPE}}[CAPTION]`                 counter + caption
//!   `{{TYPE}}{LABEL}[CAPTION]`          counter + anchor + caption
//!   `{{ref: LABEL}}`                    cross-reference
//!   `{{tref: LABEL}}`                   "the <noun> N" cross-reference
//!
//! TYPE is one of: prop, thm, lem, cor, def, rem, exa, conj, axiom,
//!   notation, fact, claim. Numbers are sequential per TYPE within a
//!   document (no chapter detection).
//!
//! Forward refs work via a placeholder pass: each `{{ref}}/{{tref}}` is
//! emitted as a sentinel string; after the document is fully scanned we
//! resolve sentinels against the labels map.

use super::Plugin;
use std::collections::HashMap;

pub struct NumthmPlugin;

impl Plugin for NumthmPlugin {
    fn name(&self) -> &'static str {
        "numthm"
    }
    fn preprocess_markdown(&self, md: &str) -> Option<String> {
        Some(numthm_preprocess(md))
    }
}

const TYPE_TABLE: &[(&str, &str)] = &[
    ("prop", "Proposition"),
    ("thm", "Theorem"),
    ("lem", "Lemma"),
    ("cor", "Corollary"),
    ("def", "Definition"),
    ("rem", "Remark"),
    ("exa", "Example"),
    ("conj", "Conjecture"),
    ("axiom", "Axiom"),
    ("notation", "Notation"),
    ("fact", "Fact"),
    ("claim", "Claim"),
];

fn pretty_for(type_name: &str) -> Option<&'static str> {
    TYPE_TABLE
        .iter()
        .find(|(t, _)| *t == type_name)
        .map(|(_, p)| *p)
}

/// Sentinel: ASCII SOH bytes wrap the index. Won't collide with markdown.
fn sentinel(idx: usize) -> String {
    format!("\u{0001}NUMTHM_REF_{idx}\u{0001}")
}

pub fn numthm_preprocess(md: &str) -> String {
    let mut counters: HashMap<String, u32> = HashMap::new();
    let mut labels: HashMap<String, String> = HashMap::new();
    let mut pending: Vec<(String, bool)> = vec![]; // (label, the-prefix?)
    let mut out = String::with_capacity(md.len());
    let mut in_code = false;

    for line in md.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_code {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        process_line(line, &mut out, &mut counters, &mut labels, &mut pending);
        out.push('\n');
    }

    // Resolve sentinels.
    for (idx, (label, the_prefix)) in pending.iter().enumerate() {
        let placeholder = sentinel(idx);
        let resolved = if let Some(display) = labels.get(label) {
            if *the_prefix {
                let lowered = lower_first_word(display);
                format!("[the {}](#{})", lowered, percent_encode_anchor(label))
            } else {
                format!("[{}](#{})", display, percent_encode_anchor(label))
            }
        } else {
            // Unresolved: render the label itself, no link.
            format!("`{}`", label)
        };
        out = out.replace(&placeholder, &resolved);
    }

    out
}

fn lower_first_word(s: &str) -> String {
    let mut parts = s.splitn(2, ' ');
    let first = parts.next().unwrap_or("").to_lowercase();
    match parts.next() {
        Some(rest) if !rest.is_empty() => format!("{first} {rest}"),
        _ => first,
    }
}

/// Anchor IDs that contain `:`, spaces, etc. need percent-encoding for the
/// `href`. We keep the raw label as the `id=` attribute so `:` survives.
fn percent_encode_anchor(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | ':' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                let bytes = c.encode_utf8(&mut buf).as_bytes();
                for b in bytes {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

fn process_line(
    line: &str,
    out: &mut String,
    counters: &mut HashMap<String, u32>,
    labels: &mut HashMap<String, String>,
    pending: &mut Vec<(String, bool)>,
) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 2 <= bytes.len() && &bytes[i..i + 2] == b"{{" {
            if let Some(close) = find_double_close(bytes, i + 2) {
                let inner = &line[i + 2..close];
                let inner_trim = inner.trim();

                if let Some(label) = inner_trim.strip_prefix("ref:") {
                    pending.push((label.trim().to_string(), false));
                    out.push_str(&sentinel(pending.len() - 1));
                    i = close + 2;
                    continue;
                }
                if let Some(label) = inner_trim.strip_prefix("tref:") {
                    pending.push((label.trim().to_string(), true));
                    out.push_str(&sentinel(pending.len() - 1));
                    i = close + 2;
                    continue;
                }
                if let Some(pretty) = pretty_for(inner_trim) {
                    let key = inner_trim.to_string();
                    let n = counters.get(&key).copied().unwrap_or(0) + 1;
                    counters.insert(key, n);

                    let mut after = close + 2;
                    let mut label_str: Option<String> = None;
                    if after < bytes.len() && bytes[after] == b'{' {
                        if let Some(le) = find_close_brace(bytes, after + 1) {
                            label_str = Some(line[after + 1..le].to_string());
                            after = le + 1;
                        }
                    }
                    let mut caption_str: Option<String> = None;
                    if after < bytes.len() && bytes[after] == b'[' {
                        if let Some(ce) = find_close_bracket(bytes, after + 1) {
                            caption_str = Some(line[after + 1..ce].to_string());
                            after = ce + 1;
                        }
                    }

                    let display = format!("{pretty} {n}");
                    if let Some(ref lbl) = label_str {
                        labels.insert(lbl.clone(), display.clone());
                        out.push_str(&format!("<a id=\"{}\"></a>", lbl));
                    }
                    out.push_str(&format!("**{}**", display));
                    if let Some(ref cap) = caption_str {
                        out.push_str(&format!(" *({})*", cap));
                    }
                    i = after;
                    continue;
                }

                // Unknown {{...}} — pass through verbatim.
                out.push_str(&line[i..close + 2]);
                i = close + 2;
                continue;
            }
        }
        let ch = line[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
}

fn find_double_close(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < bytes.len() {
        if &bytes[i..i + 2] == b"}}" {
            return Some(i);
        }
        if bytes[i] == b'\n' {
            return None;
        }
        i += 1;
    }
    None
}

fn find_close_brace(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'}' {
            return Some(i);
        }
        if bytes[i] == b'\n' {
            return None;
        }
        i += 1;
    }
    None
}

fn find_close_bracket(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b']' {
            return Some(i);
        }
        if bytes[i] == b'\n' {
            return None;
        }
        i += 1;
    }
    None
}
