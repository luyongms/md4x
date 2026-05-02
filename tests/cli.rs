use std::process::Command;

fn md4x_bin() -> &'static str {
    env!("CARGO_BIN_EXE_md4x")
}

#[test]
fn version_flag_prints_version_and_exits_zero() {
    let out = Command::new(md4x_bin()).arg("--version").output().unwrap();
    assert!(out.status.success(), "exit was {:?}", out.status);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("md4x"), "stdout was: {stdout}");
    assert!(stdout.contains("0.1.1"), "stdout was: {stdout}");
}

#[test]
fn help_flag_lists_required_args() {
    let out = Command::new(md4x_bin()).arg("--help").output().unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("INPUT"), "missing INPUT in help: {stdout}");
    assert!(stdout.contains("--to"),  "missing --to in help: {stdout}");
}

#[test]
fn missing_input_returns_nonzero_with_helpful_stderr() {
    let out = Command::new(md4x_bin())
        .args(["/no/such/path.md", "--to", "pdf"])
        .output()
        .unwrap();
    assert!(!out.status.success(), "expected nonzero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.to_lowercase().contains("not found") || stderr.to_lowercase().contains("no such file"),
        "stderr should mention file not found: {stderr}"
    );
}
