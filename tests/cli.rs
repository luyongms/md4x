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
