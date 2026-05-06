//! Tests for kernel internals — URL encoding, scratch dir uniqueness,
//! truthy KEEP_WORK parsing, virtual-time-budget scaling. These are
//! root-cause regression tests for bugs found in v0.1.1.

use md4x_core::render;

// Bug A: paths with special chars must produce a `file://` URL that Chrome
// accepts. Chrome's parser is stricter than RFC 3986 — it rejects sub-delim
// chars like `&`, `'`, `$`, `(`, `)`, etc. raw in path components even though
// the RFC permits them. So we encode aggressively: everything except the
// unreserved set + `/` is percent-encoded.
#[test]
fn file_url_encodes_all_non_unreserved_chars_for_chrome() {
    let p = std::path::Path::new("/tmp/a b&c'd\"e$f(g)h.html");
    let url = render::file_url(p).unwrap();
    assert!(url.starts_with("file:///"), "not absolute: {url}");
    for c in [' ', '&', '\'', '"', '$', '(', ')'] {
        assert!(!url.contains(c), "char {c:?} not encoded: {url}");
    }
    // Path-segment separator and unreserved chars survive.
    assert!(url.contains("/tmp/"), "lost path structure: {url}");
    assert!(url.ends_with(".html"), "lost extension: {url}");
}

#[test]
fn file_url_encodes_unicode_paths() {
    let p = std::path::Path::new("/tmp/测试 文件.html");
    let url = render::file_url(p).unwrap();
    // Should be all ASCII after encoding.
    assert!(url.is_ascii(), "non-ASCII URL: {url}");
    // The space must be encoded.
    assert!(!url.contains(' '), "space leaked: {url}");
    // CJK chars produce %XX byte sequences.
    assert!(url.contains("%E6") || url.contains("%E7"), "no UTF-8 percent bytes: {url}");
}

#[test]
fn file_url_rejects_relative_paths() {
    let p = std::path::Path::new("relative/path.html");
    assert!(render::file_url(p).is_err(), "relative path should error");
}

// Bug J: scratch_dir must produce unique names for the same output across
// concurrent calls (PID + nanos disambiguation).
#[test]
fn scratch_dir_is_unique_across_calls() {
    let out = std::path::Path::new("/tmp/x.pdf");
    let a = render::scratch_dir(out);
    std::thread::sleep(std::time::Duration::from_nanos(1));
    let b = render::scratch_dir(out);
    assert_ne!(a, b, "scratch_dir collided: {a:?}");
    assert!(a.starts_with("/tmp"));
    let an = a.file_name().unwrap().to_str().unwrap();
    assert!(an.starts_with("x.pdf.work"), "got: {an}");
}

// Bug G: KEEP_WORK should accept any common truthy value.
#[test]
fn keep_work_accepts_truthy_values() {
    for v in ["1", "true", "TRUE", "True", "yes", "YES", "on", "On"] {
        assert!(render::is_truthy(v), "expected truthy: {v:?}");
    }
}

#[test]
fn keep_work_rejects_falsy_values() {
    for v in ["0", "false", "FALSE", "no", "off", "", "  "] {
        assert!(!render::is_truthy(v), "expected falsy: {v:?}");
    }
}

// Bug K: virtual-time-budget should scale with mermaid block count.
#[test]
fn chrome_budget_scales_with_mermaid_count() {
    // 0 mermaid → base only
    let zero = render::chrome_budget_ms("# Hi\n\ntext.\n");
    // 50 mermaid → much larger
    let mut many = String::from("# Many\n");
    for i in 0..50 {
        many.push_str(&format!("\n```mermaid\ngraph TD;A{i}-->B{i}\n```\n"));
    }
    let big = render::chrome_budget_ms(&many);
    assert!(big > zero, "no scaling: zero={zero}, big={big}");
    assert!(big > 15_000, "50 mermaid blocks should warrant >15s: {big}");
}

#[test]
fn chrome_budget_caps_at_60s() {
    // 1000 mermaid blocks shouldn't produce a 5-minute budget.
    let mut huge = String::from("# Huge\n");
    for i in 0..1000 {
        huge.push_str(&format!("\n```mermaid\ngraph TD;A{i}\n```\n"));
    }
    let b = render::chrome_budget_ms(&huge);
    assert!(b <= 60_000, "budget should be capped: {b}");
}
