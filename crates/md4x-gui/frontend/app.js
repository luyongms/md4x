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

// ── Bidirectional scroll sync (proportional / ratio) ────────────────────────
// Map editor scrollTop / scrollMax → preview scrollTop / scrollMax.
//
// Bounce-back avoidance: when we programmatically set scrollTop on either
// side, the resulting scroll event would ping back and re-sync the source,
// potentially with a different rounded value (jitter). We track the last
// value we *wrote* to each side and ignore scroll events that match it
// within a small tolerance — those are the bounce-back events, not user
// input. A time-based lock is unreliable because WKWebView fires scroll
// events asynchronously across multiple frames.
let editorExpected  = null; // scrollTop we just wrote to cm.scrollDOM
let previewExpected = null; // scrollY  we just wrote to the iframe window
const SCROLL_TOLERANCE_PX = 2;

function syncPreviewFromEditor() {
  if (!cm) return;
  const iframe = activeIframe();
  const win = iframe.contentWindow;
  if (!win || !win.document || !win.document.documentElement) return;
  const sd = cm.scrollDOM;
  const editorMax = sd.scrollHeight - sd.clientHeight;
  if (editorMax <= 0) return;
  const ratio = sd.scrollTop / editorMax;
  const previewMax = win.document.documentElement.scrollHeight - win.innerHeight;
  if (previewMax <= 0) return;
  const target = ratio * previewMax;
  previewExpected = Math.round(target);
  win.scrollTo(0, target);
}

function syncEditorFromPreview(win) {
  if (!cm) return;
  if (!win || !win.document || !win.document.documentElement) return;
  const previewMax = win.document.documentElement.scrollHeight - win.innerHeight;
  if (previewMax <= 0) return;
  const ratio = win.scrollY / previewMax;
  const sd = cm.scrollDOM;
  const editorMax = sd.scrollHeight - sd.clientHeight;
  if (editorMax <= 0) return;
  const target = ratio * editorMax;
  editorExpected = Math.round(target);
  sd.scrollTop = target;
}

// Returns true if the incoming scroll position matches what we just wrote
// (i.e. it's our own bounce-back, not a user scroll). Clears the expected
// value either way — only the FIRST matching event is suppressed.
function consumeExpectedScroll(side, currentPos) {
  const ref = side === 'editor' ? editorExpected : previewExpected;
  if (side === 'editor') editorExpected = null;
  else                   previewExpected = null;
  return ref !== null && Math.abs(Math.round(currentPos) - ref) <= SCROLL_TOLERANCE_PX;
}

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
function showWelcome() { renderRecent(); welcome.hidden = false; }
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
const undefTargetName = document.getElementById('undef-target-name');

let lastUndefMacros = []; // sorted unique array

function scanAndReportUndefMacros(iframe) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  // KaTeX wraps every render error in `<span class="katex-error" title="...">`
  // where the title is the exact ParseError message — including the
  // failing control sequence. The text content is the *whole* failing
  // expression so we deliberately ignore it (it would over-report).
  // Our KaTeX bundle doesn't expose the modern `errorCallback` option,
  // so the title attribute is the only reliable signal.
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
  } else {
    undefTargetName.textContent = '<filename>.macros.json';
    undefTemplateBtn.disabled = true;
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
  } catch (e) {
    console.error('[md4x] write_macros_template failed', e);
    toast(`Template write failed: ${e}`);
  } finally {
    undefTemplateBtn.disabled = false;
  }
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
    if (consumeExpectedScroll('preview', win.scrollY)) return;
    syncEditorFromPreview(win);
  }, { passive: true });
  fitPage(iframe);
  if (win.ResizeObserver) {
    new win.ResizeObserver(() => {
      scheduleTailTrim(iframe);
    }).observe(doc.body);
  }
}

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
  inactive.style.pointerEvents = '';
  active.style.opacity = '0';
  active.style.pointerEvents = 'none';
  activeFrame = activeFrame === 'a' ? 'b' : 'a';
  bootstrapped = true;
  lastUserMacrosJson = result.user_macros || '';
  scanAndReportUndefMacros(inactive);
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
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = editorPane.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    panes.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const total = panes.getBoundingClientRect().width - 1;
    const w = Math.max(160, Math.min(total - 160, startW + e.clientX - startX));
    editorPane.style.flex = 'none';
    editorPane.style.width = w + 'px';
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
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'o' && !e.shiftKey && !e.altKey) { e.preventDefault(); openFile(); }
  else if (k === 's' && !e.shiftKey && !e.altKey) { e.preventDefault(); saveFile(); }
  else if (k === 's' && e.shiftKey && !e.altKey) { e.preventDefault(); saveFileAs(); }
  else if (k === 'e' && !e.shiftKey && !e.altKey) { e.preventDefault(); if (!exportBtn.disabled) exportBtn.click(); }
  else if (k === 'n' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (isDirty) showConfirmClose(); else newDraft();
  }
  else if (e.key === ',' && !e.shiftKey && !e.altKey) { e.preventDefault(); openSettings(); }
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
  setSliderFill(setDebounce, 50, 800, settings.debounceMs);
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
  setSliderFill(setDebounce, 50, 800, v);
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

// Menu events from the native macOS menu bar (also wired via webview.eval).
if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('md4x_menu', (ev) => {
    if (ev.payload === 'open') openFile();
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
  });
  cm.scrollDOM.addEventListener('scroll', () => {
    if (consumeExpectedScroll('editor', cm.scrollDOM.scrollTop)) return;
    syncPreviewFromEditor();
  }, { passive: true });

  exportBtn.addEventListener('click', () => openExportDialog());

  await setupDragDrop();
  updateCounts();
  syncWindowTitle();
  await switchTemplate(currentTemplate);
  if (!editorText() && !currentFilePath) showWelcome();
}

init().catch(e => { console.error('[md4x] init failed', e); });
