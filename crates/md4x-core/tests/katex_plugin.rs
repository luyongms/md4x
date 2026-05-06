use md4x_core::plugins::{katex::KatexPlugin, Plugin};

#[test]
fn plugin_has_stable_name() {
    assert_eq!(KatexPlugin.name(), "katex");
}

#[test]
fn configure_parse_enables_math_dollars() {
    let mut opts = comrak::ComrakOptions::default();
    KatexPlugin.configure_parse(&mut opts);
    assert!(opts.extension.math_dollars, "math_dollars not enabled");
}

#[test]
fn rewrite_cover_text_converts_inline_math() {
    let out = KatexPlugin.rewrite_cover_text("Vectors over $\\mathbb{R}$").unwrap();
    assert!(out.contains("<span data-math-style=\"inline\">\\mathbb{R}</span>"), "got: {out}");
    assert!(out.starts_with("Vectors over "), "got: {out}");
}

#[test]
fn rewrite_cover_text_html_escapes_non_math() {
    let out = KatexPlugin.rewrite_cover_text("A & <B>").unwrap();
    assert_eq!(out, "A &amp; &lt;B&gt;");
}

#[test]
fn rewrite_cover_text_handles_unmatched_dollar_as_literal() {
    let out = KatexPlugin.rewrite_cover_text("Costs $5").unwrap();
    assert!(!out.contains("data-math-style"), "got: {out}");
    assert!(out.contains("$5"), "got: {out}");
}

// Bug B: pandoc-style rules — `$N` (digit after $) is a literal dollar, not a
// math opener. So in a string like "Costs $5 vs $\sqrt{2}$ tradeoff", only the
// `$\sqrt{2}$` should become a math span; the `$5` stays literal and the
// trailing " tradeoff" is not eaten.
#[test]
fn rewrite_cover_text_does_not_open_math_before_digit() {
    let out = KatexPlugin
        .rewrite_cover_text("Costs $5 vs $\\sqrt{2}$ tradeoff")
        .unwrap();
    assert!(out.contains("$5 vs"), "literal $5 lost: {out}");
    assert!(
        out.contains("<span data-math-style=\"inline\">\\sqrt{2}</span>"),
        "real math missing: {out}"
    );
    assert!(out.ends_with(" tradeoff"), "trailing text eaten: {out}");
}

#[test]
fn rewrite_cover_text_does_not_open_math_before_space() {
    // `$ ...$` is not math (space after open). Should pass through as literal.
    let out = KatexPlugin.rewrite_cover_text("priced at $ 5 today").unwrap();
    assert!(!out.contains("data-math-style"), "got: {out}");
}

#[test]
fn rewrite_cover_text_does_not_close_math_after_space() {
    // `$x $ y$` → space before close `$` disqualifies that close. The opener
    // `$x ` is a candidate but lacks a valid close before whitespace; we
    // expect the parser to fall back to literal so we don't eat ` y` text.
    let out = KatexPlugin.rewrite_cover_text("$x $ y$").unwrap();
    // Either literal (no math span) or a single span with content "x $ y" —
    // but never an empty span or split text. Easiest assertion: original
    // characters all survive.
    assert!(out.contains("y"), "trailing y eaten: {out}");
}

#[test]
fn head_html_loads_katex_css_and_js() {
    let head = KatexPlugin.head_html();
    assert!(head.contains("katex/katex.min.css"), "got: {head}");
    assert!(head.contains("katex/katex.min.js"), "got: {head}");
}

#[test]
fn init_js_renders_inline_and_display_spans() {
    let init = KatexPlugin.init_js();
    assert!(init.contains("data-math-style=\\\"inline\\\"")
            || init.contains("data-math-style=\"inline\""), "got: {init}");
    assert!(init.contains("katex.render"), "got: {init}");
}

#[test]
fn preprocess_collapses_multiline_display_math_so_setext_h1_doesnt_eat_it() {
    // Bug #2: bare `=` line under a paragraph in markdown becomes a Setext H1
    // underline, destroying the math block. KaTeX's preprocess_markdown must
    // collapse multi-line `$$...$$` blocks into a single line.
    let md = "$$\n\\mathbf{A}\\cdot\\mathbf{x}\n=\n\\mathbf{b}\n$$\n";
    let out = KatexPlugin.preprocess_markdown(md).unwrap();
    assert!(
        !out.contains("\n=\n"),
        "bare `=` line still present: {out}"
    );
    assert!(
        out.contains("$$ \\mathbf{A}\\cdot\\mathbf{x} = \\mathbf{b} $$"),
        "expected single-line collapsed math: {out}"
    );
}

#[test]
fn preprocess_leaves_inline_math_alone() {
    let md = "Inline $\\vec{v}$ here.\n";
    let out = KatexPlugin.preprocess_markdown(md).unwrap();
    assert_eq!(out, md);
}

#[test]
fn preprocess_does_not_collapse_dollars_inside_fenced_code() {
    let md = "```text\n$$\nfoo\n=\nbar\n$$\n```\n";
    let out = KatexPlugin.preprocess_markdown(md).unwrap();
    assert!(out.contains("\n=\n"), "code-fenced `$$` was wrongly touched: {out}");
    assert!(out.contains("\n$$\nfoo\n"), "code-fenced markers altered: {out}");
}

#[test]
fn extract_assets_writes_katex_dir_with_css_and_js() {
    let tmp = tempdir();
    KatexPlugin.extract_assets(&tmp).unwrap();
    assert!(tmp.join("katex/katex.min.css").is_file(), "missing katex.min.css");
    assert!(tmp.join("katex/katex.min.js").is_file(), "missing katex.min.js");
    let fonts = tmp.join("katex/fonts");
    assert!(fonts.is_dir(), "missing fonts dir");
    let woff2 = std::fs::read_dir(&fonts).unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "woff2").unwrap_or(false))
        .count();
    assert!(woff2 >= 10, "expected woff2 fonts; saw {woff2}");
}

fn tempdir() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let n: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    p.push(format!("md4x-katex-{n}"));
    std::fs::create_dir_all(&p).unwrap();
    p
}
