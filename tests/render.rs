use md4x::render;

#[test]
fn extract_title_from_h1() {
    let md = "# The Swiss Style\n\nA reference document.\n";
    let cv = render::extract_cover_values(md, "swiss-sample");
    assert_eq!(cv.title, "The Swiss Style");
}

#[test]
fn extract_title_falls_back_to_stem_when_no_h1() {
    let md = "Just a paragraph.\n";
    let cv = render::extract_cover_values(md, "no-h1-doc");
    assert_eq!(cv.title, "no-h1-doc");
}

#[test]
fn extract_subtitle_first_non_blank_after_h1() {
    let md = "# Title\n\nThe first body paragraph.\n\nSecond paragraph.\n";
    let cv = render::extract_cover_values(md, "x");
    assert_eq!(cv.subtitle, "The first body paragraph.");
}

#[test]
fn extract_subtitle_strips_label_prefix_and_bold_markers() {
    let md = "# Title\n\n**Document:** A demonstration.\n";
    let cv = render::extract_cover_values(md, "x");
    assert_eq!(cv.subtitle, "A demonstration.");
}

#[test]
fn extract_subtitle_skips_headings_and_thematic_breaks() {
    let md = "# Title\n\n---\n\n## Section\n\nBody line.\n";
    let cv = render::extract_cover_values(md, "x");
    assert_eq!(cv.subtitle, "Body line.");
}

#[test]
fn extract_eyebrow_uppercases_and_dashes_to_spaces() {
    let md = "# Title\n";
    let cv = render::extract_cover_values(md, "v0.1.1-release-notes");
    assert_eq!(cv.eyebrow, "V0.1.1 RELEASE NOTES");
}

#[test]
fn substitute_cover_replaces_all_placeholders() {
    let template = "<x>{{title}}|{{subtitle}}|{{eyebrow}}|{{author}}|{{date}}</x>";
    let cv = render::CoverValues {
        title: "T".into(),
        subtitle: "S".into(),
        eyebrow: "E".into(),
        author: "".into(),
        date: "MAY 2026".into(),
    };
    let out = render::substitute_cover(template, &cv);
    assert_eq!(out, "<x>T|S|E||MAY 2026</x>");
}

#[test]
fn substitute_cover_renders_inline_math_in_title_and_subtitle() {
    let template = "<t>{{title}}</t><s>{{subtitle}}</s><e>{{eyebrow}}</e>";
    let cv = render::CoverValues {
        title: "Vectors over $\\mathbb{R}$".into(),
        subtitle: "And also $\\mathbb{C}$".into(),
        eyebrow: "DOLLAR $1 IS LITERAL".into(),
        author: "".into(),
        date: "".into(),
    };
    let out = render::substitute_cover(template, &cv);
    assert!(
        out.contains("<span data-math-style=\"inline\">\\mathbb{R}</span>"),
        "title math not converted: {out}"
    );
    assert!(
        out.contains("<span data-math-style=\"inline\">\\mathbb{C}</span>"),
        "subtitle math not converted: {out}"
    );
    // Eyebrow stays literal — `$1` not converted (mismatched `$` should pass through escaped).
    assert!(out.contains("DOLLAR $1 IS LITERAL"), "eyebrow path changed: {out}");
}

#[test]
fn substitute_cover_html_escapes_values() {
    let template = "<x>{{title}}</x>";
    let cv = render::CoverValues {
        title: "A & <B>".into(),
        subtitle: "".into(),
        eyebrow: "".into(),
        author: "".into(),
        date: "".into(),
    };
    let out = render::substitute_cover(template, &cv);
    assert_eq!(out, "<x>A &amp; &lt;B&gt;</x>");
}

#[test]
fn markdown_to_html_emits_pre_class_mermaid_for_mermaid_fence() {
    let md = "Before.\n\n```mermaid\ngraph TD;A-->B\n```\n\nAfter.\n";
    let html = render::markdown_to_html(md);
    assert!(
        html.contains("<pre class=\"mermaid\">"),
        "expected mermaid pre, got: {html}"
    );
    assert!(html.contains("graph TD;A--&gt;B"), "expected escaped source: {html}");
    assert!(html.contains("<p>Before.</p>"), "expected normal markdown: {html}");
    assert!(html.contains("<p>After.</p>"), "expected normal markdown: {html}");
}

#[test]
fn markdown_to_html_handles_multiline_display_math_with_bare_equals() {
    // Bug #2 regression: bare `=` line inside `$$...$$` would become a
    // Setext H1 underline before math could claim the block.
    let md = "$$\n\\mathbf{A}\\cdot\\mathbf{x}\n=\n\\mathbf{b}\n$$\n";
    let html = render::markdown_to_html(md);
    assert!(!html.contains("<h1"), "math block was promoted to H1: {html}");
    assert!(
        html.contains("data-math-style=\"display\""),
        "expected display-math span: {html}"
    );
    assert!(
        html.contains("\\mathbf{A}\\cdot\\mathbf{x} = \\mathbf{b}"),
        "math source mangled or dropped: {html}"
    );
}

#[test]
fn markdown_to_html_preserves_math_dollars_verbatim() {
    let md = "Inline $\\vec{v}$ and a sum $\\sum_{i=1}^n u_i v_i$.\n\n$$\n\\langle u, v \\rangle\n$$\n";
    let html = render::markdown_to_html(md);
    // The "$$___$$ bug": markdown's `_` would otherwise eat math subscripts as <em>.
    assert!(!html.contains("<em>"), "math underscore corrupted into <em>: {html}");
    assert!(html.contains("data-math-style=\"inline\""), "no inline math span: {html}");
    assert!(html.contains("data-math-style=\"display\""), "no display math span: {html}");
    assert!(html.contains("\\sum_{i=1}^n u_i v_i"), "math source mangled: {html}");
}

#[test]
fn markdown_to_html_leaves_other_code_blocks_alone() {
    let md = "```rust\nfn main() {}\n```\n";
    let html = render::markdown_to_html(md);
    assert!(!html.contains("class=\"mermaid\""), "non-mermaid block tagged mermaid: {html}");
    assert!(html.contains("language-rust"), "expected language class: {html}");
    // Tokens are in styled spans now (syntect highlighting), so check fragments separately.
    assert!(html.contains("fn"), "missing 'fn' token: {html}");
    assert!(html.contains("main"), "missing 'main' token: {html}");
}

#[test]
fn markdown_to_html_applies_syntax_highlighting() {
    let md = "```rust\nfn main() {}\n```\n";
    let html = render::markdown_to_html(md);
    // Syntect emits <span style="color:..."> around tokens.
    assert!(html.contains("style=\"color"), "expected highlight spans: {html}");
}

#[test]
fn style_css_reports_unknown_template_helpfully() {
    let err = md4x::templates::style_css("definitely-not-a-template")
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("definitely-not-a-template") || err.contains("template"),
        "missing-template error should name the template: {err}"
    );
}

#[test]
fn available_templates_includes_what_we_ship() {
    let names = md4x::templates::available();
    for expected in ["magazine", "swiss", "stem", "tufte", "newyorker", "brutalist"] {
        assert!(names.contains(&expected), "missing template: {expected}; have: {names:?}");
    }
}

#[test]
fn chrome_install_help_contains_actionable_guidance() {
    let help = md4x::render::chrome_install_help();
    assert!(help.contains("https://www.google.com/chrome/"), "missing download URL: {help}");
    assert!(help.contains("brew install"), "missing Homebrew hint: {help}");
    assert!(help.contains("CHROME="), "missing env-var fallback: {help}");
    assert!(help.contains("no fallback renderer"), "missing 'no fallback' clarity: {help}");
}
