// md4x v0.2.1 — chrome polish + syntax highlighting

// ── Tauri IPC ───────────────────────────────────────────────────────────────
function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// ── patchDOM (morphdom-lite, hash-skip) ──────────────────────────────────────
function patchDOM(from, to) {
  if (from.nodeType !== to.nodeType) {
    from.parentNode.replaceChild(to.cloneNode(true), from);
    return;
  }
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from.nodeType !== 1) return;
  if (from.tagName !== to.tagName) {
    from.parentNode.replaceChild(to.cloneNode(true), from);
    return;
  }
  const fromHash = from.dataset && from.dataset.md4xHash;
  const toHash = to.dataset && to.dataset.md4xHash;
  if (fromHash && toHash && fromHash === toHash) return;
  for (const {name, value} of to.attributes) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const {name} of Array.from(from.attributes)) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  const fc = Array.from(from.childNodes);
  const tc = Array.from(to.childNodes);
  const len = Math.max(fc.length, tc.length);
  for (let i = 0; i < len; i++) {
    if (i >= tc.length) {
      from.removeChild(fc[i]);
    } else if (i >= fc.length) {
      from.appendChild(tc[i].cloneNode(true));
    } else {
      patchDOM(fc[i], tc[i]);
    }
  }
}

// ── CodeMirror 6 setup ──────────────────────────────────────────────────────
// CM6 is loaded via vendor/cm6-bundle.js as a global window.MD4X_CM6. We
// instantiate one EditorView per session and use compartments to swap the
// theme on demand. Caret/selection/IME all handled by CM, so the textarea
// + overlay alignment problems are gone.
const CM = window.MD4X_CM6;
let cm = null;                     // EditorView instance (set in init)
const themeCompartment = new CM.Compartment();
function editorText() { return cm ? cm.state.doc.toString() : ''; }
function setEditorText(s) {
  if (!cm) return;
  cm.dispatch({
    changes: { from: 0, to: cm.state.doc.length, insert: s || '' },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
}
function md4xHighlightStyle() {
  const t = CM.t;
  return CM.HighlightStyle.define([
    { tag: t.heading,            color: 'var(--ed-heading)', fontWeight: '600' },
    { tag: t.heading1,           color: 'var(--ed-heading)', fontWeight: '700' },
    { tag: t.heading2,           color: 'var(--ed-heading)', fontWeight: '700' },
    { tag: t.heading3,           color: 'var(--ed-heading)', fontWeight: '600' },
    { tag: t.emphasis,           color: 'var(--ed-emphasis)', fontStyle: 'italic' },
    { tag: t.strong,             color: 'var(--ed-emphasis)', fontWeight: '700' },
    { tag: t.link,               color: 'var(--ed-link)' },
    { tag: t.url,                color: 'var(--ed-link)', textDecoration: 'underline' },
    { tag: t.monospace,          color: 'var(--ed-string)' },
    { tag: t.processingInstruction, color: 'var(--ed-keyword)' },
    { tag: t.contentSeparator,   color: 'var(--ed-keyword)' },
    { tag: t.list,               color: 'var(--ed-keyword)' },
    { tag: t.quote,              color: 'var(--ed-text-dim)', fontStyle: 'italic' },
    { tag: t.meta,               color: 'var(--ed-comment)' },
    { tag: t.comment,            color: 'var(--ed-comment)', fontStyle: 'italic' },
  ]);
}
function md4xBaseTheme() {
  return CM.EditorView.theme({
    '&': { height: '100%' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      fontFeatureSettings: '"liga" 0, "calt" 0',
      fontVariantLigatures: 'none',
    },
    '.cm-scroller': { fontFamily: 'var(--font-mono)' },
  });
}
function buildExtensions(onUpdate) {
  return [
    CM.lineNumbers(),
    CM.history(),
    CM.drawSelection(),
    CM.highlightActiveLine(),
    CM.highlightActiveLineGutter(),
    CM.bracketMatching(),
    CM.indentOnInput(),
    CM.keymap.of([
      ...CM.defaultKeymap,
      ...CM.historyKeymap,
      CM.indentWithTab,
    ]),
    // Custom search bar lives outside CM (full window width). We still
    // mount the search extension so the in-editor match decorations and
    // setSearchQuery / findNext / replaceAll commands are available.
    CM.search({ top: true }),
    CM.markdown(),
    CM.syntaxHighlighting(md4xHighlightStyle()),
    md4xBaseTheme(),
    themeCompartment.of([]),
    CM.EditorView.lineWrapping,
    CM.EditorView.updateListener.of(onUpdate),
  ];
}
function mountEditor(initialText, onUpdate) {
  const state = CM.EditorState.create({
    doc: initialText || '',
    extensions: buildExtensions(onUpdate),
  });
  cm = new CM.EditorView({
    state,
    parent: document.getElementById('editor-mount'),
  });
  return cm;
}

// ── State ────────────────────────────────────────────────────────────────────
let currentTemplate = 'magazine';
let availableTemplates = [];
let activeFrame = 'a';
let renderTimer = null;
let bootstrapped = false;
let currentFilePath = null;
let isDirty = false;
let lastRenderMs = 0;
let lastUserMacrosJson = '';   // last user_macros JSON applied to iframe

// ── Settings ────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'md4x.settings.v1';
const SETTINGS_DEFAULTS = {
  defaultTemplate: 'magazine',
  debounceMs: 250,
  zoomPct: 100,
  theme: 'dark',
  revealOnExport: true,
};
let settings = { ...SETTINGS_DEFAULTS };
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const iframeA      = document.getElementById('preview-a');
const iframeB      = document.getElementById('preview-b');
const filenameEl   = document.getElementById('filename');
const unsavedEl    = document.getElementById('unsaved');
const exportBtn    = document.getElementById('export-btn');
const templateBtn  = document.getElementById('template-btn');
const templateName = document.getElementById('template-name');
const tmplStatus   = document.getElementById('status-template');
const countsEl     = document.getElementById('status-counts');
const renderTimeEl = document.getElementById('sb-render-time');
const pulseEl      = document.getElementById('sb-pulse');
const savedDotEl   = document.getElementById('sb-saved-dot');
const welcome      = document.getElementById('welcome');
const dropzone     = document.getElementById('dropzone');
const newDraftBtn  = document.getElementById('new-draft-btn');
const openFileBtn  = document.getElementById('open-file-btn');
const welcomeClose = document.getElementById('welcome-close');
const recentList   = document.getElementById('recent-list');
const gallery      = document.getElementById('gallery');
const galleryGrid  = document.getElementById('gallery-grid');
const galleryClose = document.getElementById('gallery-close');
const confirmEl    = document.getElementById('confirm');
const confirmSave    = document.getElementById('confirm-save');
const confirmDiscard = document.getElementById('confirm-discard');
const confirmCancel  = document.getElementById('confirm-cancel');
const settingsEl   = document.getElementById('settings');
const settingsBtn  = document.getElementById('settings-btn');
const exportDialog = document.getElementById('export-dialog');
const exportName   = document.getElementById('export-name');
const exportWhereBtn  = document.getElementById('export-where-btn');
const exportWherePath = document.getElementById('export-where-path');
const exportTemplate  = document.getElementById('export-template');
const exportGo     = document.getElementById('export-go');
const setDefaultTemplate = document.getElementById('set-default-template');
const setDebounce  = document.getElementById('set-debounce');
const setDebounceVal = document.getElementById('set-debounce-val');
const setZoom      = document.getElementById('set-zoom');
const setZoomVal   = document.getElementById('set-zoom-val');
const setReveal    = document.getElementById('set-reveal');

function activeIframe()   { return activeFrame === 'a' ? iframeA : iframeB; }
function inactiveIframe() { return activeFrame === 'a' ? iframeB : iframeA; }
function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// ── Status bar / dirty / title ──────────────────────────────────────────────
function setStatusTime(ms) {
  if (ms > 0) renderTimeEl.textContent = `${Math.round(ms)} ms`;
  else        renderTimeEl.textContent = '';
}
function pulseRender() {
  pulseEl.classList.remove('pulsing');
  // Trigger reflow so the animation re-runs.
  void pulseEl.offsetWidth;
  pulseEl.classList.add('pulsing');
}

function updateCounts() {
  const text = editorText();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const mermaidCount = (text.match(/^```mermaid\b/gm) || []).length;
  const inlineMath = (text.match(/(?<!\$)\$[^$\n]+?\$(?!\$)/g) || []).length;
  const displayMath = (text.match(/\$\$[\s\S]+?\$\$/g) || []).length;
  const mathCount = inlineMath + displayMath;
  const parts = [`${words} word${words !== 1 ? 's' : ''}`];
  if (mermaidCount) parts.push(`${mermaidCount} mermaid`);
  if (mathCount) parts.push(`${mathCount} math`);
  countsEl.textContent = parts.join(' · ');
}

// ── Bidirectional scroll sync (block-aligned) ───────────────────────────────
// We map TOP-LEVEL SEMANTIC BLOCKS between sides:
//   editor side: top-level children of the lezer-markdown Document tree
//                (Paragraph, ATXHeading*, FencedCode, Blockquote, lists, …)
//   preview side: top-level children of <body>, with admonish wrappers
//                coalesced — the admonish preprocessor expands one fence into
//                <html-open><body blocks><html-close>, so we collapse the run
//                back into a single logical block to preserve k-th alignment.
//
// Validated on 15 synthesized fixtures (text + math + mermaid + code +
// admonish + numthm + mixed) under scratch/sync-probe/. Naive ordinal works
// once admonish is coalesced; everything else (numthm, KaTeX, mermaid,
// fenced code) preserves block count between lezer and comrak.
//
// Bounce-back avoidance: when we programmatically scroll either side, the
// resulting scroll event would ping back and re-sync the source. We track
// the last scroll position we WROTE to each side and ignore matches.
let editorExpected  = null;
let previewExpected = null;
// Smooth-scroll lockout: when we initiate `behavior: 'smooth'` the browser
// fires dozens of intermediate scroll events as the animation runs, each
// at a different scrollY that won't equal `previewExpected`. A short
// time-based lockout swallows all of them; after it expires the exact-
// position check takes over again.
let editorLockUntil  = 0;
let previewLockUntil = 0;
// Bumped from 2 → 6: large jumps (fast scroll, programmatic scrollTo on
// long docs) can land 3–5px off due to fractional-pixel rounding inside
// WebKit. Too-tight tolerance turned bounce-back events into "real" user
// scrolls and triggered feedback loops.
const SCROLL_TOLERANCE_PX = 6;
// WebKit's smooth-scroll animation is ~280ms. Anything longer eats into
// the user's window for following up with their own scroll.
const SMOOTH_LOCKOUT_MS = 300;

// Top-level lezer blocks in the current editor doc, with HTML-wrapper
// coalesce so the count matches what the browser materialises in the
// preview iframe. lezer treats `<div>...<blank>...md...<blank>...</div>`
// as 3 sibling blocks (HTMLBlock, Paragraph, HTMLBlock); the browser
// builds 1 element. We balance block-level open/close tags and merge
// siblings until the run is balanced.
let _lezerBlocksCache = { docVer: -1, blocks: null };
const _BLOCK_HTML_TAGS = ["div", "details", "section", "article", "aside",
                          "header", "footer", "nav", "blockquote", "figure"];
const _TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)\s*>/g;
function _tagBalance(text) {
  let net = 0;
  for (const m of text.matchAll(_TAG_RE)) {
    const tag = m[2].toLowerCase();
    if (_BLOCK_HTML_TAGS.indexOf(tag) === -1) continue;
    if (m[3] === '/') continue;
    if (m[1] === '/') net--; else net++;
  }
  return net;
}
// Cached lezer-markdown parser (the LanguageSupport built once and reused).
// Using parser.parse() directly is SYNCHRONOUS and complete, unlike
// CM.syntaxTree(state) which returns the incremental parse — for large
// docs (1000+ blocks) the incremental tree is partial and silently under-
// counts top-level children, breaking ordinal alignment.
let _mdParser = null;
function getLezerBlocks() {
  if (!cm) return [];
  const ver = cm.state.doc.length + ':' + cm.state.doc.lineCount;
  if (_lezerBlocksCache.docVer === ver) return _lezerBlocksCache.blocks;
  if (!_mdParser) {
    try { _mdParser = CM.markdown().language.parser; }
    catch (_) { return []; }
  }
  const text = cm.state.doc.toString();
  const tree = _mdParser.parse(text);
  const raw = [];
  const cur = tree.cursor();
  if (cur.firstChild()) {
    do {
      // CommentBlock (HTML comments) have no DOM element counterpart —
      // browser parses them as comment nodes, which are not in
      // body.children. Skip on the editor side to keep ordinal alignment.
      if (cur.name === 'CommentBlock') continue;
      raw.push({ from: cur.from, to: cur.to, kind: cur.name });
    } while (cur.nextSibling());
  }
  // Coalesce unbalanced HTMLBlock runs with following siblings.
  const blocks = [];
  let i = 0;
  while (i < raw.length) {
    const b = raw[i];
    if (b.kind !== 'HTMLBlock') { blocks.push(b); i++; continue; }
    let net = _tagBalance(cm.state.doc.sliceString(b.from, b.to));
    if (net <= 0) { blocks.push(b); i++; continue; }
    let j = i + 1;
    while (j < raw.length && net > 0) {
      net += _tagBalance(cm.state.doc.sliceString(raw[j].from, raw[j].to));
      j++;
    }
    if (net !== 0) { blocks.push(b); i++; continue; }
    blocks.push({ from: b.from, to: raw[j - 1].to, kind: 'HTMLBlock' });
    i = j;
  }
  _lezerBlocksCache = { docVer: ver, blocks };
  return blocks;
}

// Top-level preview blocks, with admonish coalesce. Each returned block
// carries the actual DOM element to scroll to (the wrapper for admonish).
function getPreviewBlocks(doc) {
  if (!doc || !doc.body) return [];
  const out = [];
  for (const el of doc.body.children) {
    if (el.nodeType !== 1) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    const cls = (el.className || '') + '';
    if (/\bcover-page\b/.test(cls)) continue;
    const isAdmonish = (tag === 'DIV' || tag === 'DETAILS') &&
                       /\badmonish\b/.test(cls);
    // Comrak attaches data-sourcepos to every authored block-level element.
    // Runtime-injected chrome (mermaid CSS holders, katex display wrappers
    // hoisted to body, etc.) does not. Admonish OUTER wrappers are
    // preprocessor-emitted HTML so they have no sourcepos but ARE authored
    // content — keep them. Otherwise require data-sourcepos.
    if (!isAdmonish && !el.hasAttribute('data-sourcepos')) continue;
    out.push({ el, kind: isAdmonish ? 'admonish' : tag });
  }
  return out;
}

// Find the lezer block index that contains a given doc position.
function lezerBlockIndexAtPos(blocks, pos) {
  if (!blocks.length) return -1;
  for (let i = 0; i < blocks.length; i++) {
    if (pos < blocks[i].from) return Math.max(0, i - 1);
    if (pos <= blocks[i].to) return i;
  }
  return blocks.length - 1;
}

// Document-Y of an element inside the preview iframe. offsetTop lies when
// the cover-page is position: absolute / fixed (the H1 reports top:0 even
// though the cover sits above it). getBoundingClientRect + scrollY gives
// the true Y in document coordinates.
function elDocTop(el, win) {
  return el.getBoundingClientRect().top + win.scrollY;
}

// Per-render cache of (blocks, doc-top Ys). Without this, every scroll
// event called getBoundingClientRect on each of N preview blocks (1000+
// in long docs), forcing N synchronous layouts. Under fast preview scroll
// the handler couldn't keep up — events queued, the bounce-back machinery
// got out of phase, and the editor stopped tracking. Invalidated on each
// applyRender via invalidatePreviewBlocksCache().
let _previewBlocksCache = { iframe: null, blocks: null, tops: null, scrollHeight: 0 };
function invalidatePreviewBlocksCache() {
  _previewBlocksCache = { iframe: null, blocks: null, tops: null, scrollHeight: 0 };
}
function getPreviewBlocksCached(iframe) {
  // Stale-detect: doc layout grew/shrank between renders (mermaid/katex
  // finished after applyRender, or async font load shifted blocks).
  // ResizeObserver covers most cases via schedulePreviewCacheInvalidate,
  // but on huge docs the 150 ms debounce can lag a snap-to-end jump.
  if (_previewBlocksCache.iframe === iframe && _previewBlocksCache.blocks) {
    const win = iframe.contentWindow;
    const sh  = win && win.document && win.document.documentElement.scrollHeight;
    if (sh && Math.abs(sh - _previewBlocksCache.scrollHeight) <= 2) {
      return _previewBlocksCache;
    }
  }
  const win = iframe.contentWindow;
  const doc = win && win.document;
  const blocks = getPreviewBlocks(doc);
  const tops = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) tops[i] = elDocTop(blocks[i].el, win);
  const scrollHeight = doc && doc.documentElement ? doc.documentElement.scrollHeight : 0;
  _previewBlocksCache = { iframe, blocks, tops, scrollHeight };
  return _previewBlocksCache;
}

// Binary search: largest i such that tops[i] <= scrollY + 4.
function previewBlockIndexAtScroll(tops, scrollY) {
  if (!tops.length) return -1;
  const target = scrollY + 4;
  let lo = 0, hi = tops.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// Clamp `y` into [0, scrollMax] for the given window so previewExpected
// matches what the browser will ACTUALLY scroll to. Without this, if y
// exceeds documentElement.scrollHeight - innerHeight, win.scrollTo silently
// clamps but previewExpected holds the unclamped value — the bounce-back
// event then comes in with a different scrollY, fails consumeExpectedScroll,
// and triggers syncEditorFromPreview, which kicks the editor back. Cue the
// feedback loop that lands the preview at end-of-doc on fast editor scroll.
function clampPreviewY(win, y) {
  const max = Math.max(0, win.document.documentElement.scrollHeight - win.innerHeight);
  return Math.max(0, Math.min(y, max));
}
function clampEditorY(sd, y) {
  const max = Math.max(0, sd.scrollHeight - sd.clientHeight);
  return Math.max(0, Math.min(y, max));
}

// Visual-position match: place the matching preview block at the SAME
// vertical offset within the preview viewport as the editor block sits in
// the editor viewport. Otherwise the preview block always lands at the
// preview's top regardless of where the editor block actually appears.
function editorBlockYInViewport(blockFromPos, sd) {
  try {
    const c = cm.coordsAtPos(blockFromPos);
    if (!c) return 0;
    return c.top - sd.getBoundingClientRect().top;
  } catch (_) { return 0; }
}

function syncPreviewFromEditor() {
  if (!cm || isSyncSuspended()) return;
  const iframe = activeIframe();
  const win = iframe.contentWindow;
  if (!win || !win.document || !win.document.body) return;
  const sd = cm.scrollDOM;
  const lBlocks = getLezerBlocks();
  const cache = getPreviewBlocksCached(iframe);
  if (!lBlocks.length || !cache.blocks.length) return;
  // Editor anchor: which doc position is at the top of the viewport.
  // Clamp scrollTop into the valid range — fast trackpad / momentum
  // scrolls can transiently report values past scrollMax, which makes
  // lineBlockAtHeight return the last line and pins us at doc end.
  const sy = clampEditorY(sd, sd.scrollTop);
  let topPos;
  try {
    const info = cm.lineBlockAtHeight(sy);
    topPos = info && info.from != null ? info.from : 0;
  } catch (_) { topPos = 0; }
  const k = lezerBlockIndexAtPos(lBlocks, topPos);
  const idx = Math.min(k, cache.blocks.length - 1);
  if (idx < 0) return;
  // Where does this block START in the editor viewport? Subtract that from
  // the preview block's doc-Y so it lands at the same viewport offset.
  const blockYInView = editorBlockYInViewport(lBlocks[k].from, sd);
  let target = clampPreviewY(win, cache.tops[idx] - blockYInView);
  // First-block special case: keep cover-page (and any other above-block-0
  // chrome) visible when the editor is scrolled to its very top.
  if (k === 0 && sd.scrollTop <= 4) target = 0;
  previewExpected = Math.round(target);
  win.scrollTo(0, target);
}

// Sync suspension: during splitter drag and active window resize, layout
// is in flux every frame and any sync attempt would either fight the user
// (programmatic scroll while they drag) or burn CPU on stale measurements.
// suspendSync() can be called any number of times — each call extends the
// release deadline. After `windowMs` of quiet, sync is automatically
// resumed and the preview cache is invalidated so the next sync rebuilds.
let _syncSuspendedUntil = 0;
function isSyncSuspended() { return Date.now() < _syncSuspendedUntil; }
let _syncResumeTimer = null;
function suspendSync(windowMs = 200) {
  _syncSuspendedUntil = Math.max(_syncSuspendedUntil, Date.now() + windowMs);
  if (_syncResumeTimer) clearTimeout(_syncResumeTimer);
  _syncResumeTimer = setTimeout(() => {
    _syncResumeTimer = null;
    invalidatePreviewBlocksCache();
  }, windowMs + 20);
}

// Parse comrak's `data-sourcepos="L1:C1-L2:C2"` into [L1, L2] (1-based).
// Returns null if absent / malformed (e.g. admonish wrappers without
// sourcepos). Caller falls back to block-top anchoring when null.
function parseSourcepos(el) {
  if (!el || !el.dataset) return null;
  const sp = el.dataset.sourcepos;
  if (!sp) return null;
  const m = sp.match(/^(\d+):\d+-(\d+):\d+$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

// Cursor-anchored sync (line-level, v0.2.4): find cursor's lezer block,
// interpolate the cursor's source line within the matching preview
// block by `data-sourcepos`, and place that interpolated Y at the same
// viewport offset as the cursor line in the editor. Falls back to
// block-top alignment if the preview block lacks sourcepos.
function syncPreviewFromCursor() {
  if (!cm || isSyncSuspended()) return;
  const iframe = activeIframe();
  const win = iframe.contentWindow;
  if (!win || !win.document || !win.document.body) return;
  const lBlocks = getLezerBlocks();
  const cache = getPreviewBlocksCached(iframe);
  if (!lBlocks.length || !cache.blocks.length) return;
  const head = cm.state.selection.main.head;
  const k = lezerBlockIndexAtPos(lBlocks, head);
  const idx = Math.min(k, cache.blocks.length - 1);
  if (idx < 0) return;

  // Cursor line (1-based) in source.
  const cursorLine = cm.state.doc.lineAt(head).number;

  // Editor: cursor's line viewport-Y (cursor is always rendered).
  const sd = cm.scrollDOM;
  const sdRect = sd.getBoundingClientRect();
  let cursorYInView;
  try {
    const c = cm.coordsAtPos(head);
    cursorYInView = c ? (c.top - sdRect.top) : 0;
  } catch (_) { cursorYInView = 0; }

  // Preview: live block element top + height. Live read avoids stale
  // tops from mermaid/katex async layout.
  const blockEl = cache.blocks[idx].el;
  const liveTop = elDocTop(blockEl, win);
  const blockHeight = blockEl.offsetHeight;
  const sp = parseSourcepos(blockEl);
  let previewLineDocY;
  if (sp && sp[1] >= sp[0]) {
    previewLineDocY = window.md4xAlignmentMath.lineYInBlock(
      cursorLine, sp[0], sp[1], liveTop, blockHeight
    );
  } else {
    previewLineDocY = liveTop;
  }

  let target = clampPreviewY(win, previewLineDocY - cursorYInView);
  // Special case: cursor at FIRST block → reveal cover-page chrome.
  if (k === 0) target = 0;
  previewExpected = Math.round(target);
  previewLockUntil = Date.now() + SMOOTH_LOCKOUT_MS;
  win.scrollTo({ top: target, left: 0, behavior: 'smooth' });
}

function syncEditorFromPreview(win) {
  if (!cm || isSyncSuspended()) return;
  if (!win || !win.document || !win.document.body) return;
  const iframe = activeIframe();
  if (iframe.contentWindow !== win) return;
  const sd = cm.scrollDOM;
  const lBlocks = getLezerBlocks();
  const cache = getPreviewBlocksCached(iframe);
  if (!lBlocks.length || !cache.blocks.length) return;
  const k = previewBlockIndexAtScroll(cache.tops, win.scrollY);
  const idx = Math.min(k, lBlocks.length - 1);
  if (idx < 0) return;
  const fromPos = lBlocks[idx].from;
  // Where does the preview's anchor block sit in the preview viewport?
  // Preserve that same offset on the editor side.
  const previewBlockYInView = cache.tops[k] - win.scrollY;
  // CodeMirror only renders the on-screen viewport: coordsAtPos returns
  // null for any position outside that window. Fast preview scrolls land
  // far from the editor's current viewport, hitting null and stalling
  // the sync. lineBlockAt is doc-Y based and works for any position.
  let target;
  try {
    const bi = cm.lineBlockAt(fromPos);
    if (!bi) { target = null; }
    else {
      // bi.top is the block's Y in doc coordinates (from cm-content top).
      // Place it so that block-doc-Y - newScrollTop = previewBlockYInView.
      target = bi.top - previewBlockYInView;
    }
  } catch (_) { target = null; }
  if (target == null) return;
  target = clampEditorY(sd, target);
  editorExpected = Math.round(target);
  sd.scrollTop = target;
}

function consumeExpectedScroll(side, currentPos) {
  const lockUntil = side === 'editor' ? editorLockUntil : previewLockUntil;
  if (Date.now() < lockUntil) return true; // smooth scroll in progress
  const ref = side === 'editor' ? editorExpected : previewExpected;
  if (side === 'editor') editorExpected = null;
  else                   previewExpected = null;
  return ref !== null && Math.abs(Math.round(currentPos) - ref) <= SCROLL_TOLERANCE_PX;
}

// Click-on-preview (line-level, v0.2.4): walk up to the top-level preview
// block, interpolate which source line was under the click via the
// block's `data-sourcepos` and click-Y, dispatch a CodeMirror cursor
// jump to that line. The selection-set update fires syncPreviewFromCursor
// which re-anchors the preview at the new cursor line.
function syncEditorFromPreviewClick(win, evt) {
  if (!cm || !evt || isSyncSuspended()) return;
  const cache = getPreviewBlocksCached(activeIframe());
  if (!cache.blocks.length) return;
  let el = evt.target;
  const body = win.document.body;
  while (el && el.parentElement && el.parentElement !== body) el = el.parentElement;
  if (!el || el.parentElement !== body) return;
  const idx = cache.blocks.findIndex(b => b.el === el);
  if (idx < 0) return;
  const lBlocks = getLezerBlocks();
  const editorIdx = Math.min(idx, lBlocks.length - 1);
  if (editorIdx < 0) return;

  // Source-line interpolation from click-Y inside element.
  const rect = el.getBoundingClientRect();
  const clickY = (typeof evt.clientY === 'number') ? evt.clientY - rect.top : 0;
  const sp = parseSourcepos(el);
  let targetLine;
  if (sp && sp[1] >= sp[0]) {
    targetLine = window.md4xAlignmentMath.lineFromClickY(
      clickY, rect.height, sp[0], sp[1]
    );
  } else {
    // Fallback: jump to block's first source line via lezer range.
    targetLine = cm.state.doc.lineAt(lBlocks[editorIdx].from).number;
  }
  // Clamp to doc range.
  const maxLine = cm.state.doc.lines;
  if (targetLine < 1) targetLine = 1;
  else if (targetLine > maxLine) targetLine = maxLine;

  const lineFromPos = cm.state.doc.line(targetLine).from;
  // Move the cursor + scroll the editor so the line is centered.
  cm.dispatch({
    selection: { anchor: lineFromPos, head: lineFromPos },
    scrollIntoView: true,
  });
  cm.focus();
  // Belt: explicitly schedule preview re-anchor on top of the
  // selection-set updateListener path so the alignment is visibly
  // applied even if the listener path is starved by other work.
  rafSchedSync('editorCursor', syncPreviewFromCursor);
}

// ── Search → preview highlight bridge (v0.2.5) ─────────────────────────────
// Editor query/state → preview-highlight.js. CSS Custom Highlight API; no
// DOM mutation in the iframe. Pill fires when active match has no Range.
const PREVIEW_HIGHLIGHT_CSS =
  '::highlight(md4x-search) { background-color: #fff48a; color: inherit; } ' +
  '::highlight(md4x-search-active) { background-color: #ffb547; color: inherit; }';

function ensurePreviewHighlightCSS(doc) {
  if (!doc || !doc.head) return;
  if (doc.getElementById('md4x-search-css')) return;
  const s = doc.createElement('style');
  s.id = 'md4x-search-css';
  s.textContent = PREVIEW_HIGHLIGHT_CSS;
  doc.head.appendChild(s);
}

function searchActiveOrdinal(query) {
  // Map editor's main selection head → ordinal-among-matches in source text.
  if (!cm || !query || !query.search) return -1;
  const head = cm.state.selection.main.head;
  const docText = cm.state.doc.toString();
  // Use preview-highlight's findMatches to keep flag semantics in lockstep.
  const flags = {
    caseSensitive: !!query.caseSensitive,
    wholeWord: !!query.wholeWord,
    regex: !!query.regexp,
  };
  const ph = window.md4xPreviewHighlight;
  if (!ph) return -1;
  const matches = ph.findMatches(docText, query.search, flags);
  for (let i = 0; i < matches.length; i++) {
    if (matches[i][0] <= head && head <= matches[i][1]) return i;
  }
  // Cursor between matches → nearest-prior match.
  let prev = -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i][1] <= head) prev = i; else break;
  }
  return prev;
}

function isSearchPanelOpen() {
  const bar = searchBarEl();
  return !!(bar && !bar.hidden);
}

function clearSearchVisuals() {
  const ph = window.md4xPreviewHighlight;
  if (ph) ph.clear();
  const iframe = activeIframe();
  if (iframe && iframe.contentWindow) {
    const win = iframe.contentWindow;
    if (win.__md4xHl && win.__md4xHl.clear) win.__md4xHl.clear();
    if (win.__md4xHlActive && win.__md4xHlActive.clear) win.__md4xHlActive.clear();
  }
  updateSearchPill(false);
  updateSearchCounter(0, 0, -1);
}

function readSearchFlagsFromBar() {
  const tCase  = document.getElementById('search-toggle-case');
  const tWord  = document.getElementById('search-toggle-word');
  const tRegex = document.getElementById('search-toggle-regex');
  return {
    caseSensitive: tCase && tCase.getAttribute('aria-pressed') === 'true',
    wholeWord:     tWord && tWord.getAttribute('aria-pressed') === 'true',
    regex:         tRegex && tRegex.getAttribute('aria-pressed') === 'true',
  };
}

function syncSearchToPreview() {
  const ph = window.md4xPreviewHighlight;
  if (!ph || !cm || !CM.getSearchQuery) return;
  if (!isSearchPanelOpen()) { clearSearchVisuals(); return; }
  const iframe = activeIframe();
  if (!iframe || !iframe.contentDocument) return;
  ensurePreviewHighlightCSS(iframe.contentDocument);
  const q = CM.getSearchQuery(cm.state);
  const query = (q && q.search) ? q.search : '';
  if (!query) { clearSearchVisuals(); return; }
  const flags = {
    caseSensitive: !!q.caseSensitive,
    wholeWord: !!q.wholeWord,
    regex: !!q.regexp,
  };
  const activeOrd = searchActiveOrdinal(q);
  ph.update(iframe.contentDocument, query, flags, activeOrd);
  const docText = cm.state.doc.toString();
  const N = ph.findMatches(docText, query, flags).length;
  const M = ph.countVisible();
  updateSearchCounter(N, M, activeOrd);
  const activeHasRange = activeOrd >= 0 && ph.hasRangeForOrdinal(activeOrd);
  updateSearchPill(activeOrd >= 0 && !activeHasRange);
}

// Bar-bound update helpers — in-bar counter and inline "not visible" glyph.
const searchBarEl       = () => document.getElementById('search-bar');
const searchInputEl     = () => document.getElementById('search-input');
const replaceInputEl    = () => document.getElementById('replace-input');
const searchCountEl     = () => document.getElementById('search-count');
const searchNotVisEl    = () => document.getElementById('search-not-visible');
const searchReplaceRow  = () => document.querySelector('.search-replace-row');

function updateSearchCounter(N, M, activeOrdinal) {
  const el = searchCountEl();
  if (!el) return;
  if (!N) { el.textContent = ''; return; }
  const cur = (activeOrdinal >= 0) ? activeOrdinal + 1 : 0;
  el.textContent = (M < N)
    ? `${cur} of ${N} (${M} in preview)`
    : `${cur} of ${N}`;
}
function updateSearchPill(show) {
  const el = searchNotVisEl();
  if (el) el.hidden = !show;
}

// Open + focus the search bar; pre-fill from current selection when possible.
function openSearchBar() {
  const bar = searchBarEl();
  if (!bar) return;
  bar.hidden = false;
  // CM6's searchHighlighter only paints decorations when the built-in
  // search panel is OPEN (it short-circuits on `!panel`). We open it
  // programmatically and hide its UI via CSS so our custom bar is the
  // only visible search affordance.
  if (cm && CM.openSearchPanel) CM.openSearchPanel(cm);
  const input = searchInputEl();
  if (cm) {
    const sel = cm.state.selection.main;
    if (!sel.empty) {
      const seed = cm.state.sliceDoc(sel.from, sel.to);
      if (seed && !seed.includes('\n')) input.value = seed;
    }
  }
  input.focus();
  input.select();
  pushSearchQuery();
  scheduleAlignmentTicks();
}
function closeSearchBar() {
  const bar = searchBarEl();
  if (!bar) return;
  bar.hidden = true;
  if (cm && CM.setSearchQuery) {
    cm.dispatch({ effects: CM.setSearchQuery.of(new CM.SearchQuery({ search: '' })) });
  }
  if (cm && CM.closeSearchPanel) CM.closeSearchPanel(cm);
  clearSearchVisuals();
  if (cm) cm.focus();
  scheduleAlignmentTicks();
}
// Push the bar's current input + flags into CM6's search state, which
// drives the in-editor match decorations and findNext/replaceAll commands.
function pushSearchQuery() {
  if (!cm || !CM.setSearchQuery || !CM.SearchQuery) return;
  const input = searchInputEl();
  const flags = readSearchFlagsFromBar();
  const sq = new CM.SearchQuery({
    search: input.value || '',
    caseSensitive: flags.caseSensitive,
    wholeWord: flags.wholeWord,
    regexp: flags.regex,
    replace: replaceInputEl().value || '',
  });
  cm.dispatch({ effects: CM.setSearchQuery.of(sq) });
  syncSearchToPreview();
}
function searchNext() {
  if (!cm || !CM.findNext) return;
  pushSearchQuery();
  CM.findNext(cm);
  syncSearchToPreview();
}
function searchPrev() {
  if (!cm || !CM.findPrevious) return;
  pushSearchQuery();
  CM.findPrevious(cm);
  syncSearchToPreview();
}
function searchReplaceOnce() {
  if (!cm || !CM.replaceNext) return;
  pushSearchQuery();
  CM.replaceNext(cm);
}
function searchReplaceAll() {
  if (!cm || !CM.replaceAll) return;
  pushSearchQuery();
  CM.replaceAll(cm);
}
function toggleReplaceRow() {
  const row = searchReplaceRow();
  const btn = document.getElementById('search-replace-toggle');
  if (!row || !btn) return;
  const showing = !row.hidden;
  row.hidden = showing;
  btn.classList.toggle('expanded', !showing);
}
function wireSearchBar() {
  const input = searchInputEl();
  if (!input) return;
  input.addEventListener('input', pushSearchQuery);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')      { e.preventDefault(); closeSearchBar(); }
    else if (e.key === 'Enter')  { e.preventDefault(); e.shiftKey ? searchPrev() : searchNext(); }
  });
  replaceInputEl().addEventListener('input', pushSearchQuery);
  replaceInputEl().addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearchBar(); }
    else if (e.key === 'Enter') { e.preventDefault(); searchReplaceOnce(); }
  });
  document.getElementById('search-prev').addEventListener('click', searchPrev);
  document.getElementById('search-next').addEventListener('click', searchNext);
  document.getElementById('search-close').addEventListener('click', closeSearchBar);
  document.getElementById('search-replace-toggle').addEventListener('click', toggleReplaceRow);
  document.getElementById('replace-once').addEventListener('click', searchReplaceOnce);
  document.getElementById('replace-all').addEventListener('click', searchReplaceAll);
  for (const id of ['search-toggle-case', 'search-toggle-word', 'search-toggle-regex']) {
    document.getElementById(id).addEventListener('click', (e) => {
      const b = e.currentTarget;
      const on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', on ? 'false' : 'true');
      pushSearchQuery();
    });
  }
}

// rAF coalesce: under fast scroll, dozens of scroll events fire per frame.
// Without coalescing each one would re-run the sync (and overwrite the
// previousExpected mid-flight, defeating bounce-back detection). Once per
// frame is enough — the user can't perceive faster than that anyway.
//
// Separate keys for editor-scroll, editor-cursor, and preview so a Cmd-Up
// that triggers BOTH a CM auto-scroll AND a selection update schedules
// both syncs for the same frame instead of one swallowing the other.
const _rafSync = { editorScroll: false, editorCursor: false, preview: false };
function rafSchedSync(key, fn) {
  if (_rafSync[key]) return;
  _rafSync[key] = true;
  requestAnimationFrame(() => {
    _rafSync[key] = false;
    try { fn(); }
    catch (e) { console.warn('[md4x] sync', key, e); }
  });
}

// ── Alignment ticks (v0.2.3) ──────────────────────────────────────────────
// Build per-pane state for the alignment-ticks module: tops, kinds,
// scrollTop, viewportH. Reuse existing block-sync primitives unchanged.
function getCursorBlockOrdinal() {
  if (!cm) return -1;
  const blocks = getLezerBlocks();
  if (!blocks.length) return -1;
  const head = cm.state.selection.main.head;
  return lezerBlockIndexAtPos(blocks, head);
}
function getEditorAlignmentState() {
  if (!cm) return null;
  const sd = cm.scrollDOM;
  const lBlocks = getLezerBlocks();
  const tops  = new Array(lBlocks.length);
  const kinds = new Array(lBlocks.length);
  for (let i = 0; i < lBlocks.length; i++) {
    let bi;
    try { bi = cm.lineBlockAt(lBlocks[i].from); } catch (_) { bi = null; }
    tops[i]  = bi ? bi.top : 0;
    kinds[i] = lBlocks[i].kind;
  }
  // Cursor red tick: use coordsAtPos for accurate viewport-Y (matches the
  // coord system used by existing syncPreviewFromCursor). lineBlockAt's
  // doc-Y is offset by cm-content padding which causes ~tens-of-px drift.
  const cursorOrdinal = getCursorBlockOrdinal();
  let cursorTickY = null;
  if (cursorOrdinal >= 0) {
    try {
      const c = cm.coordsAtPos(lBlocks[cursorOrdinal].from);
      if (c) {
        const r = sd.getBoundingClientRect();
        cursorTickY = c.top - r.top;
      }
    } catch (_) { /* off-screen → null */ }
  }
  return {
    tops, kinds,
    scrollTop: sd.scrollTop,
    viewportH: sd.clientHeight,
    cursorOrdinal,
    cursorTickY,
  };
}
function getPreviewAlignmentState() {
  const iframe = activeIframe();
  const win = iframe && iframe.contentWindow;
  if (!win || !win.document || !win.document.body) return null;
  const cache = getPreviewBlocksCached(iframe);
  const kinds = cache.blocks.map(b => b.kind);
  const cursorOrdinal = getCursorBlockOrdinal();
  let cursorTickY = null;
  if (cursorOrdinal >= 0 && cursorOrdinal < cache.blocks.length && cm) {
    // Line-level (v0.2.4): interpolate the cursor's source line within
    // the matching preview block by data-sourcepos.
    const blockEl = cache.blocks[cursorOrdinal].el;
    const liveTop = elDocTop(blockEl, win);
    const blockHeight = blockEl.offsetHeight;
    const cursorLine = cm.state.doc.lineAt(cm.state.selection.main.head).number;
    const sp = parseSourcepos(blockEl);
    let lineDocY;
    if (sp && sp[1] >= sp[0]) {
      lineDocY = window.md4xAlignmentMath.lineYInBlock(
        cursorLine, sp[0], sp[1], liveTop, blockHeight
      );
    } else {
      lineDocY = liveTop;
    }
    const y = lineDocY - win.scrollY;
    if (y >= 0 && y <= win.innerHeight) cursorTickY = y;
  }
  return {
    tops:      cache.tops.slice(),
    kinds,
    scrollTop: win.scrollY,
    viewportH: win.innerHeight,
    cursorOrdinal,
    cursorTickY,
  };
}
// Programmatic scrolls used by the auto-correct path. They flag the
// existing bounce-back machinery (xExpected + xLockUntil) so the
// resulting scroll event does not cycle back as a "user" scroll.
function alignmentSmoothScrollPreviewTo(y) {
  const iframe = activeIframe();
  const win = iframe && iframe.contentWindow;
  if (!win) return;
  const target = clampPreviewY(win, y);
  previewExpected = Math.round(target);
  previewLockUntil = Date.now() + SMOOTH_LOCKOUT_MS;
  win.scrollTo({ top: target, left: 0, behavior: 'smooth' });
}
function alignmentSmoothScrollEditorTo(y) {
  if (!cm) return;
  const sd = cm.scrollDOM;
  const target = clampEditorY(sd, y);
  editorExpected = Math.round(target);
  editorLockUntil = Date.now() + SMOOTH_LOCKOUT_MS;
  sd.scrollTo({ top: target, left: 0, behavior: 'smooth' });
}
function isSmoothScrollLocked() {
  return Date.now() < Math.max(editorLockUntil, previewLockUntil);
}
function initAlignmentTicks() {
  if (!window.md4xAlignmentTicks) return;
  const editorPane  = document.getElementById('editor-pane');
  const previewPane = document.getElementById('preview-pane');
  window.md4xAlignmentTicks.init({
    editorPane,
    previewPane,
    bridge: {
      getEditorState:        getEditorAlignmentState,
      getPreviewState:       getPreviewAlignmentState,
      isSyncSuspended,
      isSmoothScrollLocked,
      smoothScrollPreviewTo: alignmentSmoothScrollPreviewTo,
      smoothScrollEditorTo:  alignmentSmoothScrollEditorTo,
    },
  });
}

// Scroll-sync coordinator (v0.2.5). Pure FSM in the module; this adapter
// plumbs callbacks back to existing app.js DOM helpers. Phase B wires
// editor cursor only — the resolver path delegates to the existing
// syncPreviewFromCursor so behaviour is unchanged. Other paths still
// run through the legacy code (rafSchedSync, etc.) until later phases
// migrate them.
function initScrollSync() {
  if (!window.md4xScrollSync) return;
  window.md4xScrollSync.init({
    callbacks: {
      resolveFromCursor: () => syncPreviewFromCursor(),
      // resolveOnce fires after splitterDragEnd / renderComplete in the
      // FSM. Use the existing cursor-anchored re-sync as the canonical
      // "rebuild and re-place" routine.
      resolveOnce: () => syncPreviewFromCursor(),
      // Block-cache invalidation: delegate to existing helper.
      invalidateBlockCache: () => invalidatePreviewBlocksCache(),
      // Driver-change publish: alignment-ticks still drives its own
      // state in this phase; phase D wires it through.
      onDriverChange: () => {},
      // Other callbacks (setPreviewScrollTop, setEditorScrollTop,
      // setEditorCursor, forceAlignTick, resolveFromPreviewScroll,
      // resolveFromEditorScroll) plumb in later phases as we migrate.
    },
  });
}
function scheduleAlignmentTicks() {
  if (window.md4xAlignmentTicks) window.md4xAlignmentTicks.schedule();
}

// Diagnostic: dump current alignment to the console. Useful to verify the
// admonish coalesce + ordinal pairing in the live runtime against the
// scratch/sync-probe harness verdict.
window.md4xSyncProbe = function () {
  if (!cm) return { error: 'no editor' };
  const iframe = activeIframe();
  const doc = iframe.contentWindow && iframe.contentWindow.document;
  const lBlocks = getLezerBlocks();
  const pBlocks = getPreviewBlocks(doc);
  const n = Math.min(lBlocks.length, pBlocks.length);
  const pairs = [];
  for (let k = 0; k < n; k++) {
    const lText = cm.state.doc.sliceString(lBlocks[k].from, Math.min(lBlocks[k].to, lBlocks[k].from + 60));
    const pText = (pBlocks[k].el.textContent || '').slice(0, 60).trim();
    pairs.push({ k, lk: lBlocks[k].kind, pk: pBlocks[k].kind, lText, pText });
  }
  return { lezer_blocks: lBlocks.length, preview_blocks: pBlocks.length, pairs };
};

function setDirty(v) {
  const was = isDirty;
  isDirty = !!v;
  unsavedEl.hidden = !isDirty;
  savedDotEl.classList.toggle('dirty', isDirty);
  if (was !== isDirty) syncWindowTitle();
}

function syncWindowTitle() {
  const name = currentFilePath ? currentFilePath.split('/').pop() : 'Untitled';
  const span = filenameEl.querySelector('#unsaved');
  filenameEl.textContent = name;
  if (span) filenameEl.appendChild(span);
  else filenameEl.appendChild(unsavedEl);
  document.title = `${isDirty ? '• ' : ''}${name} — md4x`;
}

// ── Welcome / file lifecycle ────────────────────────────────────────────────
function showWelcome() {
  renderRecent();
  welcome.hidden = false;
  if (welcomeClose) welcomeClose.hidden = !(currentFilePath || editorText());
}
function hideWelcome() { welcome.hidden = true; }

function setEditorContent(text, filePath) {
  setEditorText(text || '');
  currentFilePath = filePath || null;
  setDirty(false);
  updateCounts();
  syncWindowTitle();
  hideWelcome();
  scheduleRender();
}
function newDraft() { setEditorContent('', null); if (cm) cm.focus(); }
window.newDraft = newDraft;

// ── Recent files (localStorage) ─────────────────────────────────────────────
const RECENT_KEY = 'md4x.recent.v1';
const RECENT_MAX = 10;
function readRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function writeRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch {} }
function pushRecent(path) {
  if (!path) return;
  const list = readRecent().filter(p => p !== path);
  list.unshift(path);
  writeRecent(list);
}
function renderRecent() {
  const list = readRecent();
  clearChildren(recentList);
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'recent-empty';
    li.textContent = 'No recent files yet.';
    recentList.appendChild(li);
    return;
  }
  for (const path of list) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'recent-icon';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = path.split('/').pop() || path;
    name.title = path;
    name.addEventListener('click', () => openFromPath(path));
    const dir = document.createElement('span');
    dir.className = 'recent-path';
    const parent = path.replace(/\/[^/]*$/, '');
    dir.textContent = parent.replace(/^\/Users\/[^/]+/, '~');
    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(dir);
    recentList.appendChild(li);
  }
}

// ── Undefined-macros surfacing ──────────────────────────────────────────────
// After each render we collect the set of `\command` tokens that KaTeX
// couldn't resolve (via its errorCallback in INIT_JS, plus a DOM scan of
// `.katex-error` for safety) and surface them as a status-bar pill. Click
// the pill to see the list and generate a stub `<file>.macros.json`.
const sbUndefBtn      = document.getElementById('sb-undef');
const sbUndefCount    = document.getElementById('sb-undef-count');
const undefModal      = document.getElementById('undef-modal');
const undefList       = document.getElementById('undef-list');
const undefTemplateBtn = document.getElementById('undef-template-btn');
const undefInlineBtn  = document.getElementById('undef-inline-btn');
const undefHelpBtn    = document.getElementById('undef-help-btn');
const undefTargetName = document.getElementById('undef-target-name');
const helpModal       = document.getElementById('help-modal');
const helpIframe      = document.getElementById('help-iframe');
const helpBtn         = document.getElementById('help-btn');

let lastUndefMacros = []; // sorted unique array

function scanAndReportUndefMacros(iframe) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  // KaTeX wraps every render error in `<span class="katex-error" title="...">`
  // where the title is the exact ParseError message — including the
  // failing control sequence. The text content is the *whole* failing
  // expression so we deliberately ignore it (it would over-report).
  const set = new Set();
  doc.querySelectorAll('.katex-error[title]').forEach(el => {
    const title = el.getAttribute('title') || '';
    const m = title.match(/Undefined control sequence:\s*(\\[a-zA-Z]+)/);
    if (m) set.add(m[1]);
  });
  lastUndefMacros = Array.from(set).sort();
  updateUndefPill();
}

function updateUndefPill() {
  const n = lastUndefMacros.length;
  sbUndefBtn.hidden = n === 0;
  sbUndefCount.textContent = String(n);
}

function openUndefModal() {
  clearChildren(undefList);
  if (lastUndefMacros.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No undefined macros — looking good.';
    undefList.appendChild(li);
  } else {
    for (const m of lastUndefMacros) {
      const li = document.createElement('li');
      li.textContent = m;
      undefList.appendChild(li);
    }
  }
  // Show the target file name if we have a source path.
  if (currentFilePath) {
    const stem = currentFilePath.split('/').pop().replace(/\.(md|markdown|mdx)$/i, '');
    undefTargetName.textContent = `${stem}.macros.json`;
    undefTemplateBtn.disabled = lastUndefMacros.length === 0;
    // Inline only makes sense once a sidecar exists. lastUserMacrosJson
    // is the bytes of the sidecar at last render — empty string means
    // no sidecar (or it's not a JSON object).
    const hasSidecar = !!(lastUserMacrosJson && lastUserMacrosJson.trim().startsWith('{'));
    undefInlineBtn.disabled = !hasSidecar;
    undefInlineBtn.title = hasSidecar
      ? 'Embed sidecar JSON into the document so the .md ships self-contained'
      : 'No sidecar yet — generate a template and fill in expansions first';
  } else {
    undefTargetName.textContent = '<filename>.macros.json';
    undefTemplateBtn.disabled = true;
    undefInlineBtn.disabled = true;
    undefInlineBtn.title = 'Save the document first';
  }
  undefModal.hidden = false;
}
function closeUndefModal() { undefModal.hidden = true; }

sbUndefBtn.addEventListener('click', openUndefModal);
undefModal.addEventListener('click', (e) => {
  if (e.target.dataset && 'undefDismiss' in e.target.dataset) closeUndefModal();
});
undefTemplateBtn.addEventListener('click', async () => {
  // Surface the two reasons the call would early-return so the user
  // isn't left wondering why the button "did nothing".
  if (!currentFilePath) {
    toast('Save the document first — template needs a path next to a .md file');
    return;
  }
  if (lastUndefMacros.length === 0) {
    toast('No undefined macros to template');
    return;
  }
  undefTemplateBtn.disabled = true;
  try {
    const result = await invoke('write_macros_template', {
      sourcePath: currentFilePath,
      macros: lastUndefMacros,
    });
    console.log('[md4x] write_macros_template ok', result);
    closeUndefModal();
    const verb = result.added > 0
      ? `Added ${result.added} stub${result.added === 1 ? '' : 's'}`
      : `Template up to date (${result.existed} already defined)`;
    toast(`${verb} → ${result.path.split('/').pop()}`);
    if (settings.revealOnExport) {
      try { await invoke('reveal_in_finder', { path: result.path }); } catch {}
    }
    // Side car changed → re-render so MacrosPlugin re-reads the file.
    scheduleRender();
  } catch (e) {
    console.error('[md4x] write_macros_template failed', e);
    toast(`Template write failed: ${e}`);
  } finally {
    undefTemplateBtn.disabled = false;
  }
});

undefInlineBtn.addEventListener('click', async () => {
  if (!currentFilePath) {
    toast('Save the document first — inline writes to a real .md file');
    return;
  }
  undefInlineBtn.disabled = true;
  try {
    // Pass the live buffer (includes unsaved edits). Backend strips any
    // existing inline block, merges with sidecar (inline wins), and
    // writes the result.
    const result = await invoke('inline_macros_into_source', {
      sourcePath: currentFilePath,
      md: editorText(),
    });
    setEditorContent(result.new_content, result.path);
    closeUndefModal();
    toast(`Macros inlined → ${result.path.split('/').pop()}. The .md ships self-contained.`);
  } catch (e) {
    console.error('[md4x] inline_macros_into_source failed', e);
    toast(`Inline failed: ${e}`);
  } finally {
    undefInlineBtn.disabled = false;
  }
});

async function openHelp() {
  helpModal.hidden = false;
  try {
    const result = await invoke('render_help_html', { template: currentTemplate });
    // Strip the preview pane's A4-page chrome — help is a regular
    // document, not a print artifact.
    helpIframe.addEventListener('load', () => {
      const doc = helpIframe.contentDocument;
      if (!doc) return;
      const style = doc.createElement('style');
      style.textContent = `
        html { background: #fff !important; padding: 0 !important; overflow-y: auto !important; }
        body {
          width: auto !important;
          max-width: 760px !important;
          margin: 0 auto !important;
          padding: 28px 36px !important;
          background: #fff !important;
          box-shadow: none !important;
          transform: none !important;
        }
        .cover-page { display: none !important; }
      `;
      doc.head.appendChild(style);
    }, { once: true });
    helpIframe.srcdoc = result.html;
  } catch (e) {
    helpIframe.srcdoc = `<pre>Help failed to render: ${e}</pre>`;
  }
}
function closeHelp() {
  helpModal.hidden = true;
  helpIframe.srcdoc = '';   // free render
}
window.openHelp = openHelp;

undefHelpBtn.addEventListener('click', () => { closeUndefModal(); openHelp(); });
helpBtn.addEventListener('click', openHelp);
helpModal.addEventListener('click', (e) => {
  if (e.target.dataset && 'helpDismiss' in e.target.dataset) closeHelp();
});

// ── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(text) {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.remove(); toastTimer = null; }, 1400);
}

// ── File operations ─────────────────────────────────────────────────────────
async function openFile() {
  try {
    const result = await invoke('open_file');
    if (!result) return;
    pushRecent(result.path);
    setEditorContent(result.content, result.path);
  } catch (e) { console.error('[md4x] open_file failed', e); }
}
window.openFile = openFile;

async function openFromPath(path) {
  if (!path) return;
  try {
    const result = await invoke('read_file', { path });
    pushRecent(result.path);
    setEditorContent(result.content, result.path);
  } catch (e) { console.error('[md4x] read_file failed', e); }
}
window.openFromPath = openFromPath;

async function saveFile() {
  if (!currentFilePath) return saveFileAs();
  try {
    await invoke('save_file', { path: currentFilePath, content: editorText() });
    pushRecent(currentFilePath);
    setDirty(false);
    toast('Saved');
  } catch (e) { console.error('[md4x] save_file failed', e); }
}
window.saveFile = saveFile;

async function saveFileAs() {
  try {
    const suggested = currentFilePath ? currentFilePath.split('/').pop() : 'untitled.md';
    const result = await invoke('save_file_as', { content: editorText(), suggestedName: suggested });
    if (!result.path) return;
    currentFilePath = result.path;
    pushRecent(result.path);
    setDirty(false);
    syncWindowTitle();
    toast('Saved');
  } catch (e) { console.error('[md4x] save_file_as failed', e); }
}
window.saveFileAs = saveFileAs;

// ── Confirm-on-close ────────────────────────────────────────────────────────
function showConfirmClose() {
  if (!isDirty) { invoke('close_window'); return; }
  confirmEl.hidden = false;
}
window.confirmClose = showConfirmClose;
confirmSave.addEventListener('click', async () => {
  confirmEl.hidden = true;
  await saveFile();
  if (!isDirty) invoke('close_window');
});
confirmDiscard.addEventListener('click', () => {
  confirmEl.hidden = true;
  setDirty(false);
  invoke('close_window');
});
confirmCancel.addEventListener('click', () => { confirmEl.hidden = true; });

// ── Mermaid / KaTeX re-render after morphdom ────────────────────────────────
function rerenderNewBlocks(iframe) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;
  const merBlocks = Array.from(doc.querySelectorAll('pre.mermaid:not([data-processed])'));
  if (merBlocks.length > 0 && win.mermaid) {
    try {
      if (typeof win.mermaid.run === 'function') win.mermaid.run({ nodes: merBlocks });
      else if (typeof win.mermaid.init === 'function') win.mermaid.init(undefined, merBlocks);
    } catch (e) { console.warn('[md4x] mermaid re-render', e); }
  }
  const mathSpans = doc.querySelectorAll('span[data-math-style]:not([data-katex-rendered])');
  if (mathSpans.length > 0 && win.katex) {
    const baseOpts = win.MD4X_KATEX_OPTIONS || { throwOnError: false };
    const sanitize = win.md4xSanitizeMath || (s => s);
    mathSpans.forEach(el => {
      const display = el.dataset.mathStyle === 'display';
      // Store source on first sight so we can re-render this block later
      // when the macros change (KaTeX overwrites el's contents on render).
      if (!el.dataset.mathSrc) el.dataset.mathSrc = el.textContent;
      try {
        win.katex.render(sanitize(el.dataset.mathSrc), el, Object.assign({ displayMode: display }, baseOpts));
        el.dataset.katexRendered = '1';
      } catch (e) {}
    });
  }
}

function applyRender(iframe, html, userMacrosJson) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const newDoc = new DOMParser().parseFromString(html, 'text/html');
  patchDOM(doc.body, newDoc.body);

  // Live-update of user macros: if `<file>.macros.json` changed since
  // the last render, push the new map into the iframe and force every
  // already-rendered math block to re-render against the new macros.
  // (Otherwise INIT_JS only ran once at iframe load and old macros stick.)
  const incoming = userMacrosJson || '';
  if (incoming !== lastUserMacrosJson) {
    lastUserMacrosJson = incoming;
    let parsed = {};
    if (incoming) {
      try { parsed = JSON.parse(incoming); } catch (e) { console.warn('[md4x] user macros JSON parse failed', e); }
    }
    const win = iframe.contentWindow;
    if (win && typeof win.md4xUpdateMacros === 'function') {
      win.md4xUpdateMacros(parsed);
    }
    // Restore source from data-math-src and force re-render of all
    // existing blocks (they no longer have `data-katex-rendered` after
    // we strip it). KaTeX overwrote .textContent with rendered HTML on
    // first render, so without the saved source we'd have nothing to
    // re-render from.
    doc.querySelectorAll('span[data-math-style][data-katex-rendered]').forEach(el => {
      if (el.dataset.mathSrc) el.textContent = el.dataset.mathSrc;
      el.removeAttribute('data-katex-rendered');
    });
  }

  rerenderNewBlocks(iframe);
  fitPage(iframe);
  scanAndReportUndefMacros(iframe);
  // Block layout has just changed (DOM patch + KaTeX/mermaid kicked off).
  // Drop the cached preview offsets so the next sync rebuilds them, then
  // pull the preview to wherever the cursor is — otherwise typing wouldn't
  // visibly update the preview position until the next scroll. We also
  // re-invalidate-and-resync after short delays to catch async KaTeX /
  // mermaid re-layouts that finish AFTER applyRender returns.
  invalidatePreviewBlocksCache();
  rafSchedSync('editorCursor', syncPreviewFromCursor);
  setTimeout(() => { invalidatePreviewBlocksCache(); syncPreviewFromCursor(); scheduleAlignmentTicks(); syncSearchToPreview(); }, 250);
  setTimeout(() => { invalidatePreviewBlocksCache(); syncPreviewFromCursor(); scheduleAlignmentTicks(); syncSearchToPreview(); }, 1000);
  scheduleAlignmentTicks();
  syncSearchToPreview();
}

function bootstrapIframe(iframe, html) {
  return new Promise(resolve => {
    iframe.addEventListener('load', () => { attachIframeHandlers(iframe); resolve(); }, { once: true });
    iframe.srcdoc = html;
  });
}

function attachIframeHandlers(iframe) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;
  // Persistent scrollbar styling — overlay scrollbar fades out at rest;
  // we want it visible whenever the doc overflows. `scrollbar-gutter:
  // stable` reserves room only when needed, so empty docs in a large
  // window don't sprout an empty rail.
  if (!doc.getElementById('md4x-scrollbar-css')) {
    const s = doc.createElement('style');
    s.id = 'md4x-scrollbar-css';
    s.textContent = [
      'html { scrollbar-gutter: stable; }',
      'html::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }',
      'html::-webkit-scrollbar-thumb { background: rgba(60, 60, 67, 0.32); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; min-height: 28px; }',
      'html::-webkit-scrollbar-thumb:hover { background: rgba(60, 60, 67, 0.55); background-clip: content-box; border: 2px solid transparent; }',
      'html::-webkit-scrollbar-track { background: transparent; }',
    ].join('\n');
    doc.head && doc.head.appendChild(s);
  }
  doc.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); }, true);
  doc.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); } }, true);
  doc.addEventListener('mouseup',   e => { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); } }, true);
  // We previously forwarded both deltaX and deltaY here, doubling the
  // native scroll AND surfacing trackpad's tiny stray deltaX during pure
  // vertical gestures (the "page jiggles sideways while scrolling" bug).
  // Native scroll inside the iframe handles vertical and horizontal
  // correctly on its own — we don't need to forward.
  // Preview → editor scroll sync. Suppress the bounce-back from our own
  // programmatic scrollTo (consumeExpectedScroll matches and returns true).
  win.addEventListener('scroll', () => {
    if (iframe !== activeIframe()) return;
    scheduleAlignmentTicks();
    if (consumeExpectedScroll('preview', win.scrollY)) return;
    rafSchedSync('preview', () => syncEditorFromPreview(win));
  }, { passive: true });
  // Driver detection: real wheel/touchmove on preview iframe → preview is driver.
  win.addEventListener('wheel', () => {
    if (iframe !== activeIframe()) return;
    if (window.md4xAlignmentTicks) window.md4xAlignmentTicks.markUserScroll('preview');
  }, { passive: true });
  win.addEventListener('touchmove', () => {
    if (iframe !== activeIframe()) return;
    if (window.md4xAlignmentTicks) window.md4xAlignmentTicks.markUserScroll('preview');
  }, { passive: true });
  // Click-on-preview → smooth-scroll editor to the matching block.
  // Walk up from the click target to find the top-level body child,
  // match it against the preview block list, and jump editor to the
  // corresponding lezer block.
  doc.addEventListener('click', (e) => {
    if (iframe !== activeIframe()) return;
    // Block link navigation — preview is read-only-ish; we only use
    // clicks for cursor sync. Without this, anchor clicks would
    // replace the iframe with the target URL and the preview would
    // never recover until next render.
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a) { e.preventDefault(); e.stopPropagation(); }
    syncEditorFromPreviewClick(win, e);
  });
  fitPage(iframe);
  if (win.ResizeObserver) {
    new win.ResizeObserver(() => {
      scheduleTailTrim(iframe);
      schedulePreviewCacheInvalidate();
    }).observe(doc.body);
  }
}

// Debounced cache-invalidator for layout-shifting events (window resize,
// iframe body resize). Without debounce, dragging the window edge would
// invalidate on every pixel and re-walk all preview blocks each scroll.
let _previewCacheInvalidateTimer = null;
function schedulePreviewCacheInvalidate() {
  if (_previewCacheInvalidateTimer) clearTimeout(_previewCacheInvalidateTimer);
  _previewCacheInvalidateTimer = setTimeout(() => {
    _previewCacheInvalidateTimer = null;
    invalidatePreviewBlocksCache();
  }, 150);
}
window.addEventListener('resize', () => {
  // Each resize event extends the suspension; once the user stops resizing
  // for ~200ms, sync resumes and the next call rebuilds the cache with the
  // new layout.
  suspendSync(200);
  schedulePreviewCacheInvalidate();
});

// ── Page fit (A4-zoom-to-fit, visually centered) ────────────────────────────
const A4_WIDTH_MM = 210;
const PX_PER_MM   = 96 / 25.4;
// Outer breathing room reserved on EACH side. Used both as the gap budget
// when computing scale and as a minimum gap for centering math.
const PAGE_GAP_PX = 16;

function fitPage(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const win = iframe.contentWindow;
  const targetPx = A4_WIDTH_MM * PX_PER_MM;

  // Detect vertical scrollbar — when present it eats horizontal width on
  // the right inside the document, so we'd otherwise visually offset the
  // page leftward. Using window.innerWidth - documentElement.clientWidth
  // gives us the actual scrollbar width as the OS / theme renders it.
  const docEl = doc.documentElement;
  const sbWidth = win
    ? Math.max(0, (win.innerWidth || iframe.clientWidth) - (docEl ? docEl.clientWidth : iframe.clientWidth))
    : 0;
  const containerWidth = iframe.clientWidth - sbWidth;
  const avail = containerWidth - PAGE_GAP_PX * 2;
  if (avail <= 0) return;

  const zoom = (settings.zoomPct || 100) / 100;
  const scale = Math.max(0.25, (avail / targetPx) * zoom);

  // Compute the offset that visually centers the scaled body. Body's
  // layout box is 210mm wide and we transform from top-left, so the
  // visual width is 210mm * scale. Half the leftover space goes on each
  // side. clamp to PAGE_GAP_PX so we never crowd the edges.
  const visualWidth = targetPx * scale;
  const offset = Math.max(PAGE_GAP_PX, (containerWidth - visualWidth) / 2);

  doc.body.style.transformOrigin = 'top left';
  doc.body.style.transform = `translateX(${offset}px) scale(${scale})`;
  scheduleTailTrim(iframe);
}

const tailTrimTimers = new WeakMap();
const TAIL_TRIM_DELAY_MS = 250;
function scheduleTailTrim(iframe) {
  const prev = tailTrimTimers.get(iframe);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => { tailTrimTimers.delete(iframe); trimTail(iframe); }, TAIL_TRIM_DELAY_MS);
  tailTrimTimers.set(iframe, timer);
}
function trimTail(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const win = iframe.contentWindow;
  const targetPx = A4_WIDTH_MM * PX_PER_MM;
  const docEl = doc.documentElement;
  const sbWidth = win
    ? Math.max(0, (win.innerWidth || iframe.clientWidth) - (docEl ? docEl.clientWidth : iframe.clientWidth))
    : 0;
  const containerWidth = iframe.clientWidth - sbWidth;
  const avail = containerWidth - PAGE_GAP_PX * 2;
  if (avail <= 0) return;
  const zoom = (settings.zoomPct || 100) / 100;
  const scale = Math.max(0.25, (avail / targetPx) * zoom);
  const overhang = doc.body.offsetHeight * (1 - scale);
  const current = -parseFloat(doc.body.style.marginBottom || '0');
  if (Math.abs(current - overhang) < 1) return;
  doc.body.style.setProperty('margin-bottom', `${-overhang}px`, 'important');
}
function fitAll() { fitPage(iframeA); fitPage(iframeB); }

// ── Render pipeline ──────────────────────────────────────────────────────────
async function render() {
  const t0 = performance.now();
  let result;
  try {
    result = await invoke('render_html', { md: editorText(), template: currentTemplate, sourcePath: currentFilePath });
  } catch (e) { console.error('[md4x] render_html failed', e); return; }
  const iframe = activeIframe();
  if (!bootstrapped) {
    await bootstrapIframe(iframe, result.html);
    bootstrapped = true;
    lastUserMacrosJson = result.user_macros || '';
    scanAndReportUndefMacros(iframe);
  } else {
    applyRender(iframe, result.html, result.user_macros);
  }
  lastRenderMs = performance.now() - t0;
  setStatusTime(lastRenderMs);
  pulseRender();
  updateCounts();
}
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, settings.debounceMs);
}

// ── Template switching (fade-swap) ──────────────────────────────────────────
async function switchTemplate(newTemplate) {
  currentTemplate = newTemplate;
  templateName.textContent = newTemplate;
  tmplStatus.textContent = newTemplate;
  let result;
  try { result = await invoke('render_html', { md: editorText(), template: newTemplate, sourcePath: currentFilePath }); }
  catch (e) { console.error('[md4x] render_html (switch) failed', e); return; }
  const inactive = inactiveIframe();
  await bootstrapIframe(inactive, result.html);
  const active = activeIframe();
  inactive.style.opacity = '1';
  // Force inline 'auto' — empty string falls through to the
  // `#preview-b { pointer-events: none }` CSS rule so iframeB would
  // stay click-blocked even when it becomes the active iframe.
  inactive.style.pointerEvents = 'auto';
  active.style.opacity = '0';
  active.style.pointerEvents = 'none';
  activeFrame = activeFrame === 'a' ? 'b' : 'a';
  bootstrapped = true;
  lastUserMacrosJson = result.user_macros || '';
  scanAndReportUndefMacros(inactive);
  // The new iframe sits at scrollY=0 — without this the preview would
  // snap to the cover page while the editor stays where it was. Drop the
  // stale cache (blocks belonged to the old iframe) and pull the new
  // preview to wherever the editor's currently looking, with re-syncs
  // after KaTeX/mermaid finish reflowing.
  invalidatePreviewBlocksCache();
  rafSchedSync('editorScroll', syncPreviewFromEditor);
  setTimeout(() => { invalidatePreviewBlocksCache(); syncPreviewFromEditor(); scheduleAlignmentTicks(); }, 250);
  setTimeout(() => { invalidatePreviewBlocksCache(); syncPreviewFromEditor(); scheduleAlignmentTicks(); }, 1000);
  scheduleAlignmentTicks();
  // Hack: WKWebView's wheel-event target stays latched on the OLD iframe
  // after a srcdoc swap — clicks/keys reach the new iframe but trackpad
  // scroll doesn't, until any resize invalidates the compositor's hit-test
  // cache. Nudge the editor pane width by 1px and back to force that
  // invalidation. Uses scheduleAfter so the nudge runs after layout settles.
  nudgeSplitterWidth();
}

function nudgeSplitterWidth() {
  const editorPane = document.getElementById('editor-pane');
  if (!editorPane) return;
  const rect = editorPane.getBoundingClientRect();
  const startW = rect.width;
  if (!startW) return;
  const prevFlex = editorPane.style.flex;
  const prevWidth = editorPane.style.width;
  editorPane.style.flex = 'none';
  editorPane.style.width = (startW + 1) + 'px';
  requestAnimationFrame(() => {
    editorPane.style.width = startW + 'px';
    requestAnimationFrame(() => {
      editorPane.style.flex = prevFlex;
      editorPane.style.width = prevWidth;
    });
  });
}

// ── Template gallery (SVG previews from v0.2.0 mockups) ─────────────────────
const TEMPLATE_PREVIEWS = {
  magazine: `<svg viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg" font-family="Georgia, serif">
    <rect x="0" y="0" width="220" height="130" fill="#fbfbf7"/>
    <text x="110" y="36" text-anchor="middle" font-size="14" font-weight="700" fill="#1c1c1e">Magazine</text>
    <text x="110" y="52" text-anchor="middle" font-size="9" font-style="italic" fill="#666">classic editorial</text>
    <line x1="50" y1="64" x2="170" y2="64" stroke="#1c1c1e" stroke-width="0.6"/>
    <g font-size="6" fill="#3a3a3c">
      <text x="14" y="80">Lorem ipsum dolor sit amet, consectetur</text>
      <text x="14" y="90">adipiscing elit. Sed do eiusmod tempor</text>
      <text x="14" y="100">incididunt ut labore et dolore magna.</text>
      <text x="14" y="110">Ut enim ad minim veniam, quis nostrud.</text>
      <text x="14" y="120">Duis aute irure dolor in reprehenderit.</text>
    </g>
  </svg>`,
  swiss: `<svg viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica, Arial, sans-serif">
    <rect x="0" y="0" width="220" height="130" fill="#ffffff" stroke="#000" stroke-width="1"/>
    <text x="14" y="28" font-size="16" font-weight="900" fill="#000">SWISS</text>
    <line x1="14" y1="36" x2="206" y2="36" stroke="#ee2222" stroke-width="2"/>
    <text x="14" y="54" font-size="9" fill="#000">Grid · rules · sans</text>
    <g font-size="6" fill="#000">
      <text x="14" y="74">Lorem ipsum dolor sit amet consectetur</text>
      <text x="14" y="84">adipiscing elit sed do eiusmod tempor</text>
      <text x="14" y="94">incididunt ut labore et dolore magna</text>
      <text x="14" y="104">aliqua ut enim ad minim veniam quis</text>
      <text x="14" y="114">nostrud exercitation ullamco laboris.</text>
    </g>
  </svg>`,
  stem: `<svg viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg" font-family="Georgia, serif">
    <rect x="0" y="0" width="220" height="130" fill="#fafbfc" stroke="#0b3d91"/>
    <text x="110" y="34" text-anchor="middle" font-size="13" font-weight="700" fill="#0b3d91">STEM Quarterly</text>
    <line x1="30" y1="44" x2="190" y2="44" stroke="#0b3d91" stroke-width="0.5"/>
    <text x="110" y="58" text-anchor="middle" font-size="8" font-style="italic" fill="#0b3d91">technical · figures · math</text>
    <g font-size="6" fill="#1c1c1e">
      <text x="10" y="74">∫ f(x) dx = F(b) − F(a). Lorem ipsum</text>
      <text x="10" y="84">dolor sit amet, consectetur adipiscing</text>
      <text x="10" y="94">elit. Theorem 1. For all n ∈ ℕ, ...</text>
      <text x="10" y="104">Proof. By induction on n. Base case ...</text>
      <text x="10" y="114">Lemma 2. Suppose f is continuous.</text>
    </g>
  </svg>`,
  tufte: `<svg viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg" font-family="Georgia, serif">
    <rect x="0" y="0" width="220" height="130" fill="#fffef9" stroke="#d1c8b4"/>
    <text x="50" y="28" font-size="13" font-weight="700" fill="#1c1c1e">Tufte</text>
    <text x="50" y="42" font-size="8" font-style="italic" fill="#666">side-noted · spacious</text>
    <g font-size="6" fill="#1c1c1e">
      <text x="10" y="60">Lorem ipsum dolor sit amet, consectetur</text>
      <text x="10" y="70">adipiscing elit. Sed do eiusmod tempor</text>
      <text x="10" y="80">incididunt ut labore et dolore.</text>
    </g>
    <line x1="140" y1="56" x2="210" y2="56" stroke="#999" stroke-width="0.4"/>
    <g font-size="5" font-style="italic" fill="#555">
      <text x="140" y="66">¹ a side-note</text>
      <text x="140" y="74">in the margin</text>
    </g>
  </svg>`,
  newyorker: `<svg viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg" font-family="Times, serif">
    <rect x="0" y="0" width="220" height="130" fill="#ffffff" stroke="#1c1c1e"/>
    <text x="110" y="26" text-anchor="middle" font-size="14" font-weight="700" font-style="italic" fill="#1c1c1e">The New Yorker</text>
    <line x1="50" y1="34" x2="170" y2="34" stroke="#1c1c1e" stroke-width="0.4"/>
    <text x="110" y="48" text-anchor="middle" font-size="8" font-style="italic" fill="#666">drop-cap · long-form</text>
    <g font-size="6" fill="#1c1c1e">
      <text x="10" y="64">Lorem ipsum dolor sit amet, consectetur</text>
      <text x="10" y="74">adipiscing elit. Sed do eiusmod tempor.</text>
      <text x="10" y="84">Ut enim ad minim veniam, quis nostrud.</text>
      <text x="10" y="94">Duis aute irure dolor in reprehenderit.</text>
    </g>
  </svg>`,
  brutalist: `<svg viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg" font-family="'Courier New', monospace">
    <rect x="0" y="0" width="220" height="130" fill="#f4f1ec" stroke="#000" stroke-width="2"/>
    <rect x="4" y="4" width="60" height="50" fill="#ee2222"/>
    <text x="10" y="78" font-size="14" font-weight="900" fill="#000">BRUTALIST</text>
    <line x1="4" y1="90" x2="216" y2="90" stroke="#000" stroke-width="2"/>
    <g font-size="6" fill="#000">
      <text x="4" y="104">LOREM IPSUM DOLOR SIT AMET</text>
      <text x="4" y="114">CONSECTETUR ADIPISCING ELIT</text>
      <text x="4" y="124">SED DO EIUSMOD TEMPOR INCIDIDUNT</text>
    </g>
  </svg>`,
};
const TEMPLATE_DESCS = {
  magazine: 'Classic editorial',
  swiss: 'Grid · rules · sans',
  stem: 'Technical · figures · math',
  tufte: 'Side-noted · spacious',
  newyorker: 'Drop-cap · long-form',
  brutalist: 'Mono · raw · loud',
};
function svgFromString(svgString) {
  const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  return document.importNode(parsed.documentElement, true);
}
function buildGallery() {
  clearChildren(galleryGrid);
  for (const t of availableTemplates) {
    const tile = document.createElement('div');
    tile.className = 'gallery-card-tile' + (t === currentTemplate ? ' active' : '');
    const svg = TEMPLATE_PREVIEWS[t]
      ? svgFromString(TEMPLATE_PREVIEWS[t])
      : svgFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 130"><rect width="220" height="130" fill="#eee"/></svg>');
    tile.appendChild(svg);
    const row = document.createElement('div');
    row.className = 'name-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t;
    const badge = document.createElement('span');
    badge.className = 'active-badge';
    badge.textContent = 'Active';
    row.appendChild(name);
    row.appendChild(badge);
    tile.appendChild(row);
    tile.addEventListener('click', () => {
      gallery.hidden = true;
      if (t !== currentTemplate) switchTemplate(t);
    });
    galleryGrid.appendChild(tile);
  }
}
templateBtn.addEventListener('click', () => { buildGallery(); gallery.hidden = false; });
galleryClose.addEventListener('click', () => { gallery.hidden = true; });
gallery.addEventListener('click', (e) => { if (e.target === gallery) gallery.hidden = true; });

// ── Resizer ─────────────────────────────────────────────────────────────────
(function initResizer() {
  const resizer    = document.getElementById('resizer');
  const editorPane = document.getElementById('editor-pane');
  const panes      = document.getElementById('panes');
  let dragging = false, startX = 0, startW = 0;
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    panes.classList.remove('dragging');
    document.body.classList.remove('md4x-splitter-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (window.md4xAlignmentTicks) {
      window.md4xAlignmentTicks.setSplitterDragActive(false);
      window.md4xAlignmentTicks.schedule();
    }
    // Single reflow with the final width — instead of one per mousemove
    // tick. ResizeObserver / KaTeX / mermaid layout was the dominant
    // cost during drag; the body class above also freezes pointer-events
    // on the iframes so they don't churn while the splitter moves.
    invalidatePreviewBlocksCache();
    const iframe = activeIframe();
    if (iframe) fitPage(iframe);
    rafSchedSync('editorCursor', syncPreviewFromCursor);
  }
  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = editorPane.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    panes.classList.add('dragging');
    document.body.classList.add('md4x-splitter-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    if (window.md4xAlignmentTicks) window.md4xAlignmentTicks.setSplitterDragActive(true);
    e.preventDefault();
  });
  // rAF-coalesce the width write. Trackpad / 120Hz mice fire mousemove
  // faster than display refresh; without coalescing the iframe gets
  // 2+ width changes per frame and WKWebView's compositor layer
  // invalidates mid-paint, leaving the preview blank on fast drags of
  // large docs. One write per frame keeps it in paint.
  let pendingDragW = -1;
  let dragRafScheduled = false;
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const total = panes.getBoundingClientRect().width - 1;
    pendingDragW = Math.max(160, Math.min(total - 160, startW + e.clientX - startX));
    suspendSync(200);
    if (dragRafScheduled) return;
    dragRafScheduled = true;
    requestAnimationFrame(() => {
      dragRafScheduled = false;
      if (!dragging || pendingDragW < 0) return;
      editorPane.style.flex = 'none';
      editorPane.style.width = pendingDragW + 'px';
    });
  });
  document.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
  document.addEventListener('mouseleave', endDrag);
})();

// ── Trackpad/wheel scroll forwarding (vertical only) ───────────────────────
// Outer pane wheel forwarding for the rare case where the wheel hits the
// pane background outside the iframe (between iframes during fade-swap).
// Vertical-only, to avoid accidental horizontal drift from trackpad noise.
document.getElementById('preview-pane').addEventListener('wheel', (e) => {
  const win = activeIframe().contentWindow;
  if (win) win.scrollBy(0, e.deltaY);
}, { passive: true });

// ── Suppress native context menu (outer document) ───────────────────────────
function killContextMenu(e) { e.preventDefault(); e.stopPropagation(); }
function killRightMouse(e)  { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); } }
window.addEventListener('contextmenu', killContextMenu, true);
document.addEventListener('contextmenu', killContextMenu, true);
window.addEventListener('mousedown', killRightMouse, true);
window.addEventListener('mouseup',   killRightMouse, true);

// ── Keyboard shortcuts ──────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !exportDialog.hidden) { closeExportDialog(); return; }
  if (e.key === 'Escape' && !settingsEl.hidden) { settingsEl.hidden = true; return; }
  if (e.key === 'Escape' && !undefModal.hidden) { closeUndefModal(); return; }
  if (e.key === 'Escape' && !helpModal.hidden) { closeHelp(); return; }
  if (e.key === 'Escape' && !welcome.hidden && (currentFilePath || editorText())) { hideWelcome(); return; }
  if (e.key === 'Escape' && isSearchPanelOpen()) { closeSearchBar(); return; }
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'o' && !e.shiftKey && !e.altKey) { e.preventDefault(); showWelcome(); }
  else if (k === 's' && !e.shiftKey && !e.altKey) { e.preventDefault(); saveFile(); }
  else if (k === 's' && e.shiftKey && !e.altKey) { e.preventDefault(); saveFileAs(); }
  else if (k === 'e' && !e.shiftKey && !e.altKey) { e.preventDefault(); if (!exportBtn.disabled) exportBtn.click(); }
  else if (k === 'n' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (isDirty) showConfirmClose(); else newDraft();
  }
  else if (e.key === ',' && !e.shiftKey && !e.altKey) { e.preventDefault(); openSettings(); }
  else if (k === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); openSearchBar(); }
  else if (k === 'g' && !e.altKey) { e.preventDefault(); e.shiftKey ? searchPrev() : searchNext(); }
});

// ── Export PDF dialog (per design §6) ───────────────────────────────────────
let exportWhereDir = '';
function joinPath(dir, file) {
  if (!dir) return file;
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`;
}
function abbreviatePath(p) {
  if (!p) return '';
  const home = window.__MD4X_HOME__ || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p.replace(/^\/Users\/[^/]+/, '~');
}
function defaultExportName() {
  if (currentFilePath) {
    const base = currentFilePath.split('/').pop().replace(/\.(md|markdown|mdx)$/i, '');
    return `${base}.pdf`;
  }
  return 'untitled.pdf';
}
async function openExportDialog() {
  if (exportBtn.disabled) return;
  // Populate templates.
  clearChildren(exportTemplate);
  for (const t of availableTemplates) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === currentTemplate) opt.selected = true;
    exportTemplate.appendChild(opt);
  }
  // Populate filename + where.
  exportName.value = defaultExportName();
  if (!exportWhereDir) {
    if (currentFilePath) {
      exportWhereDir = currentFilePath.replace(/\/[^/]+$/, '');
    } else {
      try { exportWhereDir = await invoke('default_save_dir'); }
      catch { exportWhereDir = ''; }
    }
  }
  exportWherePath.textContent = abbreviatePath(exportWhereDir) || 'Choose folder…';
  exportGo.disabled = false;
  exportDialog.hidden = false;
  setTimeout(() => exportName.select(), 0);
}
function closeExportDialog() { exportDialog.hidden = true; }
exportDialog.addEventListener('click', (e) => {
  if (e.target.dataset && 'exportDismiss' in e.target.dataset) closeExportDialog();
});
exportWhereBtn.addEventListener('click', async () => {
  try {
    const dir = await invoke('pick_save_dir');
    if (dir) {
      exportWhereDir = dir;
      exportWherePath.textContent = abbreviatePath(dir);
    }
  } catch (e) { console.warn('[md4x] pick_save_dir failed', e); }
});
exportGo.addEventListener('click', async () => {
  let name = (exportName.value || '').trim();
  if (!name) name = 'untitled.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  if (!exportWhereDir) { toast('Pick a folder first'); return; }
  const outputPath = joinPath(exportWhereDir, name);
  const tmpl = exportTemplate.value || currentTemplate;
  exportGo.disabled = true;
  exportBtn.disabled = true;
  try {
    const path = await invoke('export_pdf', {
      md: editorText(),
      template: tmpl,
      outputPath,
      sourcePath: currentFilePath,
    });
    closeExportDialog();
    toast(`Exported → ${path.split('/').pop()}`);
    if (settings.revealOnExport) {
      try { await invoke('reveal_in_finder', { path }); }
      catch (e) { console.warn('[md4x] reveal failed', e); }
    }
  } catch (e) {
    console.error('[md4x] export_pdf failed', e);
    toast(`Export failed: ${e}`);
  } finally {
    exportGo.disabled = false;
    exportBtn.disabled = false;
  }
});

// ── Settings drawer ─────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark',  theme !== 'light');
}
function setSliderFill(el, min, max, value) {
  const pct = ((value - min) / (max - min)) * 100;
  el.style.setProperty('--pct', `${pct}%`);
}
function populateSettingsTemplates() {
  clearChildren(setDefaultTemplate);
  for (const t of availableTemplates) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === settings.defaultTemplate) opt.selected = true;
    setDefaultTemplate.appendChild(opt);
  }
}
function syncSettingsUI() {
  populateSettingsTemplates();
  setDebounce.value = settings.debounceMs;
  setDebounceVal.textContent = `${settings.debounceMs} ms`;
  setSliderFill(setDebounce, 0, 800, settings.debounceMs);
  setZoom.value = settings.zoomPct;
  setZoomVal.textContent = `${settings.zoomPct}%`;
  setSliderFill(setZoom, 50, 200, settings.zoomPct);
  document.querySelectorAll('.seg-opt').forEach(b => {
    const on = b.dataset.theme === settings.theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  setReveal.setAttribute('aria-checked', settings.revealOnExport ? 'true' : 'false');
}
function openSettings() {
  syncSettingsUI();
  settingsEl.hidden = false;
}
function closeSettings() { settingsEl.hidden = true; }
window.openSettings = openSettings;

settingsBtn.addEventListener('click', openSettings);
settingsEl.addEventListener('click', (e) => {
  if (e.target.dataset && 'settingsDismiss' in e.target.dataset) closeSettings();
});

setDefaultTemplate.addEventListener('change', () => {
  settings.defaultTemplate = setDefaultTemplate.value;
  saveSettings();
});
setDebounce.addEventListener('input', () => {
  const v = parseInt(setDebounce.value, 10);
  settings.debounceMs = v;
  setDebounceVal.textContent = `${v} ms`;
  setSliderFill(setDebounce, 0, 800, v);
  saveSettings();
});
setZoom.addEventListener('input', () => {
  const v = parseInt(setZoom.value, 10);
  settings.zoomPct = v;
  setZoomVal.textContent = `${v}%`;
  setSliderFill(setZoom, 50, 200, v);
  saveSettings();
  fitAll();
});
document.querySelectorAll('.seg-opt').forEach(b => {
  b.addEventListener('click', () => {
    settings.theme = b.dataset.theme;
    document.querySelectorAll('.seg-opt').forEach(x => {
      const on = x.dataset.theme === settings.theme;
      x.classList.toggle('active', on);
      x.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    applyTheme(settings.theme);
    saveSettings();
  });
});
setReveal.addEventListener('click', () => {
  settings.revealOnExport = !settings.revealOnExport;
  setReveal.setAttribute('aria-checked', settings.revealOnExport ? 'true' : 'false');
  saveSettings();
});

// ── Refit page preview on resize ────────────────────────────────────────────
const previewPaneEl = document.getElementById('preview-pane');
new ResizeObserver(() => fitAll()).observe(previewPaneEl);
window.addEventListener('resize', fitAll);

// ── Drag-and-drop (HTML5 fallback; primary path is Rust window event) ───────
async function setupDragDrop() {
  ['dragenter', 'dragover'].forEach(ev => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEditorContent(reader.result || '', null);
    reader.readAsText(file);
  });
  // Track cursor for the radial spotlight on the dropzone.
  dropzone.addEventListener('mousemove', (e) => {
    const rect = dropzone.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 100;
    const my = ((e.clientY - rect.top) / rect.height) * 100;
    dropzone.style.setProperty('--mx', `${mx}%`);
    dropzone.style.setProperty('--my', `${my}%`);
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop',     e => e.preventDefault());
}
newDraftBtn.addEventListener('click', newDraft);
if (openFileBtn) openFileBtn.addEventListener('click', () => { openFile(); });
if (welcomeClose) welcomeClose.addEventListener('click', hideWelcome);
welcome.addEventListener('mousedown', e => {
  if (e.target === welcome && (currentFilePath || editorText())) hideWelcome();
});

// Menu events from the native macOS menu bar (also wired via webview.eval).
if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('md4x_menu', (ev) => {
    if (ev.payload === 'open') showWelcome();
    else if (ev.payload === 'save') saveFile();
    else if (ev.payload === 'save_as') saveFileAs();
    else if (ev.payload === 'export' && !exportBtn.disabled) exportBtn.click();
    else if (ev.payload === 'new') {
      if (isDirty) showConfirmClose(); else newDraft();
    }
  });
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  applyTheme(settings.theme);
  currentTemplate = settings.defaultTemplate || 'magazine';
  availableTemplates = await invoke('list_templates');
  if (!availableTemplates.includes(currentTemplate)) currentTemplate = availableTemplates[0] || 'magazine';
  templateName.textContent = currentTemplate;
  tmplStatus.textContent = currentTemplate;

  // Mount CodeMirror. Doc changes mark dirty + schedule a render; the
  // built-in scroll listener drives preview sync.
  mountEditor('', (update) => {
    if (update.docChanged) {
      setDirty(true);
      updateCounts();
      scheduleRender();
    }
    // Cursor moved (typing, click, arrow keys) or doc changed — anchor the
    // preview to the cursor's block. Routed through the scroll-sync
    // coordinator (Phase B): the FSM tracks driver/driver state, the
    // existing syncPreviewFromCursor still does the math via the
    // resolveFromCursor callback wired in initScrollSync.
    if (update.docChanged || update.selectionSet) {
      const head = update.state.selection.main.head;
      const line = update.state.doc.lineAt(head).number;
      if (window.md4xScrollSync) {
        window.md4xScrollSync.dispatch({ type: 'editorCursor', line });
      } else {
        rafSchedSync('editorCursor', syncPreviewFromCursor);
      }
    }
    if (update.docChanged || update.selectionSet || update.geometryChanged || update.viewportChanged) {
      scheduleAlignmentTicks();
    }
    // Search query / active match changes → repaint preview highlights.
    syncSearchToPreview();
  });
  // Wire the custom search bar (full window-width, both panes).
  wireSearchBar();
  cm.scrollDOM.addEventListener('scroll', () => {
    scheduleAlignmentTicks();
    if (consumeExpectedScroll('editor', cm.scrollDOM.scrollTop)) return;
    rafSchedSync('editorScroll', syncPreviewFromEditor);
  }, { passive: true });
  // Driver detection: real wheel/touchmove on editor → editor is driver.
  cm.scrollDOM.addEventListener('wheel', () => {
    if (window.md4xAlignmentTicks) window.md4xAlignmentTicks.markUserScroll('editor');
  }, { passive: true });
  cm.scrollDOM.addEventListener('touchmove', () => {
    if (window.md4xAlignmentTicks) window.md4xAlignmentTicks.markUserScroll('editor');
  }, { passive: true });

  exportBtn.addEventListener('click', () => openExportDialog());

  await setupDragDrop();
  updateCounts();
  syncWindowTitle();
  await switchTemplate(currentTemplate);
  initAlignmentTicks();
  initScrollSync();
  scheduleAlignmentTicks();
  if (!editorText() && !currentFilePath) showWelcome();
}

init().catch(e => { console.error('[md4x] init failed', e); });
