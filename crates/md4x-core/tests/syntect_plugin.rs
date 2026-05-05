use md4x_core::plugins::{syntect::SyntectPlugin, Plugin};

#[test]
fn plugin_has_stable_name() {
    assert_eq!(SyntectPlugin::new().name(), "syntect");
}

#[test]
fn syntax_highlighter_is_provided() {
    let plugin = SyntectPlugin::new();
    assert!(plugin.syntax_highlighter().is_some(), "no highlighter");
}

#[test]
fn highlights_rust() {
    let html = render_with_syntect("```rust\nfn main() { let x = 1; }\n```\n");
    assert!(html.contains("language-rust"), "got: {html}");
    assert!(html.contains("style=\"color"), "expected styled spans: {html}");
}

#[test]
fn highlights_typescript_via_two_face_bundle() {
    let html = render_with_syntect("```ts\nconst x: number = 1;\n```\n");
    // two-face's bat bundle has TypeScript; syntect default does not.
    assert!(html.contains("style=\"color"), "expected TS highlight spans: {html}");
}

#[test]
fn highlights_elixir() {
    let html = render_with_syntect("```elixir\ndefmodule M do\n  def f, do: 1\nend\n```\n");
    assert!(html.contains("style=\"color"), "expected Elixir highlight spans: {html}");
}

#[test]
fn highlights_kotlin() {
    let html = render_with_syntect("```kotlin\nfun main() { println(\"hi\") }\n```\n");
    assert!(html.contains("style=\"color"), "expected Kotlin highlight spans: {html}");
}

fn render_with_syntect(md: &str) -> String {
    let plugin = SyntectPlugin::new();
    let arena = comrak::Arena::new();
    let opts = comrak::ComrakOptions::default();
    let root = comrak::parse_document(&arena, md, &opts);
    let mut plugins = comrak::Plugins::default();
    plugins.render.codefence_syntax_highlighter = plugin.syntax_highlighter();
    let mut buf = Vec::new();
    comrak::format_html_with_plugins(root, &opts, &mut buf, &plugins).unwrap();
    String::from_utf8(buf).unwrap()
}
