use clap::{Parser, ValueEnum};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "md4x", version, about = "Convert a Markdown file to a magazine-quality PDF.")]
struct Args {
    /// Input .md file
    input: PathBuf,

    /// Output format
    #[arg(long, value_enum)]
    to: Format,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum Format {
    Pdf,
}

fn main() {
    let _ = Args::parse();
}
