use clap::Parser;

#[derive(Parser)]
#[command(name = "md4x", version, about = "Convert a Markdown file to a magazine-quality PDF.")]
struct Args {}

fn main() {
    let _ = Args::parse();
}
