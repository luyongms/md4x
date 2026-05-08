// Run: node --test crates/md4x-gui/frontend/tests/preview-highlight.test.mjs
// Spec: docs/spec/v0.2.5-search-replace.md § 6.1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from '../../cm6-build/node_modules/jsdom/lib/api.js';
const ph = createRequire(import.meta.url)('../preview-highlight.js');

// ── Pure: findMatches ──────────────────────────────────────────────────────

test('findMatches: empty query → []', () => {
  assert.deepEqual(ph.findMatches('foo bar', '', {}), []);
  assert.deepEqual(ph.findMatches('foo bar', null, {}), []);
});

test('findMatches: empty text → []', () => {
  assert.deepEqual(ph.findMatches('', 'foo', {}), []);
  assert.deepEqual(ph.findMatches(null, 'foo', {}), []);
});

test('findMatches: literal, case-insensitive default', () => {
  assert.deepEqual(ph.findMatches('Foo bar foo', 'foo', {}), [[0, 3], [8, 11]]);
});

test('findMatches: literal, case-sensitive', () => {
  assert.deepEqual(
    ph.findMatches('Foo bar foo', 'foo', { caseSensitive: true }),
    [[8, 11]],
  );
});

test('findMatches: whole-word excludes substrings', () => {
  assert.deepEqual(
    ph.findMatches('foo foobar foo', 'foo', { wholeWord: true }),
    [[0, 3], [11, 14]],
  );
});

test('findMatches: regex flag', () => {
  assert.deepEqual(
    ph.findMatches('foo fxo bar', 'f.o', { regex: true }),
    [[0, 3], [4, 7]],
  );
});

test('findMatches: regex with case-sensitive flag', () => {
  assert.deepEqual(
    ph.findMatches('Foo foo', 'foo', { regex: true, caseSensitive: true }),
    [[4, 7]],
  );
});

test('findMatches: invalid regex returns []', () => {
  assert.deepEqual(ph.findMatches('foo', '[unclosed', { regex: true }), []);
});

test('findMatches: zero-width regex match does not infinite-loop', () => {
  // Empty alternation — must terminate.
  const out = ph.findMatches('abc', 'a|', { regex: true });
  assert.ok(Array.isArray(out));
});

// ── DOM walker ─────────────────────────────────────────────────────────────

function makeDoc(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  return dom.window.document;
}

test('walkBuildRanges: empty query → []', () => {
  const doc = makeDoc('<p>foo</p>');
  assert.deepEqual(ph.walkBuildRanges(doc, '', {}), []);
});

test('walkBuildRanges: plain prose match → 1 Range', () => {
  const doc = makeDoc('<p>say foo loud</p>');
  const ranges = ph.walkBuildRanges(doc, 'foo', {});
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].toString(), 'foo');
});

test('walkBuildRanges: skips matches inside <svg>', () => {
  const doc = makeDoc(
    '<p>before foo prose</p>' +
    '<svg><text>foo in svg</text></svg>' +
    '<p>after foo prose</p>',
  );
  const ranges = ph.walkBuildRanges(doc, 'foo', {});
  assert.equal(ranges.length, 2);
  for (const r of ranges) assert.equal(r.toString(), 'foo');
});

test('walkBuildRanges: skips matches inside .katex', () => {
  const doc = makeDoc(
    '<p>x foo y</p>' +
    '<span class="katex"><span>foo inside math</span></span>',
  );
  assert.equal(ph.walkBuildRanges(doc, 'foo', {}).length, 1);
});

test('walkBuildRanges: skips matches inside [data-md4x-no-highlight]', () => {
  const doc = makeDoc(
    '<p>foo here</p>' +
    '<div data-md4x-no-highlight>foo skipped</div>',
  );
  assert.equal(ph.walkBuildRanges(doc, 'foo', {}).length, 1);
});

test('walkBuildRanges: skips <canvas> descendants', () => {
  const doc = makeDoc(
    '<p>visible foo</p><canvas><span>foo hidden</span></canvas>',
  );
  assert.equal(ph.walkBuildRanges(doc, 'foo', {}).length, 1);
});

test('walkBuildRanges: counts respect prose vs svg split (M < N case)', () => {
  const doc = makeDoc(
    '<p>foo one</p><p>foo two</p><svg><text>foo three</text></svg>',
  );
  const ranges = ph.walkBuildRanges(doc, 'foo', {});
  assert.equal(ranges.length, 2);
});

test('walkBuildRanges: case-sensitive flag honored', () => {
  const doc = makeDoc('<p>Foo and foo</p>');
  const ranges = ph.walkBuildRanges(doc, 'foo', { caseSensitive: true });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].toString(), 'foo');
});

test('walkBuildRanges: whole-word flag honored', () => {
  const doc = makeDoc('<p>foo foobar</p>');
  const ranges = ph.walkBuildRanges(doc, 'foo', { wholeWord: true });
  assert.equal(ranges.length, 1);
});

test('walkBuildRanges: regex flag honored', () => {
  const doc = makeDoc('<p>foo and fxo</p>');
  const ranges = ph.walkBuildRanges(doc, 'f.o', { regex: true });
  assert.equal(ranges.length, 2);
});

// ── update() / state queries ───────────────────────────────────────────────

test('update + countVisible + hasRangeForOrdinal', () => {
  const doc = makeDoc(
    '<p>foo a</p><p>foo b</p><svg><text>foo c</text></svg>',
  );
  ph.update(doc, 'foo', {}, 0);
  assert.equal(ph.countVisible(), 2);
  assert.equal(ph.hasRangeForOrdinal(0), true);
  assert.equal(ph.hasRangeForOrdinal(1), true);
  assert.equal(ph.hasRangeForOrdinal(2), false);
  assert.equal(ph.hasRangeForOrdinal(-1), false);
});

test('update with empty query clears state', () => {
  const doc = makeDoc('<p>foo</p>');
  ph.update(doc, 'foo', {}, 0);
  assert.equal(ph.countVisible(), 1);
  ph.update(doc, '', {}, -1);
  assert.equal(ph.countVisible(), 0);
  assert.equal(ph.hasRangeForOrdinal(0), false);
});

test('clear() resets state', () => {
  const doc = makeDoc('<p>foo</p>');
  ph.update(doc, 'foo', {}, 0);
  assert.equal(ph.countVisible(), 1);
  ph.clear();
  assert.equal(ph.countVisible(), 0);
});

test('feature-detect: no CSS.highlights → update() still tracks ranges, no throw', () => {
  // jsdom has no CSS.highlights; this is the fallback path.
  const doc = makeDoc('<p>foo bar foo</p>');
  ph.update(doc, 'foo', {}, 0);
  // Range tracking still works for counter / pill — just no paint.
  assert.equal(ph.countVisible(), 2);
});
