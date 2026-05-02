use anyhow::Result;
use comrak::{markdown_to_html, ComrakOptions};

use super::{ContentKind, Plugin};

pub struct ParserPlugin;

impl ParserPlugin {
    pub fn new() -> Self {
        Self
    }

    fn get_options() -> ComrakOptions<'static> {
        let mut options = ComrakOptions::default();
        options.extension.table = true;
        options.extension.footnotes = true;
        options.extension.strikethrough = true;
        options.extension.tasklist = true;
        options.extension.autolink = true;
        options.extension.tagfilter = true;
        options.extension.superscript = true;
        options
    }
}

impl Default for ParserPlugin {
    fn default() -> Self { Self::new() }
}

impl Plugin for ParserPlugin {
    fn handles(&self) -> ContentKind { ContentKind::Markdown }
    fn transform(&self, source: &str) -> Result<String> {
        let options = Self::get_options();
        Ok(markdown_to_html(source, &options))
    }
}
