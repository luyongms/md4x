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
