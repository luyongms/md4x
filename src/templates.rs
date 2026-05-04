//! Template loader. Two modes selected at compile time:
//!
//! * **Default (dev)**: templates are read from `<bin_dir>/templates/` on disk.
//!   Editing a CSS file and re-running md4x picks up the change with no rebuild.
//!
//! * **`bundle-templates` feature (dist)**: every bundled template's runtime
//!   files are embedded into the binary via `include_str!`. The shipped
//!   tarball is a single file — `md4x` — with no separate `templates/`
//!   directory.
//!
//! Adding a template later is one entry in `style_css` plus the new
//! `templates/<name>/style.css` file at the repo root.

use anyhow::{bail, Result};
#[cfg(not(feature = "bundle-templates"))]
use anyhow::{anyhow, Context};
#[cfg(not(feature = "bundle-templates"))]
use std::path::PathBuf;

/// True when templates are embedded in the binary (dist build).
pub fn bundled() -> bool {
    cfg!(feature = "bundle-templates")
}

/// Names of templates available in this build.
pub fn available() -> &'static [&'static str] {
    &["magazine", "swiss", "stem", "tufte", "newyorker", "brutalist"]
}

pub fn cover_html() -> Result<String> {
    #[cfg(feature = "bundle-templates")]
    {
        Ok(include_str!("../templates/cover.html").to_string())
    }
    #[cfg(not(feature = "bundle-templates"))]
    {
        let path = templates_dir_on_disk()?.join("cover.html");
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))
    }
}

pub fn style_css(name: &str) -> Result<String> {
    #[cfg(feature = "bundle-templates")]
    {
        match name {
            "magazine" => Ok(include_str!("../templates/magazine/style.css").to_string()),
            "swiss" => Ok(include_str!("../templates/swiss/style.css").to_string()),
            "stem" => Ok(include_str!("../templates/stem/style.css").to_string()),
            "tufte" => Ok(include_str!("../templates/tufte/style.css").to_string()),
            "newyorker" => Ok(include_str!("../templates/newyorker/style.css").to_string()),
            "brutalist" => Ok(include_str!("../templates/brutalist/style.css").to_string()),
            other => bail!(
                "template '{}' is not bundled (available: {})",
                other,
                available().join(", ")
            ),
        }
    }
    #[cfg(not(feature = "bundle-templates"))]
    {
        let path = templates_dir_on_disk()?.join(name).join("style.css");
        if !path.is_file() {
            bail!(
                "template '{}' not found: {} missing",
                name,
                path.display()
            );
        }
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))
    }
}

#[cfg(not(feature = "bundle-templates"))]
fn templates_dir_on_disk() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("locating current executable")?;
    let bin_dir = exe
        .parent()
        .ok_or_else(|| anyhow!("current_exe has no parent"))?;
    let dir = bin_dir.join("templates");
    if !dir.is_dir() {
        bail!(
            "missing assets: templates/ not found at {} (rebuild with --features bundle-templates to embed)",
            dir.display()
        );
    }
    let cover = dir.join("cover.html");
    if !cover.is_file() {
        bail!(
            "missing assets: cover.html not found at {}",
            cover.display()
        );
    }
    Ok(dir)
}

