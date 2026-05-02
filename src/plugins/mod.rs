use anyhow::Result;
use std::collections::HashMap;

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

impl Default for Registry {
    fn default() -> Self { Self::new() }
}
