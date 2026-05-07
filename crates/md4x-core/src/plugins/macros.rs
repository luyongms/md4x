//! MacrosPlugin: per-document KaTeX macro overrides loaded from
//! `<source>.macros.json` (or `<source.md>.macros.json`) sibling to the
//! markdown file. The JSON is injected as
//! `<script>window.MD4X_USER_MACROS = {...};</script>` BEFORE the KaTeX
//! plugin's INIT_JS runs, so KaTeX's INIT_JS picks the entries up and
//! merges them over the defaults.
//!
//! Lives in the plugin layer (NOT the kernel). The kernel passes the
//! source file path via `Plugin::head_html_for` so this plugin — and
//! only this plugin — does the IO. CLI's `render_pdf` and the GUI's
//! `render_html` / `export_pdf` all flow through the same code path,
//! so a `<file>.macros.json` change is picked up uniformly.

use std::fs;
use std::path::Path;

use super::Plugin;

pub struct MacrosPlugin;

impl Plugin for MacrosPlugin {
    fn name(&self) -> &'static str {
        "macros"
    }

    fn head_html_for(&self, source_path: Option<&Path>) -> String {
        let json = load_user_macros(source_path);
        if json.is_empty() {
            String::new()
        } else {
            // Trim to keep the embedded script readable. The body has
            // already been validated as a JSON object by load_user_macros.
            format!(
                "<script>window.MD4X_USER_MACROS = {};</script>\n",
                json.trim()
            )
        }
    }
}

/// Read `<stem>.macros.json` (then `<full-name>.macros.json` as fallback)
/// next to `source`. Returns the file contents (must start with `{` to be
/// considered a JSON object) or an empty string on miss / invalid file.
///
/// Public so the GUI can use the same lookup logic for two extra paths:
///   1. The "Generate template" Tauri command needs to write to the same
///      target file this plugin reads from.
///   2. The GUI returns the JSON to its frontend so that an in-place
///      edit (without re-bootstrapping the iframe) can push the new
///      macro map into the live KaTeX options.
pub fn load_user_macros(source: Option<&Path>) -> String {
    let Some(p) = source else { return String::new(); };
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
                // Sanity check: must start with `{` after whitespace so
                // we don't inject e.g. an array or stray markdown.
                if s.trim_start().starts_with('{') {
                    return s;
                }
            }
        }
    }
    String::new()
}

/// Compute the canonical macros-file path for a given source. Used by
/// the GUI's "Generate template" command so it writes to the same place
/// `load_user_macros` reads from.
pub fn macros_path_for(source: &Path) -> std::path::PathBuf {
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    parent.join(format!("{stem}.macros.json"))
}
