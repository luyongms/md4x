use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "md4x", version, about = "Convert a Markdown file to a magazine-quality PDF.")]
pub struct Args {
    pub input: PathBuf,

    #[arg(long, value_enum)]
    pub to: Format,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Pdf,
}

pub fn run() -> Result<()> {
    let args = Args::parse();
    let _ = args
        .input
        .canonicalize()
        .with_context(|| format!("input file not found: {}", args.input.display()))?;
    Ok(())
}
