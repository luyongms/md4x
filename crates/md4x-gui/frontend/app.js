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
}

// ── Bootstrap an iframe (first load per template) ─────────────────────────────
// Sets srcdoc to the full HTML so CSS + scripts load inside the iframe's
// isolated world. Returns a Promise that resolves after load.
function bootstrapIframe(iframe, html) {
  return new Promise(resolve => {
    iframe.addEventListener('load', resolve, { once: true });
    iframe.srcdoc = html;
  });
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

  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = editorPane.getBoundingClientRect().width;
    resizer.classList.add('dragging');
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

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Trackpad/wheel scroll forwarding ─────────────────────────────────────────
// WKWebView on macOS does not propagate trackpad scroll events into nested
// iframes. We intercept them at the preview-pane level and forward via scrollBy.
document.getElementById('preview-pane').addEventListener('wheel', (e) => {
  const win = activeIframe().contentWindow;
  if (win) win.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'instant' });
}, { passive: true });

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

  exportBtn.addEventListener('click', () => {
    setStatus('rendering…');
    // Phase D will wire this to tauri-plugin-dialog + export_pdf command
    setStatus('export: coming in Phase D');
  });

  // Initial render
  updateWordCount();
  await render();
}

init().catch(e => {
  console.error('[md4x] init failed', e);
  stateEl.textContent = 'init failed: ' + e;
});
