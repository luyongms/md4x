// preview-highlight.js — non-destructive search highlight for the preview
// iframe via CSS Custom Highlight API. Spec: docs/spec/v0.2.5-search-replace.md
//
// Two surfaces:
//   - pure findMatches(text, query, flags) — testable, no DOM.
//   - walkBuildRanges(doc, query, flags) — walker that builds Range[]
//     skipping <svg>, <canvas>, .katex*, [data-md4x-no-highlight].
// CSS Custom Highlight registration is feature-detected and best-effort;
// tests run in jsdom (no Highlight API) and exercise everything else.

'use strict';

const SKIP_SELECTOR =
  'svg, canvas, .katex, .katex-display, [data-md4x-no-highlight]';

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatches(text, query, flags) {
  if (!text || !query) return [];
  flags = flags || {};
  const out = [];
  if (flags.regex) {
    let re;
    try {
      re = new RegExp(query, flags.caseSensitive ? 'g' : 'gi');
    } catch (_) {
      return [];
    }
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      if (guard++ > text.length * 2 + 4) break;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }
  if (flags.wholeWord) {
    let re;
    try {
      re = new RegExp('\\b' + escRegex(query) + '\\b',
                      flags.caseSensitive ? 'g' : 'gi');
    } catch (_) { return []; }
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }
  const hay = flags.caseSensitive ? text : text.toLowerCase();
  const needle = flags.caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    out.push([i, i + needle.length]);
    i += needle.length;
  }
  return out;
}

function walkBuildRanges(doc, query, flags) {
  if (!doc || !query) return [];
  const body = doc.body;
  if (!body) return [];
  const NF = (doc.defaultView && doc.defaultView.NodeFilter) ||
             (typeof NodeFilter !== 'undefined' ? NodeFilter : null);
  if (!NF) return [];
  const walker = doc.createTreeWalker(body, NF.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NF.FILTER_REJECT;
      if (p.closest && p.closest(SKIP_SELECTOR)) return NF.FILTER_REJECT;
      return NF.FILTER_ACCEPT;
    },
  });
  const ranges = [];
  let n;
  while ((n = walker.nextNode())) {
    const matches = findMatches(n.nodeValue, query, flags);
    for (const [s, e] of matches) {
      const r = doc.createRange();
      r.setStart(n, s);
      r.setEnd(n, e);
      ranges.push(r);
    }
  }
  return ranges;
}

function getOrCreateHighlights(win) {
  if (!win) return null;
  const CSS_ = win.CSS;
  if (!CSS_ || !CSS_.highlights || typeof win.Highlight === 'undefined') {
    return null;
  }
  if (!win.__md4xHl) {
    win.__md4xHl = new win.Highlight();
    CSS_.highlights.set('md4x-search', win.__md4xHl);
  }
  if (!win.__md4xHlActive) {
    win.__md4xHlActive = new win.Highlight();
    CSS_.highlights.set('md4x-search-active', win.__md4xHlActive);
  }
  return { hl: win.__md4xHl, hlA: win.__md4xHlActive };
}

function clearWinHighlights(win) {
  if (!win) return;
  if (win.__md4xHl && typeof win.__md4xHl.clear === 'function') {
    win.__md4xHl.clear();
  }
  if (win.__md4xHlActive && typeof win.__md4xHlActive.clear === 'function') {
    win.__md4xHlActive.clear();
  }
}

let _ranges = [];
let _query = '';
let _flags = {};
let _activeOrdinal = -1;

function update(doc, query, flags, activeOrdinal) {
  _query = query || '';
  _flags = flags || {};
  _activeOrdinal = (typeof activeOrdinal === 'number') ? activeOrdinal : -1;
  if (!doc) { _ranges = []; return; }

  const win = doc.defaultView || null;
  clearWinHighlights(win);

  if (!_query) { _ranges = []; return; }

  _ranges = walkBuildRanges(doc, _query, _flags);

  const hls = getOrCreateHighlights(win);
  if (hls) {
    for (const r of _ranges) hls.hl.add(r);
    if (_activeOrdinal >= 0 && _activeOrdinal < _ranges.length) {
      hls.hlA.add(_ranges[_activeOrdinal]);
    }
  }
}

function clear() {
  _ranges = [];
  _query = '';
  _flags = {};
  _activeOrdinal = -1;
}

function countVisible() { return _ranges.length; }

function hasRangeForOrdinal(k) {
  return typeof k === 'number' && k >= 0 && k < _ranges.length;
}

const api = {
  findMatches,
  walkBuildRanges,
  update,
  clear,
  countVisible,
  hasRangeForOrdinal,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.md4xPreviewHighlight = api;
}
