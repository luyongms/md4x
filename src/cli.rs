use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use std::path::PathBuf;

use crate::render;

#[derive(Parser)]
#[command(name = "md4x", version, about = "Convert a Markdown file to a magazine-quality PDF.")]
pub struct Args {
    pub input: PathBuf,

    #[arg(long, value_enum, default_value_t = Format::Pdf)]
    pub to: Format,

    #[arg(long, value_enum, default_value_t = Template::Magazine)]
    pub template: Template,

    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Pdf,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Template {
    Magazine,
    Swiss,
    Stem,
    Tufte,
    #[value(name = "newyorker")]
    NewYorker,
    Brutalist,
}

impl Template {
    fn dir_name(self) -> &'static str {
        match self {
            Template::Magazine => "magazine",
            Template::Swiss => "swiss",
            Template::Stem => "stem",
            Template::Tufte => "tufte",
            Template::NewYorker => "newyorker",
            Template::Brutalist => "brutalist",
        }
    }
}

pub fn run() -> Result<()> {
    let args = Args::parse();
    let input = args
        .input
        .canonicalize()
        .with_context(|| format!("input file not found: {}", args.input.display()))?;

    let output = args.output.unwrap_or_else(|| input.with_extension("pdf"));

    match args.to {
        Format::Pdf => render::render_pdf(&input, &output, args.template.dir_name())?,
    }
    eprintln!("Wrote {}", output.display());
    Ok(())
}
