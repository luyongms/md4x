//! Emits the rendered HTML body for a markdown fixture, exactly as the GUI
//! iframe would see it. Used by scratch/sync-probe to verify that
//! browser-parsed top-level body children match the harness-coalesced
//! comrak block list.

use md4x_core::plugins::Registry;
use md4x_core::render::markdown_to_html_with;
use std::env;
use std::fs;

fn main() {
    let path = env::args().nth(1).expect("usage: html_probe <md>");
    let raw = fs::read_to_string(&path).expect("read md");
    let md = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).to_string();
    let registry = Registry::default();
    let html = markdown_to_html_with(&md, &registry);
    print!("{html}");
}
