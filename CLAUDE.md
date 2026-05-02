# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Project: md4x

Convert a Markdown file to PDF, PPTX, or MP4. Rust, desktop-only. Optimize for small binary, low memory, fast startup, single-file deployment.

**md4x uses an LLM at specific pipeline stages, but it is not an agentic tool** — no agent loop, no tool use / function calling, no MCP. LLM calls are plain prompt → completion.

**Status:** pre-v1 prototype. Versions: `v0.N.M` with N, M ≥ 1. Treat the codebase as experimental — ideas are still being explored.

**Portable CLI principle.** Single binary, copy-to-bin install, no registry / installer / app bundle. md4x writes only to user-specified outputs (and a scratch dir adjacent to the output, deleted on success). No global config files, no system state.

**Testing discipline.** Every behavioral claim — text layout, graph rendering, classification thresholds, page count — gets a test that mechanically verifies it. Visual outputs require either snapshot / perceptual-diff tests or measurable constraints (text size ≥ X, classification class == Y, page count == N). "Looks good" reviews never substitute for assertions.

**Dogfood our own output.** Plan, design, and issue markdown files under `docs/` are auto-converted to PDF on every Write/Edit via a project-level Claude Code hook (`.claude/settings.json` → `scripts/md-to-pdf-hook.sh`). The user reads the rendered PDFs alongside the markdown source. Auto-generated PDFs under `docs/` are gitignored (`docs/**/*.pdf`); template preview PDFs at `templates/<name>/preview.pdf` are committed as test baselines. As md4x evolves, the hook will swap from `scripts/md-to-pdf.sh` (bash) to the md4x binary itself.

**SDD / TDD discipline (religious).** Development order is non-negotiable: **spec → tests → code**.

1. **Spec first.** No feature begins without a written spec section describing desired behavior, constraints, and success criteria. The spec is the source of truth for *what* to build.
2. **Tests next, derived from the spec.** Every spec claim gets a test that mechanically verifies it. Tests are written *before* the code that satisfies them. Test coverage broadly maps to spec coverage.
3. **Code last, written to pass tests.** Implementation pursues clean architecture under the constraint that tests pass. Refactor freely; the test set is the contract.

Operational order: spec section → failing tests for that section → minimum code to pass → refactor → next spec section. Implementation plans must be structured around this order.
