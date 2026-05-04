use md4x::plugins::{mermaid::MermaidPlugin, Plugin};

#[test]
fn plugin_has_stable_name() {
    assert_eq!(MermaidPlugin.name(), "mermaid");
}

#[test]
fn ast_rewrite_replaces_mermaid_fence_with_pre_class_mermaid() {
    let md = "Before.\n\n```mermaid\ngraph TD;A-->B\n```\n\nAfter.\n";
    let html = md4x::plugins::testing::format_with_plugin(&MermaidPlugin, md);
    assert!(html.contains("<pre class=\"mermaid\">"), "got: {html}");
    // Source is HTML-escaped — `>` becomes `&gt;`.
    assert!(html.contains("graph TD;A--&gt;B"), "got: {html}");
    assert!(html.contains("<p>Before.</p>"), "got: {html}");
    assert!(html.contains("<p>After.</p>"), "got: {html}");
}

#[test]
fn ast_rewrite_leaves_non_mermaid_fence_alone() {
    let md = "```rust\nfn main() {}\n```\n";
    let html = md4x::plugins::testing::format_with_plugin(&MermaidPlugin, md);
    assert!(!html.contains("class=\"mermaid\""), "got: {html}");
    assert!(html.contains("language-rust"), "got: {html}");
}

#[test]
fn head_html_loads_mermaid_script() {
    let head = MermaidPlugin.head_html();
    assert!(head.contains("mermaid.min.js"), "got: {head}");
    assert!(head.contains("<script"), "got: {head}");
}

#[test]
fn init_js_calls_initialize() {
    let init = MermaidPlugin.init_js();
    assert!(init.contains("mermaid.initialize"), "got: {init}");
}

#[test]
fn extract_assets_writes_mermaid_min_js() {
    let tmp = tempdir();
    MermaidPlugin.extract_assets(&tmp).unwrap();
    let f = tmp.join("mermaid.min.js");
    assert!(f.is_file(), "expected {} to exist", f.display());
    let bytes = std::fs::metadata(&f).unwrap().len();
    assert!(bytes > 100_000, "mermaid.min.js too small: {bytes} bytes");
}

fn tempdir() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let n: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    p.push(format!("md4x-mermaid-{n}"));
    std::fs::create_dir_all(&p).unwrap();
    p
}
