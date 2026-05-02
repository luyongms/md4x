use anyhow::Result;
use std::collections::HashMap;

pub mod parser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContentKind {
    Markdown,
    Code,
    Mermaid,
    Math,
    Renderer,
}

pub trait Plugin: Send + Sync {
    fn handles(&self) -> ContentKind;
    fn transform(&self, source: &str) -> Result<String>;
}

pub struct Registry {
    plugins: HashMap<ContentKind, Vec<Box<dyn Plugin>>>,
}

impl Registry {
    pub fn new() -> Self { Self { plugins: HashMap::new() } }

    /// Register a plugin. If multiple plugins register for the same `ContentKind`,
    /// the **first** registered wins (deterministic).
    pub fn register<P: Plugin + 'static>(&mut self, plugin: P) {
        self.plugins
            .entry(plugin.handles())
            .or_default()
            .push(Box::new(plugin));
    }

    pub fn transform(&self, kind: ContentKind, source: &str) -> Result<String> {
        match self.plugins.get(&kind).and_then(|v| v.first()) {
            Some(p) => p.transform(source),
            None => anyhow::bail!("no plugin registered for {:?}", kind),
        }
    }
}

impl Registry {
    pub fn transform_with_diagnostics(
        &self,
        kind: ContentKind,
        source: &str,
        diagnostics: &mut Vec<String>,
    ) -> Option<String> {
        match self.plugins.get(&kind).and_then(|v| v.first()) {
            None => Some(format!("<!-- md4x: no plugin registered for {kind:?} -->")),
            Some(p) => match p.transform(source) {
                Ok(html) => Some(html),
                Err(e) => {
                    diagnostics.push(format!("{kind:?} plugin error: {e}"));
                    Some(format!("<div class=\"md4x-error\">[{kind:?}: error — see diagnostics]</div>"))
                }
            },
        }
    }
}

impl Default for Registry {
    fn default() -> Self { Self::new() }
}
