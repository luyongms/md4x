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

/// Per-template body padding (in mm), matching each template's @page margins.
/// Templates assume their @page margin is the body's screen padding so that
/// `.cover-page { width: calc(100% + Xmm); margin: -Ymm }` bleeds correctly.
fn body_padding_for(template: &str) -> &'static str {
    match template {
        "magazine"  => "22mm 22mm 24mm 22mm",
        "tufte"     => "24mm 50mm 24mm 28mm",
        "newyorker" => "24mm 28mm 26mm 28mm",
        "brutalist" => "18mm 14mm 18mm 22mm",
        "swiss"     => "22mm 22mm 24mm 22mm",
        "stem"      => "24mm 22mm 22mm 22mm",
        _           => "22mm",
    }
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
    let body_padding = body_padding_for(&template);

    // Build full self-contained HTML. Scripts served via md4x:// custom protocol.
    // CSS is inline (small, ~10KB). Scripts are URL references (large, loaded once by browser cache).
    // Frontend uses DOMParser on this HTML but morphdoms only the <body>.
    // Preview-mode overrides injected after template CSS:
    // - body margin: @page margins don't apply on screen, so add equivalent.
    //   Magazine cover uses `width: calc(100%+44mm); margin: -22mm...` which assumes
    //   a 22mm body margin — so this value must match the @page margin to get full-bleed.
    // - html overflow: ensure the iframe document is scrollable.
    // A4-page preview model: html is a gray "desk", body is a fixed-width
    // 210mm "page" that gets CSS-zoomed (set from JS) to fit the iframe.
    // Padding 22mm on body matches the @page margin used by templates, so
    // structural rules like .cover-page { width: calc(100% + 44mm); margin:
    // -22mm } continue to bleed correctly to the page edge.
    // {body_padding} is interpolated below per template — it MUST match each
    // template's @page margins so cover-page bleed math works on screen.
    let preview_css = format!("\
        html {{ background: #c8c8c8 !important; padding: 24px !important; margin: 0 !important; min-height: 100% !important; box-sizing: border-box !important; overflow-y: auto !important; overflow-x: hidden !important; }}\
        body {{ width: 210mm !important; padding: {body_padding} !important; margin: 0 auto !important; background: #ffffff !important; box-shadow: 0 0 24px rgba(0,0,0,0.15) !important; box-sizing: border-box !important; transform-origin: top left !important; }}\
        img {{ display: block !important; max-width: 100% !important; height: auto !important; margin-left: auto !important; margin-right: auto !important; }}\
        p:has(> img), p:has(> svg) {{ text-align: center !important; }}\
        body > svg, p > svg:only-child, figure > svg {{ display: block !important; max-width: 100% !important; margin-left: auto !important; margin-right: auto !important; }}\
        figure {{ text-align: center !important; margin: 1.5em auto !important; }}\
        figure > img {{ margin-left: auto !important; margin-right: auto !important; }}\
        figcaption {{ text-align: center !important; }}\
        span[data-math-style=\"display\"] {{ display: block !important; text-align: center !important; margin: 1em 0 !important; }}\
        pre.mermaid {{ max-width: 100% !important; text-align: center !important; }}\
        pre.mermaid > svg {{ max-width: 100% !important; height: auto !important; width: auto !important; display: block !important; margin-left: auto !important; margin-right: auto !important; }}\
    ");
    // Inline early-runner script: suppress WKWebView's native context menu
    // before any user interaction can trigger it. Capture phase so it wins
    // against any inner handler and against the default action.
    const PREVIEW_JS: &str = "\
        window.addEventListener('contextmenu',function(e){e.preventDefault();e.stopPropagation();},true);\
        window.addEventListener('mousedown',function(e){if(e.button===2){e.preventDefault();e.stopPropagation();}},true);\
        window.addEventListener('mouseup',function(e){if(e.button===2){e.preventDefault();e.stopPropagation();}},true);\
    ";

    let html = format!(
        "<!DOCTYPE html>\n<html><head>\n\
         <meta charset=\"utf-8\">\n\
         <style>{css}</style>\n\
         <style>{preview_css}</style>\n\
         <link rel=\"stylesheet\" href=\"md4x://localhost/katex/katex.min.css\">\n\
         <script>{PREVIEW_JS}</script>\n\
         <script src=\"md4x://localhost/katex/katex.min.js\"></script>\n\
         <script src=\"md4x://localhost/mermaid.min.js\"></script>\n\
         <script>document.addEventListener('DOMContentLoaded',function(){{\n{init_js}}});</script>\n\
         </head><body>\n{cover_html}\n{body_html}\n</body></html>\n"
    );
    Ok(RenderedDoc { html, diagnostics: vec![] })
}

#[derive(Serialize)]
struct OpenedFile {
    path: String,
    content: String,
}

#[tauri::command]
async fn open_file(app: tauri::AppHandle) -> Result<Option<OpenedFile>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdx"])
        .pick_file(move |path| { let _ = tx.send(path); });
    let Some(path) = rx.recv().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path: PathBuf = path.into_path().map_err(|e| e.to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(OpenedFile {
        path: path.display().to_string(),
        content,
    }))
}

#[tauri::command]
async fn export_pdf(app: tauri::AppHandle, md: String, template: String) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // Native save dialog. Runs on a dedicated dialog thread; we await its
    // result via a oneshot channel so the Tauri command stays async.
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name("md4x-export.pdf")
        .save_file(move |path| { let _ = tx.send(path); });
    let Some(path) = rx.recv().map_err(|e| e.to_string())? else {
        return Err("cancelled".into());
    };
    let output: PathBuf = path
        .into_path()
        .map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tmp_md = std::env::temp_dir().join(format!("md4x-export-{ts}.md"));
    std::fs::write(&tmp_md, md.as_bytes()).map_err(|e| e.to_string())?;

    eprintln!("[md4x-gui] export_pdf: tmp_md={} output={}", tmp_md.display(), output.display());
    md4x_core::render::render_pdf(&tmp_md, &output, &template)
        .map_err(|e| {
            eprintln!("[md4x-gui] export_pdf failed: {e}");
            e.to_string()
        })?;
    let _ = std::fs::remove_file(&tmp_md);

    eprintln!("[md4x-gui] export_pdf ok: {}", output.display());
    Ok(output.display().to_string())
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
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![list_templates, render_html, export_pdf, open_file])
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

            // Custom File menu items.
            let open_item = MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let export_item = MenuItemBuilder::with_id("export", "Export PDF…")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;

            // App submenu (macOS): About / Services / Hide / Quit etc.
            let app_submenu = SubmenuBuilder::new(app, "md4x")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_submenu = SubmenuBuilder::new(app, "File")
                .item(&open_item)
                .separator()
                .item(&export_item)
                .separator()
                .close_window()
                .build()?;

            // Edit submenu provides the system bindings for Cmd+C/V/X/A/Z/Y —
            // without it, native text inputs (incl. our <textarea>) lose paste.
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_submenu, &file_submenu, &edit_submenu, &window_submenu])
                .build()?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                use tauri::Manager;
                let id = event.id().0.as_str();
                let js: &str = match id {
                    "open"   => "window.openFile && window.openFile();",
                    "export" => "document.getElementById(\"export-btn\").click();",
                    _ => return,
                };
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval(js);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
