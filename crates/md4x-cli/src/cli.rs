use anyhow::{bail, Result};
use clap::{Parser, ValueEnum};
use std::path::PathBuf;

use md4x_core::render;

#[derive(Parser)]
#[command(name = "md4x", version, about = "Convert Markdown file(s) to magazine-quality PDF.")]
pub struct Args {
    /// One or more markdown input files. With 2+ inputs, `--output` is
    /// rejected; each PDF lands next to its source as `<stem>.pdf`.
    #[arg(required = true, num_args = 1..)]
    pub inputs: Vec<PathBuf>,

    #[arg(long, value_enum, default_value_t = Format::Pdf)]
    pub to: Format,

    #[arg(long, value_enum, default_value_t = Template::Magazine)]
    pub template: Template,

    /// Output path. Only valid with a single input file.
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

    if args.inputs.len() > 1 && args.output.is_some() {
        bail!(
            "--output is only valid with a single input file (got {} inputs); \
             with multiple inputs each PDF is written next to its source",
            args.inputs.len()
        );
    }

    let template = args.template.dir_name();
    let mut errors: Vec<String> = Vec::new();

    for input_arg in &args.inputs {
        let input = match input_arg.canonicalize() {
            Ok(p) => p,
            Err(_) => {
                errors.push(format!("input file not found: {}", input_arg.display()));
                continue;
            }
        };
        let output = args
            .output
            .clone()
            .unwrap_or_else(|| input.with_extension("pdf"));

        let result = match args.to {
            Format::Pdf => render::render_pdf(&input, &output, template),
        };
        match result {
            Ok(()) => eprintln!("Wrote {}", output.display()),
            Err(e) => errors.push(format!("{}: {:#}", input.display(), e)),
        }
    }

    if !errors.is_empty() {
        bail!("{} input(s) failed:\n  {}", errors.len(), errors.join("\n  "));
    }
    Ok(())
}
