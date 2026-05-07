use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use std::path::{Path, PathBuf};

use md4x_core::plugins::macros::{
    extract_inline_macros, inline_into_source, lint, load_user_macros, macros_path_for,
    merge_macros, split_from_source,
};
use md4x_core::render;

#[derive(Parser)]
#[command(
    name = "md4x",
    version,
    about = "Convert Markdown file(s) to magazine-quality PDF.",
)]
pub struct Args {
    /// One or more markdown input files. With 2+ inputs, `--output` is
    /// rejected; each PDF lands next to its source as `<stem>.pdf`.
    /// Mutually exclusive with subcommands.
    #[arg(num_args = 1.., conflicts_with = "command")]
    pub inputs: Vec<PathBuf>,

    #[arg(long, value_enum, default_value_t = Format::Pdf)]
    pub to: Format,

    #[arg(long, value_enum, default_value_t = Template::Magazine)]
    pub template: Template,

    /// Output path. Only valid with a single input file.
    #[arg(short, long)]
    pub output: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Option<Cmd>,
}

#[derive(Subcommand)]
pub enum Cmd {
    /// Manage KaTeX user macros: inline a sidecar `.macros.json` into a
    /// markdown file (or split it back out) so a `.md` can be shipped
    /// self-contained. Inline-wins on conflict — see README.
    Macros {
        #[command(subcommand)]
        op: MacrosOp,
    },
}

#[derive(Subcommand)]
pub enum MacrosOp {
    /// Read `<file>.macros.json` and append an inline macros block at
    /// EOF. Idempotent — re-running rewrites the existing inline block.
    Inline {
        file: PathBuf,
        /// Remove the sidecar `.macros.json` after inlining.
        #[arg(long)]
        delete_sidecar: bool,
    },
    /// Extract the inline macros block from a markdown file into the
    /// sidecar `.macros.json` next to it.
    Split { file: PathBuf },
    /// Print the effective merged macros map (inline + sidecar; inline
    /// wins on conflict).
    Show { file: PathBuf },
    /// Report any divergence between the inline block and the sidecar.
    /// Exits non-zero on conflict.
    Lint { file: PathBuf },
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format { Pdf }

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

    if let Some(cmd) = args.command {
        return run_subcommand(cmd);
    }

    if args.inputs.is_empty() {
        bail!("no input file(s) given. See `md4x --help`.");
    }

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

fn run_subcommand(cmd: Cmd) -> Result<()> {
    match cmd {
        Cmd::Macros { op } => match op {
            MacrosOp::Inline { file, delete_sidecar } => cmd_macros_inline(&file, delete_sidecar),
            MacrosOp::Split  { file } => cmd_macros_split(&file),
            MacrosOp::Show   { file } => cmd_macros_show(&file),
            MacrosOp::Lint   { file } => cmd_macros_lint(&file),
        },
    }
}

fn cmd_macros_inline(file: &Path, delete_sidecar: bool) -> Result<()> {
    let new_md = inline_into_source(file)
        .with_context(|| format!("failed to inline into {}", file.display()))?;
    std::fs::write(file, new_md)
        .with_context(|| format!("failed to write {}", file.display()))?;
    eprintln!("Inlined macros into {}", file.display());
    if delete_sidecar {
        let sidecar = macros_path_for(file);
        if sidecar.is_file() {
            std::fs::remove_file(&sidecar)
                .with_context(|| format!("failed to remove sidecar {}", sidecar.display()))?;
            eprintln!("Removed sidecar {}", sidecar.display());
        }
    } else {
        eprintln!(
            "Sidecar kept (use --delete-sidecar to remove). The .md is now \
             self-contained — distributing it alone is enough."
        );
    }
    Ok(())
}

fn cmd_macros_split(file: &Path) -> Result<()> {
    let (new_md, sidecar_json) = split_from_source(file)
        .with_context(|| format!("failed to split {}", file.display()))?;
    std::fs::write(file, new_md)
        .with_context(|| format!("failed to write {}", file.display()))?;
    let sidecar = macros_path_for(file);
    std::fs::write(&sidecar, sidecar_json)
        .with_context(|| format!("failed to write {}", sidecar.display()))?;
    eprintln!("Wrote sidecar {}", sidecar.display());
    eprintln!("Removed inline block from {}", file.display());
    Ok(())
}

fn cmd_macros_show(file: &Path) -> Result<()> {
    let md = std::fs::read_to_string(file)
        .with_context(|| format!("failed to read {}", file.display()))?;
    let (_, inline_json) = extract_inline_macros(&md);
    let sidecar = load_user_macros(Some(file));
    let merged = merge_macros(inline_json.as_deref(), sidecar.as_deref());
    if merged.is_empty() {
        eprintln!("(no macros)");
    } else {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&merged) {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or(merged));
        } else {
            println!("{merged}");
        }
    }
    Ok(())
}

fn cmd_macros_lint(file: &Path) -> Result<()> {
    let md = std::fs::read_to_string(file)
        .with_context(|| format!("failed to read {}", file.display()))?;
    let (_, inline_json) = extract_inline_macros(&md);
    let sidecar = load_user_macros(Some(file));
    let report = lint(inline_json.as_deref(), sidecar.as_deref());
    if report.overlapping_keys.is_empty() {
        eprintln!("OK — no overlap between inline and sidecar.");
        return Ok(());
    }
    eprintln!("Overlapping keys: {}", report.overlapping_keys.join(", "));
    if report.conflicts.is_empty() {
        eprintln!(
            "All overlapping values match. Inline copies the sidecar — consider \
             `md4x macros split` if you only want one source."
        );
        return Ok(());
    }
    eprintln!("Conflicts (inline wins on render):");
    for (k, iv, sv) in &report.conflicts {
        eprintln!("  {k}: inline={iv}  sidecar={sv}");
    }
    bail!(
        "{} key(s) conflict between inline and sidecar",
        report.conflicts.len()
    );
}
