// md4x Phase C — editor + live preview

// ── Tauri IPC ───────────────────────────────────────────────────────────────
function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// ── patchDOM (morphdom-lite) ─────────────────────────────────────────────────
// Surgically reconciles `from` against `to` in place, skipping subtrees whose
// `data-md4x-hash` attribute is unchanged. This is how we get zero white-frames
// on per-keystroke re-renders (the no-flash invariant).
function patchDOM(from, to) {
  // Different node types: replace wholesale
  if (from.nodeType !== to.nodeType) {
    from.parentNode.replaceChild(to.cloneNode(true), from);
    return;
  }
  // Text / comment nodes
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from.nodeType !== 1) return;

  // Element: different tag → replace
  if (from.tagName !== to.tagName) {
    from.parentNode.replaceChild(to.cloneNode(true), from);
    return;
  }

  // Hash skip: if both sides have the same data-md4x-hash, keep existing subtree
  // (preserves rendered mermaid SVGs and KaTeX nodes without re-rendering).
  const fromHash = from.dataset && from.dataset.md4xHash;
  const toHash = to.dataset && to.dataset.md4xHash;
  if (fromHash && toHash && fromHash === toHash) return;

  // Sync attributes
  for (const {name, value} of to.attributes) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const {name} of Array.from(from.attributes)) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }

  // Sync children (positional)
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

// ── State ────────────────────────────────────────────────────────────────────
let currentTemplate = 'magazine';
let activeFrame = 'a';     // 'a' or 'b'
let renderTimer = null;
let bootstrapped = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const editor     = document.getElementById('editor');
const iframeA    = document.getElementById('preview-a');
const iframeB    = document.getElementById('preview-b');
const tmplSelect = document.getElementById('template-select');
const filenameEl = document.getElementById('filename');
const unsavedEl  = document.getElementById('unsaved');
const exportBtn  = document.getElementById('export-btn');
const wordsEl    = document.getElementById('status-words');
const linesEl    = document.getElementById('status-lines');
const stateEl    = document.getElementById('status-state');

function activeIframe()   { return activeFrame === 'a' ? iframeA : iframeB; }
function inactiveIframe() { return activeFrame === 'a' ? iframeB : iframeA; }

// ── Status bar ───────────────────────────────────────────────────────────────
function setStatus(s) { stateEl.textContent = s; }

function updateWordCount() {
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text.split('\n').length;
  wordsEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  linesEl.textContent = `${lines} line${lines !== 1 ? 's' : ''}`;
}

// ── Unsaved indicator ────────────────────────────────────────────────────────
function markUnsaved() { unsavedEl.hidden = false; }
function markSaved()   { unsavedEl.hidden = true; }

// ── Post-patch: re-render newly inserted mermaid/KaTeX blocks ─────────────────
// After patchDOM, blocks whose data-md4x-hash matched are untouched (their
// existing rendered SVGs / KaTeX nodes survive). Blocks with no hash match were
// replaced with fresh HTML-only nodes. We trigger rendering for those now.
function rerenderNewBlocks(iframe) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;

  // Mermaid: blocks without data-processed are unrendered
  const merBlocks = Array.from(doc.querySelectorAll('pre.mermaid:not([data-processed])'));
  if (merBlocks.length > 0 && win.mermaid) {
    try {
      if (typeof win.mermaid.run === 'function') {
        win.mermaid.run({ nodes: merBlocks });          // Mermaid 10+
      } else if (typeof win.mermaid.init === 'function') {
        win.mermaid.init(undefined, merBlocks);         // Mermaid 9
      }
    } catch (e) { console.warn('[md4x] mermaid re-render', e); }
  }

  // KaTeX: spans without data-katex-rendered are unrendered
  const mathSpans = doc.querySelectorAll('span[data-math-style]:not([data-katex-rendered])');
  if (mathSpans.length > 0 && win.katex) {
    mathSpans.forEach(el => {
      const display = el.dataset.mathStyle === 'display';
      try {
        win.katex.render(el.textContent, el, { throwOnError: false, displayMode: display });
        el.dataset.katexRendered = '1';
      } catch (e) {}
    });
  }
}

// ── Apply a render result to an iframe ───────────────────────────────────────
// Parses the full HTML, then morphdom-patches only the <body> into the live
// iframe. Scripts / styles in <head> are intentionally ignored after bootstrap.
function applyRender(iframe, html) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const newDoc = new DOMParser().parseFromString(html, 'text/html');
  patchDOM(doc.body, newDoc.body);
  rerenderNewBlocks(iframe);
  fitPage(iframe);
}

// ── Bootstrap an iframe (first load per template) ─────────────────────────────
// Sets srcdoc to the full HTML so CSS + scripts load inside the iframe's
// isolated world. Returns a Promise that resolves after load.
function bootstrapIframe(iframe, html) {
  return new Promise(resolve => {
    iframe.addEventListener('load', () => {
      attachIframeHandlers(iframe);
      resolve();
    }, { once: true });
    iframe.srcdoc = html;
  });
}

// Inside-iframe handlers: suppress right-click context menu and forward
// wheel events to the iframe's own window.
function attachIframeHandlers(iframe) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;
  doc.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); }, true);
  doc.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); } }, true);
  doc.addEventListener('mouseup',   e => { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); } }, true);
  doc.addEventListener('wheel', e => {
    win.scrollBy(e.deltaX, e.deltaY);
  }, { passive: true, capture: true });
  fitPage(iframe);
}

// ── Page fit (A4-zoom-to-fit) ───────────────────────────────────────────────
// The preview body is laid out as a fixed 210mm-wide page (see PREVIEW_CSS in
// main.rs). We scale it via CSS `zoom` so it always fits the iframe width
// without reflowing — the goal is a "magazine page on a desk", not a
// flowing-text browser preview.
const A4_WIDTH_MM = 210;
const PX_PER_MM   = 96 / 25.4; // CSS px per mm at 96dpi → ~3.7795
const PAGE_PAD_PX = 24 * 2;    // matches html { padding: 24px } in PREVIEW_CSS

function fitPage(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const targetPx = A4_WIDTH_MM * PX_PER_MM;
  const avail    = iframe.clientWidth - PAGE_PAD_PX;
  if (avail <= 0) return;
  const scale    = Math.min(1, Math.max(0.25, avail / targetPx));
  // transform: scale (not zoom) — WebKit's `zoom` doesn't propagate into SVG
  // content, so mermaid/KaTeX render at natural size while body text shrinks,
  // making diagrams look 2x oversized. transform: scale applies uniformly.
  //
  // With transform-origin: top left, body's visual-left == layout-left, so
  // the centering math falls out of the natural margin: 0 auto + html padding
  // behavior: when scale = avail/target, left-gray = right-gray = 24px.
  //
  // NOTE: transform: scale doesn't shrink the layout box, so the iframe has
  // some empty gray "tail" below the visual page bottom (= body.height × (1
  // - scale)). Earlier attempt to compensate via negative margin-bottom
  // caused WKWebView to drop the scroll layer on rapid height changes after
  // paste — the tail-space is the lesser of two evils until we find a
  // non-WebKit-hostile compensation.
  doc.body.style.transform = `scale(${scale})`;
}

function fitAll() {
  fitPage(iframeA);
  fitPage(iframeB);
}

// ── Core render pipeline ─────────────────────────────────────────────────────
async function render() {
  setStatus('rendering…');
  let result;
  try {
    result = await invoke('render_html', { md: editor.value, template: currentTemplate });
  } catch (e) {
    setStatus('error');
    console.error('[md4x] render_html failed', e);
    return;
  }

  const iframe = activeIframe();
  if (!bootstrapped) {
    await bootstrapIframe(iframe, result.html);
    bootstrapped = true;
  } else {
    applyRender(iframe, result.html);
  }
  setStatus('idle');
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

// ── Template switching (fade-swap) ───────────────────────────────────────────
// Renders into the *off-screen* iframe, then fades it in while the current one
// fades out. User never sees a white frame.
async function switchTemplate(newTemplate) {
  currentTemplate = newTemplate;
  setStatus('switching template…');

  let result;
  try {
    result = await invoke('render_html', { md: editor.value, template: newTemplate });
  } catch (e) {
    setStatus('error');
    return;
  }

  const inactive = inactiveIframe();
  await bootstrapIframe(inactive, result.html);

  // Swap visibility with CSS transition
  const active = activeIframe();
  inactive.style.opacity = '1';
  inactive.style.pointerEvents = '';
  active.style.opacity = '0';
  active.style.pointerEvents = 'none';
  activeFrame = activeFrame === 'a' ? 'b' : 'a';
  bootstrapped = true;
  setStatus('idle');
}

// ── Resizer ──────────────────────────────────────────────────────────────────
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
    const total = panes.getBoundingClientRect().width - 5;
    const w = Math.max(160, Math.min(total - 160, startW + e.clientX - startX));
    editorPane.style.flex = 'none';
    editorPane.style.width = w + 'px';
  });

  document.addEventListener('mouseup', endDrag);
  // Safety nets: if the cursor leaves the window or focus shifts, end the drag.
  window.addEventListener('blur', endDrag);
  document.addEventListener('mouseleave', endDrag);
})();

// ── Trackpad/wheel scroll forwarding ─────────────────────────────────────────
// Wheel events that land on the iframe element itself (rather than its inner
// document) get caught here as a fallback. The primary handler is attached
// inside each iframe via attachIframeHandlers().
document.getElementById('preview-pane').addEventListener('wheel', (e) => {
  const win = activeIframe().contentWindow;
  if (win) win.scrollBy(e.deltaX, e.deltaY);
}, { passive: true });

// ── Suppress native context menu (outer document) ───────────────────────────
// WKWebView on macOS dispatches its native menu off mouseDown for the right
// button — sometimes before contextmenu fires, sometimes alongside. Block
// both events, capture phase, with stopPropagation for belt and suspenders.
function killContextMenu(e) { e.preventDefault(); e.stopPropagation(); }
function killRightMouse(e)  { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); } }
window.addEventListener('contextmenu', killContextMenu, true);
document.addEventListener('contextmenu', killContextMenu, true);
window.addEventListener('mousedown', killRightMouse, true);
window.addEventListener('mouseup',   killRightMouse, true);

// ── Cmd+S / Ctrl+S → export PDF ─────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (exportBtn && !exportBtn.disabled) exportBtn.click();
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openFile();
  }
});

// ── File open ───────────────────────────────────────────────────────────────
async function openFile() {
  setStatus('opening…');
  try {
    const result = await invoke('open_file');
    if (!result) { setStatus('idle'); return; }
    editor.value = result.content;
    const name = result.path.split('/').pop() || 'Untitled';
    filenameEl.textContent = name;
    markSaved();
    updateWordCount();
    setStatus('idle');
    scheduleRender();
  } catch (e) {
    console.error('[md4x] open_file failed', e);
    setStatus(`open failed: ${e}`);
  }
}

// Menu events from the native macOS menu bar (File → Open…, Export PDF…).
// Expose openFile globally so the listener (and any other path) can call it.
window.openFile = openFile;
if (window.__TAURI__ && window.__TAURI__.event) {
  const handler = (ev) => {
    if (ev.payload === 'open') openFile();
    else if (ev.payload === 'export' && exportBtn && !exportBtn.disabled) exportBtn.click();
  };
  // Listen via both the global event bus and the per-webview channel — the
  // Rust side emits on both. Whichever is delivered first wins.
  window.__TAURI__.event.listen('md4x_menu', handler);
}

// ── Refit page preview on resize ────────────────────────────────────────────
const previewPaneEl = document.getElementById('preview-pane');
const resizeObs = new ResizeObserver(() => fitAll());
resizeObs.observe(previewPaneEl);
window.addEventListener('resize', fitAll);

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Populate template dropdown
  const templates = await invoke('list_templates');
  templates.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === currentTemplate) opt.selected = true;
    tmplSelect.appendChild(opt);
  });

  // Wire events
  editor.addEventListener('input', () => {
    markUnsaved();
    updateWordCount();
    scheduleRender();
  });

  tmplSelect.addEventListener('change', () => {
    switchTemplate(tmplSelect.value);
  });

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    setStatus('exporting PDF…');
    try {
      const path = await invoke('export_pdf', {
        md: editor.value,
        template: currentTemplate,
      });
      setStatus(`exported → ${path}`);
    } catch (e) {
      console.error('[md4x] export_pdf failed', e);
      setStatus(`export failed: ${e}`);
    } finally {
      exportBtn.disabled = false;
    }
  });

  // Initial render: route through switchTemplate. The user has confirmed
  // this is the only flow that wakes WKWebView's iframe scroll layer
  // reliably on cold start. End state: iframeB is bootstrapped with content
  // and becomes the active iframe; iframeA stays empty and hidden. From
  // then on, all renders patch into iframeB until the user switches
  // template, which will bootstrap iframeA via the same flow.
  updateWordCount();
  await switchTemplate(currentTemplate);
}

init().catch(e => {
  console.error('[md4x] init failed', e);
  stateEl.textContent = 'init failed: ' + e;
});
