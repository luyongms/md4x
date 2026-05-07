use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize)]
struct RenderedDoc {
    html: String,
    diagnostics: Vec<String>,
    /// JSON object source (or empty string) of `<file>.macros.json` next to
    /// the source. JS uses this to push live macro updates into the iframe
    /// without doing a full template-switch reload.
    user_macros: String,
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

/// Thin GUI-side wrapper around the kernel's macros plugin loader, so
/// the lookup convention (sibling `<stem>.macros.json` /
/// `<full-name>.macros.json`) lives in ONE place — `plugins::macros`.
fn load_user_macros(source_path: Option<&str>) -> String {
    let pb = source_path.map(std::path::PathBuf::from);
    md4x_core::plugins::macros::load_user_macros(pb.as_deref())
}

#[tauri::command]
fn render_html(
    md: String,
    template: String,
    source_path: Option<String>,
) -> Result<RenderedDoc, String> {
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
    let user_macros_json = load_user_macros(source_path.as_deref());

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
        html {{ background: #c8c8c8 !important; padding: 8px 0 !important; margin: 0 !important; min-height: 100% !important; box-sizing: border-box !important; overflow-y: auto !important; overflow-x: hidden !important; }}\
        body {{ width: 210mm !important; padding: {body_padding} !important; margin-left: 0 !important; margin-right: 0 !important; margin-top: 0 !important; background: #ffffff !important; box-shadow: 0 0 24px rgba(0,0,0,0.15) !important; box-sizing: border-box !important; transform-origin: top left !important; }}\
        img {{ display: block !important; max-width: 100% !important; height: auto !important; margin-left: auto !important; margin-right: auto !important; }}\
        p:has(> img), p:has(> svg) {{ text-align: center !important; }}\
        body > svg, p > svg:only-child, figure > svg {{ display: block !important; max-width: 100% !important; margin-left: auto !important; margin-right: auto !important; }}\
        figure {{ text-align: center !important; margin: 1.5em auto !important; }}\
        figure > img {{ margin-left: auto !important; margin-right: auto !important; }}\
        figcaption {{ text-align: center !important; }}\
        span[data-math-style=\"display\"] {{ display: block !important; text-align: center !important; margin: 1em 0 !important; }}\
        pre.mermaid {{ max-width: 100% !important; text-align: center !important; }}\
        pre.mermaid > svg {{ max-width: 100% !important; height: auto !important; width: auto !important; display: block !important; margin-left: auto !important; margin-right: auto !important; }}\
        pre, pre code {{ white-space: pre-wrap !important; word-break: break-word !important; overflow-wrap: anywhere !important; max-width: 100% !important; box-sizing: border-box !important; overflow-x: hidden !important; }}\
        .admonish {{ max-width: 100% !important; box-sizing: border-box !important; }}\
        .admonish pre, .admonish pre code {{ max-width: 100% !important; white-space: pre-wrap !important; word-break: break-word !important; overflow-wrap: anywhere !important; }}\
    ");
    // Inline early-runner script: suppress WKWebView's native context menu
    // before any user interaction can trigger it. Capture phase so it wins
    // against any inner handler and against the default action.
    const PREVIEW_JS: &str = "\
        window.addEventListener('contextmenu',function(e){e.preventDefault();e.stopPropagation();},true);\
        window.addEventListener('mousedown',function(e){if(e.button===2){e.preventDefault();e.stopPropagation();}},true);\
        window.addEventListener('mouseup',function(e){if(e.button===2){e.preventDefault();e.stopPropagation();}},true);\
    ";

    // User macros: a JSON object loaded from `<file>.macros.json` next to
    // the source. Parsed at runtime by KaTeX's INIT_JS, which checks for
    // window.MD4X_USER_MACROS and merges over the defaults.
    let user_macros_script = if user_macros_json.is_empty() {
        String::new()
    } else {
        format!("<script>window.MD4X_USER_MACROS = {user_macros_json};</script>\n")
    };

    let html = format!(
        "<!DOCTYPE html>\n<html><head>\n\
         <meta charset=\"utf-8\">\n\
         <style>{css}</style>\n\
         <style>{preview_css}</style>\n\
         <link rel=\"stylesheet\" href=\"md4x://localhost/katex/katex.min.css\">\n\
         <script>{PREVIEW_JS}</script>\n\
         <script src=\"md4x://localhost/katex/katex.min.js\"></script>\n\
         <script src=\"md4x://localhost/mermaid.min.js\"></script>\n\
         {user_macros_script}\
         <script>document.addEventListener('DOMContentLoaded',function(){{\n{init_js}}});</script>\n\
         </head><body>\n{cover_html}\n{body_html}\n</body></html>\n"
    );
    Ok(RenderedDoc {
        html,
        diagnostics: vec![],
        user_macros: user_macros_json,
    })
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
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Result returned to JS after writing/merging the user-macros template.
#[derive(Serialize)]
struct MacrosTemplateResult {
    path: String,
    added: u32,
    existed: u32,
}

#[tauri::command]
fn write_macros_template(
    source_path: String,
    macros: Vec<String>,
) -> Result<MacrosTemplateResult, String> {
    let pb = std::path::PathBuf::from(&source_path);
    let parent = pb.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = pb
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    let target = parent.join(format!("{stem}.macros.json"));

    // Merge with existing if file present — never overwrite user-defined
    // expansions; only add stubs for entries we haven't seen.
    let mut existing: serde_json::Map<String, serde_json::Value> = if target.is_file() {
        let s = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s)
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };

    let mut added: u32 = 0;
    let mut existed: u32 = 0;
    for m in &macros {
        if existing.contains_key(m) {
            existed += 1;
            continue;
        }
        // Stub renders visibly in the document so the author knows what
        // still needs filling in.
        existing.insert(
            m.clone(),
            serde_json::Value::String(format!("\\mathrm{{TODO~{}}}", m.trim_start_matches('\\'))),
        );
        added += 1;
    }

    let pretty = serde_json::to_string_pretty(&existing).map_err(|e| e.to_string())?;
    std::fs::write(&target, pretty).map_err(|e| e.to_string())?;
    Ok(MacrosTemplateResult {
        path: target.display().to_string(),
        added,
        existed,
    })
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::PathBuf::from(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn read_file(path: String) -> Result<OpenedFile, String> {
    let pb = PathBuf::from(&path);
    let content = std::fs::read_to_string(&pb).map_err(|e| e.to_string())?;
    Ok(OpenedFile { path: pb.display().to_string(), content })
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<String, String> {
    let pb = PathBuf::from(&path);
    std::fs::write(&pb, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(pb.display().to_string())
}

#[derive(Serialize)]
struct SaveAsResult {
    path: Option<String>,
}

#[tauri::command]
async fn save_file_as(
    app: tauri::AppHandle,
    content: String,
    suggested_name: Option<String>,
) -> Result<SaveAsResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().add_filter("Markdown", &["md", "markdown", "mdx"]);
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(&name);
    }
    builder.save_file(move |path| { let _ = tx.send(path); });
    let Some(path) = rx.recv().map_err(|e| e.to_string())? else {
        return Ok(SaveAsResult { path: None });
    };
    let pb: PathBuf = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&pb, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(SaveAsResult { path: Some(pb.display().to_string()) })
}

#[tauri::command]
async fn export_pdf(
    app: tauri::AppHandle,
    md: String,
    template: String,
    output_path: Option<String>,
    source_path: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // If the GUI dialog already collected a path, use it directly.
    // Otherwise fall back to the native save dialog (legacy / menu path).
    let output: PathBuf = if let Some(p) = output_path {
        PathBuf::from(p)
    } else {
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .set_file_name("md4x-export.pdf")
            .save_file(move |path| { let _ = tx.send(path); });
        let Some(path) = rx.recv().map_err(|e| e.to_string())? else {
            return Err("cancelled".into());
        };
        path.into_path().map_err(|e| e.to_string())?
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tmp_md = std::env::temp_dir().join(format!("md4x-export-{ts}.md"));
    std::fs::write(&tmp_md, md.as_bytes()).map_err(|e| e.to_string())?;

    // Pass the ORIGINAL source path as the source hint so the macros
    // plugin's `<stem>.macros.json` sibling lookup resolves against the
    // user's actual file, not our temp path. Untitled docs just won't
    // pick up any macros file (no path → empty result).
    let source_hint: Option<PathBuf> = source_path.as_deref().map(PathBuf::from);
    eprintln!("[md4x-gui] export_pdf: tmp_md={} output={}", tmp_md.display(), output.display());
    let render_result = md4x_core::render::render_pdf_with_source(
        &tmp_md,
        &output,
        &template,
        source_hint.as_deref(),
    )
    .map_err(|e| {
        eprintln!("[md4x-gui] export_pdf failed: {e}");
        e.to_string()
    });
    let _ = std::fs::remove_file(&tmp_md);
    render_result?;

    eprintln!("[md4x-gui] export_pdf ok: {}", output.display());
    Ok(output.display().to_string())
}

#[tauri::command]
async fn pick_save_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| { let _ = tx.send(p); });
    let Some(path) = rx.recv().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let pb: PathBuf = path.into_path().map_err(|e| e.to_string())?;
    Ok(Some(pb.display().to_string()))
}

#[tauri::command]
fn default_save_dir() -> String {
    if let Ok(home) = std::env::var("HOME") {
        let docs = std::path::PathBuf::from(&home).join("Documents");
        if docs.is_dir() { return docs.display().to_string(); }
        return home;
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return profile;
    }
    String::from(".")
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
        .invoke_handler(tauri::generate_handler![
            list_templates, render_html, export_pdf, open_file,
            read_file, save_file, save_file_as, close_window,
            reveal_in_finder, pick_save_dir, default_save_dir,
            write_macros_template,
        ])
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

            // Custom File menu items.
            let new_item = MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let save_item = MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_as_item = MenuItemBuilder::with_id("save_as", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let export_item = MenuItemBuilder::with_id("export", "Export PDF…")
                .accelerator("CmdOrCtrl+E")
                .build(app)?;

            let prefs_item = MenuItemBuilder::with_id("settings", "Preferences…")
                .accelerator("CmdOrCtrl+Comma")
                .build(app)?;

            // App submenu (macOS): About / Preferences / Services / Hide / Quit.
            let app_submenu = SubmenuBuilder::new(app, "md4x")
                .about(None)
                .separator()
                .item(&prefs_item)
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
                .item(&new_item)
                .item(&open_item)
                .separator()
                .item(&save_item)
                .item(&save_as_item)
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
                    "new"      => "window.newDraft && window.newDraft();",
                    "open"     => "window.openFile && window.openFile();",
                    "save"     => "window.saveFile && window.saveFile();",
                    "save_as"  => "window.saveFileAs && window.saveFileAs();",
                    "export"   => "document.getElementById(\"export-btn\").click();",
                    "settings" => "window.openSettings && window.openSettings();",
                    _ => return,
                };
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval(js);
                }
            });
            // Close-requested → ask JS whether the doc is dirty; JS will
            // either let the close proceed or invoke a confirm dialog and
            // call invoke('close_window') on user choice.
            // DragDrop → open the dropped .md file via JS openFromPath().
            use tauri::Manager;

            // Runtime dock / window icon — embeds the 256@2x PNG so the
            // icon shows when running the unbundled binary (e.g. during
            // dev). The bundled .app gets its icon from bundle.icon (.icns)
            // independently.
            const ICON_PNG: &[u8] = include_bytes!("../icons/build/app.iconset/icon_256x256@2x.png");

            if let Some(w) = app.get_webview_window("main") {
                if let Ok(img) = tauri::image::Image::from_bytes(ICON_PNG) {
                    let _ = w.set_icon(img);
                }
                let w_for_eval = w.clone();
                w.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = w_for_eval.eval(
                            "window.confirmClose && window.confirmClose();",
                        );
                    }
                    tauri::WindowEvent::DragDrop(dd) => {
                        if let tauri::DragDropEvent::Drop { paths, .. } = dd {
                            let _ = w_for_eval.eval(
                                "document.body.classList.remove('window-dragover');",
                            );
                            if let Some(p) = paths.first() {
                                let path_str = p.to_string_lossy().to_string();
                                let lower = path_str.to_lowercase();
                                if lower.ends_with(".md")
                                    || lower.ends_with(".markdown")
                                    || lower.ends_with(".mdx")
                                {
                                    let escaped = path_str
                                        .replace('\\', "\\\\")
                                        .replace('"', "\\\"");
                                    let js = format!(
                                        "window.openFromPath && window.openFromPath(\"{escaped}\");"
                                    );
                                    let _ = w_for_eval.eval(&js);
                                }
                            }
                        } else if let tauri::DragDropEvent::Leave = dd {
                            let _ = w_for_eval.eval(
                                "document.body.classList.remove('window-dragover');",
                            );
                        } else {
                            // Enter / Over: paint the drag-over outline.
                            let _ = w_for_eval.eval(
                                "document.body.classList.add('window-dragover');",
                            );
                        }
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
