// Tests for v0.2.4 self-contained inline macros.
// Spec: docs/spec/v0.2.4-self-contained-macros.md

use md4x_core::plugins::macros::{
    build_inline_block, extract_inline_macros, lint, merge_macros,
};

const SAMPLE_MD_NO_BLOCK: &str = "\
# Title

Some math: $\\R$ and $\\eps$.
";

const SAMPLE_MD_WITH_BLOCK: &str = "\
# Title

Some math: $\\R$.

<!-- md4x:macros
{
  \"\\\\R\": \"\\\\mathbb{R}\"
}
-->
";

// ── extract_inline_macros ──────────────────────────────────────────────────

#[test]
fn extract_returns_none_when_no_block() {
    let (out, json) = extract_inline_macros(SAMPLE_MD_NO_BLOCK);
    assert_eq!(out, SAMPLE_MD_NO_BLOCK);
    assert!(json.is_none());
}

#[test]
fn extract_strips_block_at_eof() {
    let (out, json) = extract_inline_macros(SAMPLE_MD_WITH_BLOCK);
    assert!(json.is_some(), "should extract JSON body");
    let j = json.unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&j).expect("body must parse");
    assert!(parsed.is_object());
    assert_eq!(parsed["\\R"], "\\mathbb{R}");
    assert!(!out.contains("md4x:macros"));
    assert!(out.ends_with('\n'));
}

#[test]
fn extract_rejects_block_not_at_eof() {
    let md = "\
# Title

<!-- md4x:macros
{\"\\\\R\":\"\\\\mathbb{R}\"}
-->

trailing content
";
    let (out, json) = extract_inline_macros(md);
    assert_eq!(out, md, "block not at EOF must be left alone");
    assert!(json.is_none());
}

#[test]
fn extract_rejects_invalid_json() {
    let md = "\
# Title

<!-- md4x:macros
not json at all
-->
";
    let (out, json) = extract_inline_macros(md);
    assert_eq!(out, md);
    assert!(json.is_none());
}

#[test]
fn extract_rejects_non_object_json() {
    let md = "\
# Title

<!-- md4x:macros
[1, 2, 3]
-->
";
    let (out, json) = extract_inline_macros(md);
    assert_eq!(out, md);
    assert!(json.is_none());
}

#[test]
fn extract_requires_sentinel_at_column_zero() {
    let md = "\
# Title

  <!-- md4x:macros
{\"a\":\"b\"}
-->
";
    let (out, json) = extract_inline_macros(md);
    assert_eq!(out, md, "indented sentinel must not match");
    assert!(json.is_none());
}

#[test]
fn extract_idempotent_after_strip() {
    let (stripped, _) = extract_inline_macros(SAMPLE_MD_WITH_BLOCK);
    let (again, json2) = extract_inline_macros(&stripped);
    assert_eq!(again, stripped);
    assert!(json2.is_none(), "stripped doc must have no block");
}

// ── build_inline_block ─────────────────────────────────────────────────────

#[test]
fn build_block_pretty_prints_sorted_keys() {
    let json = "{\"\\\\Z\":\"\\\\mathbb{Z}\",\"\\\\R\":\"\\\\mathbb{R}\"}";
    let block = build_inline_block(json).unwrap();
    let r_pos = block.find("\\\\R").unwrap();
    let z_pos = block.find("\\\\Z").unwrap();
    assert!(r_pos < z_pos, "keys must be sorted (R before Z)");
    assert!(block.starts_with("<!-- md4x:macros\n"));
    assert!(block.ends_with("-->\n"));
    assert!(block.contains("  \""), "2-space indent");
}

#[test]
fn build_block_rejects_invalid_json() {
    assert!(build_inline_block("not json").is_err());
}

#[test]
fn build_block_rejects_non_object() {
    assert!(build_inline_block("[1,2,3]").is_err());
}

// ── merge_macros (inline wins) ─────────────────────────────────────────────

#[test]
fn merge_inline_wins_on_conflict() {
    let inline  = "{\"\\\\R\":\"INLINE\",\"\\\\X\":\"only-inline\"}";
    let sidecar = "{\"\\\\R\":\"SIDECAR\",\"\\\\Y\":\"only-sidecar\"}";
    let merged = merge_macros(Some(inline), Some(sidecar));
    let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
    assert_eq!(v["\\R"], "INLINE");
    assert_eq!(v["\\X"], "only-inline");
    assert_eq!(v["\\Y"], "only-sidecar");
}

#[test]
fn merge_empty_when_both_missing() {
    assert_eq!(merge_macros(None, None), "");
}

#[test]
fn merge_handles_one_side_only() {
    let s = merge_macros(None, Some("{\"\\\\R\":\"\\\\mathbb{R}\"}"));
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert_eq!(v["\\R"], "\\mathbb{R}");
}

// ── lint ───────────────────────────────────────────────────────────────────

#[test]
fn lint_reports_no_overlap_when_disjoint() {
    let r = lint(Some("{\"a\":\"x\"}"), Some("{\"b\":\"y\"}"));
    assert!(r.overlapping_keys.is_empty());
    assert!(r.conflicts.is_empty());
}

#[test]
fn lint_reports_overlap_without_conflict_when_values_match() {
    let r = lint(Some("{\"a\":\"x\"}"), Some("{\"a\":\"x\"}"));
    assert_eq!(r.overlapping_keys, vec!["a".to_string()]);
    assert!(r.conflicts.is_empty());
}

#[test]
fn lint_reports_conflict_when_values_differ() {
    let r = lint(Some("{\"a\":\"x\"}"), Some("{\"a\":\"y\"}"));
    assert_eq!(r.overlapping_keys, vec!["a".to_string()]);
    assert_eq!(r.conflicts.len(), 1);
}

// ── Round-trip property ────────────────────────────────────────────────────

#[test]
fn roundtrip_inline_split_inline_is_identity_modulo_format() {
    let original_json = "{\"\\\\R\":\"\\\\mathbb{R}\",\"\\\\eps\":\"\\\\varepsilon\"}";
    let block_a = build_inline_block(original_json).unwrap();
    let md = format!("# Doc\n\nbody\n\n{}", block_a);
    // Extract → re-build → must match block_a since build is canonical.
    let (_, extracted) = extract_inline_macros(&md);
    let block_b = build_inline_block(&extracted.unwrap()).unwrap();
    assert_eq!(block_a, block_b);
}
