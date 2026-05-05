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
    let html = format!("<style>{css}</style>{cover_html}{body_html}");
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_templates, render_html, export_pdf])
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
