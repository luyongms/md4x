// Run: node --test crates/md4x-gui/frontend/tests/scroll-sync.test.mjs
// Spec: docs/spec/v0.2.5-scroll-sync.md § 6.1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const ss = createRequire(import.meta.url)('../scroll-sync.js');

const { reduce, initial, math } = ss;

// Helper: walk a sequence of actions through the reducer.
function runSeq(state, actions) {
  const allOutputs = [];
  let s = state;
  for (const a of actions) {
    const r = reduce(s, a);
    s = r.state;
    allOutputs.push(...r.outputs);
  }
  return { state: s, outputs: allOutputs };
}
function outTypes(outputs) { return outputs.map(o => o.type); }

// ── 1. IDLE + editorWheel → DRIVING_EDITOR ────────────────────────────────
test('idle + editorWheel → DRIVING_EDITOR; publishDriver(editor)', () => {
  const { state, outputs } = reduce(initial(), { type: 'editorWheel' });
  assert.equal(state.fsm, 'DRIVING_EDITOR');
  assert.deepEqual(outputs, [{ type: 'publishDriver', side: 'editor' }]);
});

// ── 2. IDLE + previewWheel → DRIVING_PREVIEW ──────────────────────────────
test('idle + previewWheel → DRIVING_PREVIEW; publishDriver(preview)', () => {
  const { state, outputs } = reduce(initial(), { type: 'previewWheel' });
  assert.equal(state.fsm, 'DRIVING_PREVIEW');
  assert.deepEqual(outputs, [{ type: 'publishDriver', side: 'preview' }]);
});

// ── 3. IDLE + editorCursor → DRIVING_EDITOR; resolve emitted ──────────────
test('idle + editorCursor(L) → DRIVING_EDITOR; resolveFromCursor emitted', () => {
  const { state, outputs } = reduce(initial(), { type: 'editorCursor', line: 42 });
  assert.equal(state.fsm, 'DRIVING_EDITOR');
  assert.ok(outputs.some(o => o.type === 'publishDriver' && o.side === 'editor'));
  assert.ok(outputs.some(o => o.type === 'resolveFromCursor' && o.line === 42));
});

// ── 4. DRIVING_EDITOR + editorScroll → LOCKED_PROGRAMMATIC; resolve ───────
test('DRIVING_EDITOR + editorScroll → LOCKED_PROGRAMMATIC w/ expectation', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor' };
  const { state, outputs } = reduce(s0, { type: 'editorScroll', y: 200, targetPreviewY: 350 });
  assert.equal(state.fsm, 'LOCKED_PROGRAMMATIC');
  assert.deepEqual(state.expected, { side: 'preview', y: 350 });
  assert.ok(outputs.some(o => o.type === 'setPreviewScrollTop' && o.y === 350));
});

// ── 5. LOCKED_PROGRAMMATIC + previewScroll matching expY → consume ────────
test('LOCKED_PROGRAMMATIC + matching previewScroll → DRIVING_EDITOR; no output', () => {
  const s0 = { ...initial(), fsm: 'LOCKED_PROGRAMMATIC', prevDriver: 'editor', expected: { side: 'preview', y: 350 } };
  const { state, outputs } = reduce(s0, { type: 'previewScroll', y: 350 });
  assert.equal(state.fsm, 'DRIVING_EDITOR');
  assert.equal(state.expected, null);
  assert.deepEqual(outputs, []);
});

// ── 6. LOCKED_PROGRAMMATIC + non-matching previewScroll → DRIVING_PREVIEW ─
test('LOCKED_PROGRAMMATIC + non-matching previewScroll → DRIVING_PREVIEW; reverse resolve', () => {
  const s0 = { ...initial(), fsm: 'LOCKED_PROGRAMMATIC', prevDriver: 'editor', expected: { side: 'preview', y: 350 } };
  const { state, outputs } = reduce(s0, { type: 'previewScroll', y: 999 });
  assert.equal(state.fsm, 'DRIVING_PREVIEW');
  assert.equal(state.expected, null);
  assert.ok(outputs.some(o => o.type === 'publishDriver' && o.side === 'preview'));
  assert.ok(outputs.some(o => o.type === 'resolveFromPreviewScroll' && o.y === 999));
});

// ── 7. LOCKED_PROGRAMMATIC + 2× frameTick → restore prior driver ──────────
test('LOCKED_PROGRAMMATIC + 2 frameTicks (no scroll) → prior driver state', () => {
  const s0 = { ...initial(), fsm: 'LOCKED_PROGRAMMATIC', prevDriver: 'editor', expected: { side: 'preview', y: 350 }, expectedFrames: 0 };
  const r1 = reduce(s0, { type: 'frameTick' });
  assert.equal(r1.state.fsm, 'LOCKED_PROGRAMMATIC');
  const r2 = reduce(r1.state, { type: 'frameTick' });
  assert.equal(r2.state.fsm, 'DRIVING_EDITOR');
  assert.equal(r2.state.expected, null);
});

// ── 8. DRIVING_EDITOR + idleTimeout → IDLE ────────────────────────────────
test('DRIVING_EDITOR + idleTimeout → IDLE; publishDriver(null)', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor' };
  const { state, outputs } = reduce(s0, { type: 'idleTimeout' });
  assert.equal(state.fsm, 'IDLE');
  assert.deepEqual(outputs, [{ type: 'publishDriver', side: null }]);
});

// ── 9. any + splitterDragStart → SUSPENDED, prev fsm saved ────────────────
test('DRIVING_EDITOR + splitterDragStart → SUSPENDED', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor' };
  const { state } = reduce(s0, { type: 'splitterDragStart' });
  assert.equal(state.fsm, 'SUSPENDED');
  assert.equal(state.prevFsmBeforeSuspend, 'DRIVING_EDITOR');
});

// ── 10. SUSPENDED gates editorScroll (no setPreviewScrollTop) ─────────────
test('SUSPENDED + editorScroll → no output', () => {
  const s0 = { ...initial(), fsm: 'SUSPENDED', prevFsmBeforeSuspend: 'DRIVING_EDITOR' };
  const { state, outputs } = reduce(s0, { type: 'editorScroll', y: 100, targetPreviewY: 200 });
  assert.equal(state.fsm, 'SUSPENDED');
  assert.deepEqual(outputs, []);
});

// ── 11. SUSPENDED + splitterDragEnd → restore prior; cache invalidate; resolve once ─
test('SUSPENDED + splitterDragEnd → prior fsm; invalidateBlockCache + resolveOnce', () => {
  const s0 = { ...initial(), fsm: 'SUSPENDED', prevFsmBeforeSuspend: 'DRIVING_EDITOR', prevDriver: 'editor' };
  const { state, outputs } = reduce(s0, { type: 'splitterDragEnd' });
  assert.equal(state.fsm, 'DRIVING_EDITOR');
  assert.ok(outputs.some(o => o.type === 'invalidateBlockCache'));
  assert.ok(outputs.some(o => o.type === 'resolveOnce'));
});

// ── 12. any + renderStart → SUSPENDED ─────────────────────────────────────
test('DRIVING_PREVIEW + renderStart → SUSPENDED', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_PREVIEW', prevDriver: 'preview' };
  const { state } = reduce(s0, { type: 'renderStart' });
  assert.equal(state.fsm, 'SUSPENDED');
  assert.equal(state.prevFsmBeforeSuspend, 'DRIVING_PREVIEW');
});

// ── 13. SUSPENDED + renderComplete → prior; invalidate + resolve once ─────
test('SUSPENDED + renderComplete → prior fsm; invalidateBlockCache + resolveOnce', () => {
  const s0 = { ...initial(), fsm: 'SUSPENDED', prevFsmBeforeSuspend: 'DRIVING_PREVIEW', prevDriver: 'preview' };
  const { state, outputs } = reduce(s0, { type: 'renderComplete' });
  assert.equal(state.fsm, 'DRIVING_PREVIEW');
  assert.ok(outputs.some(o => o.type === 'invalidateBlockCache'));
  assert.ok(outputs.some(o => o.type === 'resolveOnce'));
});

// ── 14. DRIVING_EDITOR + frameTick + drift = 0 → no force-align ───────────
test('frameTick + drift=0 → no forceAlignTick', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor', pendingAlign: { follower: 'preview', drift: 0 } };
  const { state, outputs } = reduce(s0, { type: 'frameTick' });
  assert.equal(outputs.some(o => o.type === 'forceAlignTick'), false);
  assert.equal(state.pendingAlign, null);
});

// ── 15. drift = 4 px → forceAlignTick(4, preview) one-shot ────────────────
test('frameTick + drift=4 → forceAlignTick(4, preview); cleared', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor', pendingAlign: { follower: 'preview', drift: 4, atEnd: false } };
  const { state, outputs } = reduce(s0, { type: 'frameTick' });
  assert.deepEqual(outputs.find(o => o.type === 'forceAlignTick'), { type: 'forceAlignTick', side: 'preview', delta: 4 });
  assert.equal(state.pendingAlign, null);
});

// ── 16. drift = 4 px + atEnd → no force-align ─────────────────────────────
test('frameTick + drift=4 + atEnd → no forceAlignTick', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor', pendingAlign: { follower: 'preview', drift: 4, atEnd: true } };
  const { state, outputs } = reduce(s0, { type: 'frameTick' });
  assert.equal(outputs.some(o => o.type === 'forceAlignTick'), false);
  assert.equal(state.pendingAlign, null);
});

// ── 17. drift = 12 px → no force-align (race) ─────────────────────────────
test('frameTick + drift=12 → no forceAlignTick (race)', () => {
  const s0 = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor', pendingAlign: { follower: 'preview', drift: 12, atEnd: false } };
  const { state, outputs } = reduce(s0, { type: 'frameTick' });
  assert.equal(outputs.some(o => o.type === 'forceAlignTick'), false);
  assert.equal(state.pendingAlign, null);
});

// ── 18. only first force-align fires (one-shot) ───────────────────────────
test('two frameTicks with same pendingAlign → only first emits', () => {
  let s = { ...initial(), fsm: 'DRIVING_EDITOR', prevDriver: 'editor', pendingAlign: { follower: 'preview', drift: 5, atEnd: false } };
  const r1 = reduce(s, { type: 'frameTick' });
  s = r1.state;
  assert.equal(r1.outputs.filter(o => o.type === 'forceAlignTick').length, 1);
  const r2 = reduce(s, { type: 'frameTick' });
  assert.equal(r2.outputs.filter(o => o.type === 'forceAlignTick').length, 0);
});

// ── 19. previewClick → setEditorCursor emitted ────────────────────────────
test('previewClick(line=42) → setEditorCursor(42); DRIVING_PREVIEW', () => {
  const { state, outputs } = reduce(initial(), { type: 'previewClick', line: 42 });
  assert.equal(state.fsm, 'DRIVING_PREVIEW');
  assert.deepEqual(outputs.find(o => o.type === 'setEditorCursor'), { type: 'setEditorCursor', line: 42 });
});

// ── 20. Math: lineYInBlock at first source line returns block top ─────────
test('math.lineYInBlock(L=L1) = block top', () => {
  // 5-line block at top=100, height=120 (24px/line).
  assert.equal(math.lineYInBlock(1, 1, 5, 100, 120), 100);
});

// ── 21. Math: lineYInBlock at last line returns block top + height-line ───
test('math.lineYInBlock(L=L2) approximates last line position', () => {
  // 5 lines, top=100, height=120. Last line should be near top + 96 (4/5 down).
  const y = math.lineYInBlock(5, 1, 5, 100, 120);
  assert.ok(y >= 100 + 80 && y <= 100 + 120, `y=${y}`);
});

// ── 22. Math: lineYInBlock interpolates ───────────────────────────────────
test('math.lineYInBlock(L=L_mid) interpolates linearly', () => {
  // 5 lines, top=100, height=120. Middle line ≈ top + height*((3-1)/(5-1)) = 100 + 60 = 160.
  assert.equal(math.lineYInBlock(3, 1, 5, 100, 120), 160);
});

// ── 23. Math: single-line block returns top ───────────────────────────────
test('math.lineYInBlock with L1 == L2 returns block top', () => {
  assert.equal(math.lineYInBlock(7, 7, 7, 200, 24), 200);
});

// ── 24. invalidateBlockCache emitted exactly once on each event ───────────
test('renderComplete emits exactly one invalidateBlockCache', () => {
  const s0 = { ...initial(), fsm: 'SUSPENDED', prevFsmBeforeSuspend: 'IDLE' };
  const { outputs } = reduce(s0, { type: 'renderComplete' });
  const invals = outputs.filter(o => o.type === 'invalidateBlockCache');
  assert.equal(invals.length, 1);
});

// ── 25. After resolveOnce on resume, the next driver event resolves cleanly ─
test('renderComplete → resolveOnce; subsequent editorCursor still resolves', () => {
  let s = { ...initial(), fsm: 'SUSPENDED', prevFsmBeforeSuspend: 'IDLE' };
  const r1 = reduce(s, { type: 'renderComplete' });
  s = r1.state;
  const r2 = reduce(s, { type: 'editorCursor', line: 7 });
  assert.equal(r2.state.fsm, 'DRIVING_EDITOR');
  assert.ok(r2.outputs.some(o => o.type === 'resolveFromCursor' && o.line === 7));
});

// ── Math: legacy-compatible smoke (folded from alignment-math) ────────────
test('math.currentBlock at exact top returns that block', () => {
  assert.equal(math.currentBlock([0, 100, 200], 100), 1);
});
test('math.tickY computes block.top - scrollTop', () => {
  assert.equal(math.tickY(150, 30), 120);
});
test('math.lineFromClickY at block top → first line', () => {
  // click at y=0 inside a 5-line block of height 120, sourcepos L=10..14
  assert.equal(math.lineFromClickY(0, 120, 10, 14), 10);
});
test('math.lineFromClickY at block bottom → last line', () => {
  assert.equal(math.lineFromClickY(120, 120, 10, 14), 14);
});
