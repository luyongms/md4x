use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
struct RenderedDoc {
    html: String,
    diagnostics: Vec<String>,
}

#[tauri::command]
fn list_templates() -> Vec<String> {
    md4x_core::templates::available()
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[tauri::command]
fn render_html(md: String, template: String) -> Result<RenderedDoc, String> {
    use md4x_core::plugins::Registry;
    use md4x_core::render::{extract_cover_values, markdown_to_html_with, substitute_cover_with};
    use md4x_core::templates;

    let registry = Registry::default();
    let css = templates::style_css(&template).map_err(|e| e.to_string())?;
    let cover_tmpl = templates::cover_html().map_err(|e| e.to_string())?;
    let cover_values = extract_cover_values(&md, "preview");
    let cover_html = substitute_cover_with(&cover_tmpl, &cover_values, &registry);
    let body_html = markdown_to_html_with(&md, &registry);

    let _head_html = registry.head_html();
    let init_js = registry.init_js();

    // Build full self-contained HTML. Scripts served via md4x:// custom protocol.
    // CSS is inline (small, ~10KB). Scripts are URL references (large, loaded once by browser cache).
    // Frontend uses DOMParser on this HTML but morphdoms only the <body>.
    // Preview-mode overrides injected after template CSS:
    // - body margin: @page margins don't apply on screen, so add equivalent.
    //   Magazine cover uses `width: calc(100%+44mm); margin: -22mm...` which assumes
    //   a 22mm body margin — so this value must match the @page margin to get full-bleed.
    // - html overflow: ensure the iframe document is scrollable.
    const PREVIEW_CSS: &str = "\
        body { margin: 22mm !important; }\
        html { overflow-y: auto !important; }\
    ";
    let html = format!(
        "<!DOCTYPE html>\n<html><head>\n\
         <meta charset=\"utf-8\">\n\
         <style>{css}</style>\n\
         <style>{PREVIEW_CSS}</style>\n\
         <link rel=\"stylesheet\" href=\"md4x://localhost/katex/katex.min.css\">\n\
         <script src=\"md4x://localhost/katex/katex.min.js\"></script>\n\
         <script src=\"md4x://localhost/mermaid.min.js\"></script>\n\
         <script>document.addEventListener('DOMContentLoaded',function(){{\n{init_js}}});</script>\n\
         </head><body>\n{cover_html}\n{body_html}\n</body></html>\n"
    );
    Ok(RenderedDoc { html, diagnostics: vec![] })
}

#[tauri::command]
fn export_pdf(_md: String, template: String, output: PathBuf) -> Result<u64, String> {
    md4x_core::render::render_pdf(&output, &output, &template)
        .map_err(|e| e.to_string())?;
    std::fs::metadata(&output)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".js") { "application/javascript" }
    else if path.ends_with(".css") { "text/css" }
    else if path.ends_with(".woff2") { "font/woff2" }
    else if path.ends_with(".woff") { "font/woff" }
    else if path.ends_with(".ttf") { "font/ttf" }
    else if path.ends_with(".svg") { "image/svg+xml" }
    else if path.ends_with(".png") { "image/png" }
    else { "application/octet-stream" }
}

fn main() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("md4x", |_app, request| {
            use md4x_core::plugins::{katex, mermaid};

            // path is like "/mermaid.min.js" or "/katex/katex.min.js"
            let path = request.uri().path().trim_start_matches('/');
            let ct = content_type_for(path);

            let body: Vec<u8> = if path == "mermaid.min.js" {
                mermaid::mermaid_js().to_vec()
            } else if let Some(katex_path) = path.strip_prefix("katex/") {
                katex::katex_dir()
                    .get_file(katex_path)
                    .map(|f| f.contents().to_vec())
                    .unwrap_or_default()
            } else {
                vec![]
            };

            tauri::http::Response::builder()
                .header("Content-Type", ct)
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![list_templates, render_html, export_pdf])
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
