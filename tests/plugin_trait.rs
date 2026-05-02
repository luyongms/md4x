use md4x::plugins::{ContentKind, Plugin, Registry};

struct EchoPlugin {
    kind: ContentKind,
    label: &'static str,
}

impl Plugin for EchoPlugin {
    fn handles(&self) -> ContentKind { self.kind }
    fn transform(&self, source: &str) -> anyhow::Result<String> {
        Ok(format!("[{}: {}]", self.label, source))
    }
}

#[test]
fn registry_dispatches_to_plugin_by_kind() {
    let mut reg = Registry::new();
    reg.register(EchoPlugin { kind: ContentKind::Mermaid, label: "M" });
    reg.register(EchoPlugin { kind: ContentKind::Math,    label: "K" });

    assert_eq!(reg.transform(ContentKind::Mermaid, "graph TD;A-->B").unwrap(),
               "[M: graph TD;A-->B]");
    assert_eq!(reg.transform(ContentKind::Math, "x = 1").unwrap(),
               "[K: x = 1]");
}

#[test]
fn first_registered_plugin_wins_when_multiple_handle_same_kind() {
    let mut reg = Registry::new();
    reg.register(EchoPlugin { kind: ContentKind::Mermaid, label: "first" });
    reg.register(EchoPlugin { kind: ContentKind::Mermaid, label: "second" });
    let html = reg.transform(ContentKind::Mermaid, "x").unwrap();
    assert!(html.starts_with("[first:"), "got: {html}");
}

struct FailingPlugin;
impl Plugin for FailingPlugin {
    fn handles(&self) -> ContentKind { ContentKind::Mermaid }
    fn transform(&self, _: &str) -> anyhow::Result<String> {
        anyhow::bail!("simulated plugin failure")
    }
}

#[test]
fn plugin_error_is_captured_in_diagnostic_not_propagated_as_crash() {
    let mut reg = Registry::new();
    reg.register(FailingPlugin);

    let mut diagnostics = Vec::new();
    let html = reg.transform_with_diagnostics(ContentKind::Mermaid, "input", &mut diagnostics);

    assert!(html.is_some(), "transform_with_diagnostics returned None");
    let html = html.unwrap();
    assert!(html.contains("error"), "expected error placeholder: {html}");
    assert_eq!(diagnostics.len(), 1, "expected one diagnostic");
    assert!(diagnostics[0].contains("simulated plugin failure"));
}
