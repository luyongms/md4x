use md4x::plugins::Registry;

#[test]
fn default_registry_has_three_plugins_in_documented_order() {
    let reg = Registry::default();
    let names: Vec<&str> = reg.plugins().iter().map(|p| p.name()).collect();
    assert_eq!(names, vec!["mermaid", "katex", "syntect"]);
}

#[test]
fn head_html_concatenates_in_registry_order() {
    let reg = Registry::default();
    let head = reg.head_html();
    let mermaid_pos = head.find("mermaid.min.js").expect("mermaid not in head");
    let katex_pos = head.find("katex.min.js").expect("katex not in head");
    assert!(mermaid_pos < katex_pos, "expected mermaid before katex in head");
}

#[test]
fn init_js_concatenates_all_plugin_init() {
    let reg = Registry::default();
    let init = reg.init_js();
    assert!(init.contains("mermaid.initialize"), "missing mermaid init: {init}");
    assert!(init.contains("katex.render"), "missing katex init: {init}");
}

#[test]
fn rewrite_cover_text_uses_first_match() {
    // KaTeX is the only plugin in the default registry that rewrites cover text.
    let reg = Registry::default();
    let out = reg.rewrite_cover_text("over $\\mathbb{R}$");
    assert!(out.contains("data-math-style=\"inline\""), "got: {out}");
}

#[test]
fn rewrite_cover_text_falls_back_to_html_escape_when_no_match() {
    // Plain text — no plugin should claim it, so we get html-escape fallback.
    let reg = Registry::default();
    let out = reg.rewrite_cover_text("A & B");
    assert_eq!(out, "A &amp; B");
}
