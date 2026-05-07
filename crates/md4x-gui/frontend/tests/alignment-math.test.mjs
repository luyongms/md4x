// Run: node --test crates/md4x-gui/frontend/tests/
// Spec: docs/spec/v0.2.3-scroll-alignment-ticks.md § 6.1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = require('../alignment-math.js');

const SUB_OFFSET_THRESHOLD = 4;

// Common fixture: 5 blocks at y = 0, 100, 200, 350, 500 (heights vary).
const TOPS = [0, 100, 200, 350, 500];

test('current_block_when_scroll_above_first → returns 0', () => {
  assert.equal(m.currentBlock(TOPS, -50), 0);
  assert.equal(m.currentBlock(TOPS, -1), 0);
});

test('current_block_when_scroll_inside_block_n → returns n', () => {
  assert.equal(m.currentBlock(TOPS, 0),   0);
  assert.equal(m.currentBlock(TOPS, 50),  0);
  assert.equal(m.currentBlock(TOPS, 100), 1);
  assert.equal(m.currentBlock(TOPS, 150), 1);
  assert.equal(m.currentBlock(TOPS, 250), 2);
  assert.equal(m.currentBlock(TOPS, 499), 3);
  assert.equal(m.currentBlock(TOPS, 500), 4);
  assert.equal(m.currentBlock(TOPS, 9999), 4);
});

test('current_block_at_exact_block_top → returns that block (≤ semantics)', () => {
  assert.equal(m.currentBlock(TOPS, 100), 1);
  assert.equal(m.currentBlock(TOPS, 200), 2);
  assert.equal(m.currentBlock(TOPS, 350), 3);
});

test('current_block_empty → returns -1', () => {
  assert.equal(m.currentBlock([], 0), -1);
  assert.equal(m.currentBlock(null, 0), -1);
});

test('tick_y_inside_strip → Y = block.top − scrollTop', () => {
  assert.equal(m.tickY(100, 30), 70);
  assert.equal(m.tickY(0, 0), 0);
  assert.equal(m.tickY(500, 200), 300);
});

test('tick_y_clamp_when_block_above_viewport → Y = 0', () => {
  assert.equal(m.tickYClampedForCurrent(100, 150, 800), 0); // block above
  assert.equal(m.tickYClampedForCurrent(100, 100, 800), 0); // block at top
  assert.equal(m.tickYClampedForCurrent(100, 50,  800), 50); // block below scrollTop
});

test('tick_y_clamp_when_block_below_strip → Y = stripHeight', () => {
  assert.equal(m.tickYClampedForCurrent(1000, 0, 800), 800);
});

test('drift_detect_ordinal_mismatch → drift = true', () => {
  // Driver at block 2 (scrollTop = 250), follower at block 1 (scrollTop = 150)
  assert.equal(
    m.hasDrift(TOPS, 250, TOPS, 150, SUB_OFFSET_THRESHOLD),
    true
  );
});

test('drift_detect_sub_offset_4px_threshold', () => {
  // Both at block 2, driver subOffset=50, follower subOffset=53 → diff=3, no drift
  assert.equal(
    m.hasDrift(TOPS, 250, TOPS, 253, SUB_OFFSET_THRESHOLD),
    false
  );
  // Both at block 2, driver subOffset=50, follower subOffset=55 → diff=5, drift
  assert.equal(
    m.hasDrift(TOPS, 250, TOPS, 255, SUB_OFFSET_THRESHOLD),
    true
  );
  // Exactly at threshold → no drift (strict >)
  assert.equal(
    m.hasDrift(TOPS, 250, TOPS, 254, SUB_OFFSET_THRESHOLD),
    false
  );
});

test('drift_with_different_top_arrays_same_ordinal_aligned', () => {
  // Editor blocks at one set of Ys, preview at another, both currently
  // looking at block 2 with same sub-offset relative to block top.
  const eTops = [0, 80,  160, 280, 400];
  const pTops = [0, 100, 200, 350, 500];
  // Editor scroll = 200 → block 2, subOffset = 40
  // Preview scroll = 240 → block 2, subOffset = 40
  assert.equal(m.hasDrift(eTops, 200, pTops, 240, SUB_OFFSET_THRESHOLD), false);
  // Preview scroll = 250 → subOffset = 50, diff = 10 → drift
  assert.equal(m.hasDrift(eTops, 200, pTops, 250, SUB_OFFSET_THRESHOLD), true);
});

test('correction_target_same_ordinal_diff_offset', () => {
  // Driver at block 2, scrollTop 240 → subOffset 40.
  // Follower's block 2 is at top=200 → target = 200 + 40 = 240.
  assert.equal(m.correctionTarget(TOPS, 240, TOPS), 240);
});

test('correction_target_different_top_arrays', () => {
  const eTops = [0, 80,  160, 280, 400];
  const pTops = [0, 100, 200, 350, 500];
  // Driver = editor at scroll 200 → block 2, subOffset 40.
  // Follower target = pTops[2] + 40 = 240.
  assert.equal(m.correctionTarget(eTops, 200, pTops), 240);
});

test('correction_target_clamps_when_follower_shorter', () => {
  // Driver has 5 blocks, follower only 3. If driver is at block 4,
  // follower can't match — return follower's last top.
  assert.equal(m.correctionTarget(TOPS, 510, [0, 100, 200]), 200);
});

test('is_heading_kind: editor lezer names', () => {
  assert.equal(m.isHeadingKind('ATXHeading1'), true);
  assert.equal(m.isHeadingKind('ATXHeading6'), true);
  assert.equal(m.isHeadingKind('SetextHeading1'), true);
  assert.equal(m.isHeadingKind('SetextHeading2'), true);
  assert.equal(m.isHeadingKind('Paragraph'), false);
  assert.equal(m.isHeadingKind('FencedCode'), false);
  assert.equal(m.isHeadingKind('Blockquote'), false);
  assert.equal(m.isHeadingKind('HTMLBlock'), false);
});

test('is_heading_kind: preview tag names', () => {
  assert.equal(m.isHeadingKind('H1'), true);
  assert.equal(m.isHeadingKind('H6'), true);
  assert.equal(m.isHeadingKind('P'), false);
  assert.equal(m.isHeadingKind('DIV'), false);
  assert.equal(m.isHeadingKind('admonish'), false);
  assert.equal(m.isHeadingKind(''), false);
  assert.equal(m.isHeadingKind(null), false);
  assert.equal(m.isHeadingKind(undefined), false);
});
