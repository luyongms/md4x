use md4x::plugins::parser::ParserPlugin;
use md4x::plugins::Plugin;

#[test]
fn parses_h1_and_paragraph() {
    let p = ParserPlugin::new();
    let html = p.transform("# Title\n\nA paragraph.").unwrap();
    assert!(html.contains("<h1>Title</h1>") || html.contains("<h1 "), "got: {html}");
    assert!(html.contains("<p>A paragraph.</p>"), "got: {html}");
}

#[test]
fn parses_gfm_table() {
    let p = ParserPlugin::new();
    let md = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    let html = p.transform(md).unwrap();
    assert!(html.contains("<table>"), "got: {html}");
    assert!(html.contains("<th>A</th>") || html.contains(">A<"), "got: {html}");
}

#[test]
fn parses_footnote() {
    let p = ParserPlugin::new();
    let md = "Body[^1].\n\n[^1]: Note.";
    let html = p.transform(md).unwrap();
    assert!(html.contains("footnote"), "got: {html}");
}
