# md4x — backlog

Things we explicitly chose to defer past v0.1.1. Bring forward in the order listed.

## v0.1.x (immediately after v0.1.1)

- **US-9: Multiple graph aesthetics.** SVG post-processing pipeline that lets templates apply distinct graph looks (blueprint, hand-drawn, schoolbook, technical-precise). User signaled strong interest — pick up immediately after v0.1.1 ships.

## v0.2.x

- **Graphviz / Kroki support.** Alternative graph engines as plugins behind the same plugin contract. User signaled strong interest. Bring up as soon as the v0.1.1 plugin trait is proven.

## Deferred (no version commitment yet)

- **Auto landscape page rotation** for very wide mermaid diagrams (per-page orientation in WebView2/WKWebView is platform-specific friction).
- **Splitting massive diagrams** across multiple pages.
- **Citations** (`citeproc-rs`-based) — defer until a user asks.
- **Linux support** (WebKitGTK) — parked; revisit when Mac+Win path is solid.
- **WASM plugin loader** — third loader type, design slot reserved, build later.
- **Live preview / watch mode (B-1).**
- **Multi-file project support (B-2).**
- **Compressed-for-email mode (D-3).**
- **Template-authoring tools** (separate tool/service vs. in-binary — undecided).
