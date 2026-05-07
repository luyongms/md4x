//! MacrosPlugin: per-document KaTeX macro overrides.
//!
//! Two sources, merged with **inline-wins-on-conflict**:
//!
//! 1. **Inline block** — an HTML comment at end-of-file:
//!    ```text
//!    <!-- md4x:macros
//!    {
//!      "\\R": "\\mathbb{R}"
//!    }
//!    -->
//!    ```
//!    Stripped from the markdown source by `preprocess_markdown` so it
//!    never reaches the renderer.
//!
//! 2. **Sidecar JSON** — `<source>.macros.json` (or
//!    `<source.md>.macros.json`) next to the markdown file. Same JSON
//!    format. Picked up via `head_html_for(source_path)`.
//!
//! Merged map is injected as
//! `<script>window.MD4X_USER_MACROS = {...};</script>` BEFORE the
//! KaTeX plugin's INIT_JS.
//!
//! Lives in the plugin layer (NOT the kernel). Per the project's kernel
//! discipline (see `docs/spec/plugin-architecture.md`), all parsing,
//! merging, and IO is contained in this file.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::Plugin;

const SENTINEL_OPEN:  &str = "<!-- md4x:macros";
const SENTINEL_CLOSE: &str = "-->";

pub struct MacrosPlugin {
    /// JSON body extracted by the most recent `preprocess_markdown` call,
    /// consumed by the next `head_html_for`. Plugin instances are reused
    /// across renders; the cache is overwritten each time.
    last_inline: Mutex<Option<String>>,
}

impl MacrosPlugin {
    pub fn new() -> Self {
        Self { last_inline: Mutex::new(None) }
    }
}

impl Default for MacrosPlugin {
    fn default() -> Self { Self::new() }
}

impl Plugin for MacrosPlugin {
    fn name(&self) -> &'static str { "macros" }

    fn preprocess_markdown(&self, md: &str) -> Option<String> {
        let (stripped, inline_json) = extract_inline_macros(md);
        *self.last_inline.lock().unwrap() = inline_json;
        if stripped.len() == md.len() && stripped == md { None } else { Some(stripped) }
    }

    fn head_html_for(&self, source_path: Option<&Path>) -> String {
        let inline  = self.last_inline.lock().unwrap().clone();
        let sidecar = load_user_macros(source_path);
        let merged  = merge_macros(inline.as_deref(), sidecar.as_deref());
        if merged.is_empty() {
            String::new()
        } else {
            format!("<script>window.MD4X_USER_MACROS = {};</script>\n", merged)
        }
    }
}

// ── Sidecar I/O ────────────────────────────────────────────────────────────

/// Read `<stem>.macros.json` (then `<full-name>.macros.json` as fallback)
/// next to `source`. Returns the file contents (must start with `{` to
/// be considered a JSON object) or `None` on miss / invalid file.
pub fn load_user_macros(source: Option<&Path>) -> Option<String> {
    let p = source?;
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let candidates = [
        parent.join(format!("{stem}.macros.json")),
        parent.join(format!("{file_name}.macros.json")),
    ];
    for cand in &candidates {
        if cand.is_file() {
            if let Ok(s) = fs::read_to_string(cand) {
                if s.trim_start().starts_with('{') {
                    return Some(s);
                }
            }
        }
    }
    None
}

/// Canonical sidecar path for a given source file.
pub fn macros_path_for(source: &Path) -> PathBuf {
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    parent.join(format!("{stem}.macros.json"))
}

// ── Inline-block extraction ────────────────────────────────────────────────

/// Parse the markdown source. If it ends with a well-formed inline
/// macros block (`<!-- md4x:macros\n…\n-->\n?`), return the markdown
/// **with the block removed** plus the JSON body. Otherwise return the
/// input unchanged and `None`.
///
/// Validation:
/// - `SENTINEL_OPEN` must start at column 0.
/// - `SENTINEL_CLOSE` (`-->`) must start at column 0 of a later line.
/// - Body must parse as a JSON object.
/// - Block must be the last non-blank content in the file.
///
/// On any validation failure we leave the markdown alone (treating
/// the comment as ordinary HTML passthrough).
pub fn extract_inline_macros(md: &str) -> (String, Option<String>) {
    let bytes = md.as_bytes();

    // Walk lines to find the LAST `<!-- md4x:macros` at column 0.
    let mut open_byte: Option<usize> = None;
    let mut close_byte_end: Option<usize> = None;
    let mut i: usize = 0;
    while i < bytes.len() {
        let line_start = i;
        // Find newline.
        let mut j = i;
        while j < bytes.len() && bytes[j] != b'\n' { j += 1; }
        let line = &md[line_start..j];
        if line == SENTINEL_OPEN {
            open_byte = Some(line_start);
            close_byte_end = None;
        } else if open_byte.is_some() && line == SENTINEL_CLOSE {
            // Inclusive of the trailing newline if present.
            close_byte_end = Some(if j < bytes.len() { j + 1 } else { j });
        }
        i = j + 1;
    }

    let (open_byte, close_byte_end) = match (open_byte, close_byte_end) {
        (Some(o), Some(c)) if c > o => (o, c),
        _ => return (md.to_string(), None),
    };

    // EOF gate: only trailing whitespace (incl. blank lines) allowed.
    let tail = &md[close_byte_end..];
    if !tail.chars().all(|c| c.is_whitespace()) {
        return (md.to_string(), None);
    }

    // Body = lines strictly between SENTINEL_OPEN line and SENTINEL_CLOSE line.
    let after_open = open_byte + SENTINEL_OPEN.len();
    let after_open = if after_open < bytes.len() && bytes[after_open] == b'\n' {
        after_open + 1
    } else {
        return (md.to_string(), None);
    };
    // Find the start of SENTINEL_CLOSE line.
    let close_line_start = md[..close_byte_end]
        .rfind(SENTINEL_CLOSE)
        .expect("we just located it");
    let body = &md[after_open..close_line_start];

    // Must parse as a JSON object.
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (md.to_string(), None),
    };
    if !parsed.is_object() {
        return (md.to_string(), None);
    }

    // Strip the block. Preserve a single trailing newline before the block
    // if one existed; collapse extra blanks.
    let mut head = md[..open_byte].to_string();
    while head.ends_with("\n\n") { head.pop(); }
    if !head.is_empty() && !head.ends_with('\n') { head.push('\n'); }

    (head, Some(body.to_string()))
}

/// Build an inline block from a JSON map (string→string). Pretty-printed
/// with 2-space indent and lexicographically sorted keys for diffability.
pub fn build_inline_block(json: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("invalid JSON: {e}"))?;
    let map = match v {
        serde_json::Value::Object(m) => m,
        _ => return Err("macros JSON must be an object".to_string()),
    };
    let sorted: BTreeMap<String, serde_json::Value> = map.into_iter().collect();

    let mut s = String::new();
    s.push_str(SENTINEL_OPEN);
    s.push('\n');
    s.push_str(&pretty_format(&sorted));
    s.push('\n');
    s.push_str(SENTINEL_CLOSE);
    s.push('\n');
    Ok(s)
}

fn pretty_format(map: &BTreeMap<String, serde_json::Value>) -> String {
    let mut s = String::from("{");
    if map.is_empty() { s.push('}'); return s; }
    s.push('\n');
    let n = map.len();
    for (i, (k, v)) in map.iter().enumerate() {
        s.push_str("  ");
        s.push_str(&serde_json::to_string(k).unwrap_or_else(|_| "\"\"".into()));
        s.push_str(": ");
        s.push_str(&serde_json::to_string(v).unwrap_or_else(|_| "null".into()));
        if i + 1 < n { s.push(','); }
        s.push('\n');
    }
    s.push('}');
    s
}

// ── Merge ──────────────────────────────────────────────────────────────────

/// Merge the inline body and sidecar body. Inline keys win on conflict.
/// Returns a serialised JSON object string (compact, single-line) or
/// the empty string when both inputs are missing/empty.
pub fn merge_macros(inline: Option<&str>, sidecar: Option<&str>) -> String {
    let mut merged: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    if let Some(s) = sidecar {
        if let Some(obj) = parse_object(s) {
            for (k, v) in obj { merged.insert(k, v); }
        }
    }
    if let Some(s) = inline {
        if let Some(obj) = parse_object(s) {
            for (k, v) in obj { merged.insert(k, v); }   // inline wins
        }
    }
    if merged.is_empty() {
        return String::new();
    }
    let value = serde_json::Value::Object(merged.into_iter().collect());
    serde_json::to_string(&value).unwrap_or_default()
}

fn parse_object(s: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    match v {
        serde_json::Value::Object(m) => Some(m),
        _ => None,
    }
}

// ── Lint ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LintReport {
    pub overlapping_keys: Vec<String>,
    pub conflicts: Vec<(String, String, String)>, // (key, inline, sidecar)
}

pub fn lint(inline: Option<&str>, sidecar: Option<&str>) -> LintReport {
    let mut overlapping_keys = Vec::new();
    let mut conflicts = Vec::new();
    let inline_obj  = inline.and_then(parse_object).unwrap_or_default();
    let sidecar_obj = sidecar.and_then(parse_object).unwrap_or_default();
    for (k, iv) in &inline_obj {
        if let Some(sv) = sidecar_obj.get(k) {
            overlapping_keys.push(k.clone());
            if iv != sv {
                conflicts.push((k.clone(), iv.to_string(), sv.to_string()));
            }
        }
    }
    overlapping_keys.sort();
    conflicts.sort();
    LintReport { overlapping_keys, conflicts }
}

// ── Inline / split file ops ────────────────────────────────────────────────

/// Read `path`, append (or replace) an inline macros block.
///
/// Merge policy when both sources of truth exist:
///   - Existing inline block (in the markdown, if any)
///   - Sidecar `<path>.macros.json` (if present)
/// Inline keys win on conflict, matching the render-time precedence.
/// New sidecar keys are added; existing inline keys not in the sidecar
/// are preserved. Bails if neither source exists.
///
/// Returns the new file contents. Caller writes.
pub fn inline_into_source(path: &Path) -> anyhow::Result<String> {
    let md = fs::read_to_string(path)?;
    let (stripped, existing_inline) = extract_inline_macros(&md);
    let sidecar = load_user_macros(Some(path));

    if existing_inline.is_none() && sidecar.is_none() {
        anyhow::bail!(
            "no macros to inline — no sidecar .macros.json next to {} and no existing inline block",
            path.display()
        );
    }

    // merge_macros emits a single-line compact JSON with sorted keys.
    // build_inline_block then re-parses + pretty-prints with 2-space
    // indent for diffability.
    let merged = merge_macros(existing_inline.as_deref(), sidecar.as_deref());
    if merged.is_empty() {
        anyhow::bail!("macros sources parsed empty — nothing to inline");
    }
    let block = build_inline_block(&merged)
        .map_err(|e| anyhow::anyhow!("macros JSON invalid: {e}"))?;

    let mut out = stripped;
    if !out.ends_with('\n') { out.push('\n'); }
    out.push('\n');                     // blank line before block
    out.push_str(&block);
    Ok(out)
}

/// Read `path`, extract any inline macros block into the sidecar file,
/// and return the markdown content with the block removed. Caller writes
/// both files. Returns `(new_md, sidecar_json)` where sidecar_json is
/// pretty-printed JSON.
pub fn split_from_source(path: &Path) -> anyhow::Result<(String, String)> {
    let md = fs::read_to_string(path)?;
    let (stripped, inline_json) = extract_inline_macros(&md);
    let inline_json = inline_json
        .ok_or_else(|| anyhow::anyhow!("no inline macros block found in {}", path.display()))?;

    // Re-pretty-print the JSON for the sidecar.
    let v: serde_json::Value = serde_json::from_str(&inline_json)?;
    let map = match v {
        serde_json::Value::Object(m) => m,
        _ => anyhow::bail!("inline macros body is not a JSON object"),
    };
    let sorted: BTreeMap<String, serde_json::Value> = map.into_iter().collect();
    let mut sidecar_json = pretty_format(&sorted);
    sidecar_json.push('\n');

    Ok((stripped, sidecar_json))
}
