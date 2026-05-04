//! SyntectPlugin: server-side code-fence syntax highlighting via comrak's
//! syntect feature, using `two-face`'s extended syntax bundle (covers
//! TypeScript, Elixir, Kotlin, etc., beyond syntect's default ~70 languages).

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};
use std::sync::OnceLock;

use super::Plugin;

const THEME: &str = "InspiredGitHub";

pub struct SyntectPlugin {
    adapter: OnceLock<SyntectAdapter>,
}

impl SyntectPlugin {
    pub fn new() -> Self {
        Self {
            adapter: OnceLock::new(),
        }
    }
}

impl Default for SyntectPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl Plugin for SyntectPlugin {
    fn name(&self) -> &'static str {
        "syntect"
    }

    fn syntax_highlighter(&self) -> Option<&dyn SyntaxHighlighterAdapter> {
        let a = self.adapter.get_or_init(|| {
            SyntectAdapterBuilder::new()
                .syntax_set(two_face::syntax::extra_newlines())
                .theme(THEME)
                .build()
        });
        Some(a)
    }
}
