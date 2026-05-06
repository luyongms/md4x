// md4x v0.2.0 — editor + live preview shell

// ── Tauri IPC ───────────────────────────────────────────────────────────────
function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// ── patchDOM (morphdom-lite) ─────────────────────────────────────────────────
// Surgically reconciles `from` against `to` in place, skipping subtrees whose
// `data-md4x-hash` attribute is unchanged. This is how we get zero white-frames
// on per-keystroke re-renders (the no-flash invariant).
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

// ── State ────────────────────────────────────────────────────────────────────
let currentTemplate = 'magazine';
let availableTemplates = [];
let activeFrame = 'a';
let renderTimer = null;
let bootstrapped = false;
let currentFilePath = null;
let isDirty = false;
let lastRenderMs = 0;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const editor       = document.getElementById('editor');
const iframeA      = document.getElementById('preview-a');
const iframeB      = document.getElementById('preview-b');
const filenameEl   = document.getElementById('filename');
const unsavedEl    = document.getElementById('unsaved');
const exportBtn    = document.getElementById('export-btn');
const templateBtn  = document.getElementById('template-btn');
const templateName = document.getElementById('template-name');
const stateEl      = document.getElementById('status-state');
const tmplStatus   = document.getElementById('status-template');
const countsEl     = document.getElementById('status-counts');
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

function activeIframe()   { return activeFrame === 'a' ? iframeA : iframeB; }
function inactiveIframe() { return activeFrame === 'a' ? iframeB : iframeA; }

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ── Status / dirty / title ──────────────────────────────────────────────────
function setStatus(s) { stateEl.textContent = s; }

function updateCounts() {
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const mermaidCount = (text.match(/^```mermaid\b/gm) || []).length;
  const inlineMath = (text.match(/(?<!\$)\$[^$\n]+?\$(?!\$)/g) || []).length;
  const displayMath = (text.match(/\$\$[\s\S]+?\$\$/g) || []).length;
  const mathCount = inlineMath + displayMath;
  const parts = [`${words} word${words !== 1 ? 's' : ''}`];
  if (mermaidCount) parts.push(`${mermaidCount} mermaid`);
  if (mathCount) parts.push(`${mathCount} math`);
  if (lastRenderMs > 0) parts.push(`render ${Math.round(lastRenderMs)} ms`);
  countsEl.textContent = parts.join(' · ');
}

function setDirty(v) {
  isDirty = !!v;
  unsavedEl.hidden = !isDirty;
  syncWindowTitle();
}

function syncWindowTitle() {
  const name = currentFilePath ? currentFilePath.split('/').pop() : 'Untitled';
  filenameEl.textContent = name;
  document.title = `${isDirty ? '• ' : ''}${name} — md4x`;
}

// ── Welcome / file lifecycle ────────────────────────────────────────────────
function showWelcome() {
  renderRecent();
  welcome.hidden = false;
}
function hideWelcome() { welcome.hidden = true; }

function setEditorContent(text, filePath) {
  editor.value = text;
  currentFilePath = filePath || null;
  setDirty(false);
  updateCounts();
  syncWindowTitle();
  hideWelcome();
  scheduleRender();
}

function newDraft() {
  setEditorContent('', null);
  editor.focus();
}
window.newDraft = newDraft;

// ── Recent files (localStorage) ─────────────────────────────────────────────
const RECENT_KEY = 'md4x.recent.v1';
const RECENT_MAX = 10;

function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}
function writeRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
  catch {}
}
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
    li.className = 'muted recent-empty';
    li.textContent = 'No recent files yet.';
    recentList.appendChild(li);
    return;
  }
  for (const path of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = path.split('/').pop() || path;
    name.title = path;
    name.addEventListener('click', () => openFromPath(path));
    const dir = document.createElement('span');
    dir.className = 'recent-path';
    const parent = path.replace(/\/[^/]*$/, '');
    dir.textContent = parent.replace(/^\/Users\/[^/]+/, '~');
    li.appendChild(name);
    li.appendChild(dir);
    recentList.appendChild(li);
  }
}

// ── File operations ─────────────────────────────────────────────────────────
async function openFile() {
  setStatus('opening…');
  try {
    const result = await invoke('open_file');
    if (!result) { setStatus('idle'); return; }
    pushRecent(result.path);
    setEditorContent(result.content, result.path);
    setStatus('idle');
  } catch (e) {
    console.error('[md4x] open_file failed', e);
    setStatus(`open failed: ${e}`);
  }
}
window.openFile = openFile;

async function openFromPath(path) {
  if (!path) return;
  setStatus('opening…');
  try {
    const result = await invoke('read_file', { path });
    pushRecent(result.path);
    setEditorContent(result.content, result.path);
    setStatus('idle');
  } catch (e) {
    console.error('[md4x] read_file failed', e);
    setStatus(`open failed: ${e}`);
  }
}
window.openFromPath = openFromPath;

async function saveFile() {
  if (!currentFilePath) return saveFileAs();
  setStatus('saving…');
  try {
    await invoke('save_file', { path: currentFilePath, content: editor.value });
    pushRecent(currentFilePath);
    setDirty(false);
    setStatus('idle');
  } catch (e) {
    console.error('[md4x] save_file failed', e);
    setStatus(`save failed: ${e}`);
  }
}
window.saveFile = saveFile;

async function saveFileAs() {
  setStatus('saving…');
  try {
    const suggested = currentFilePath
      ? currentFilePath.split('/').pop()
      : 'untitled.md';
    const result = await invoke('save_file_as', { content: editor.value, suggestedName: suggested });
    if (!result.path) { setStatus('idle'); return; }
    currentFilePath = result.path;
    pushRecent(result.path);
    setDirty(false);
    syncWindowTitle();
    setStatus('idle');
  } catch (e) {
    console.error('[md4x] save_file_as failed', e);
    setStatus(`save failed: ${e}`);
  }
}
window.saveFileAs = saveFileAs;

// ── Confirm-on-close ────────────────────────────────────────────────────────
function showConfirmClose() {
  if (!isDirty) {
    invoke('close_window');
    return;
  }
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
confirmCancel.addEventListener('click', () => {
  confirmEl.hidden = true;
});

// ── Mermaid / KaTeX re-render after morphdom ────────────────────────────────
function rerenderNewBlocks(iframe) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;
  const merBlocks = Array.from(doc.querySelectorAll('pre.mermaid:not([data-processed])'));
  if (merBlocks.length > 0 && win.mermaid) {
    try {
      if (typeof win.mermaid.run === 'function') {
        win.mermaid.run({ nodes: merBlocks });
      } else if (typeof win.mermaid.init === 'function') {
        win.mermaid.init(undefined, merBlocks);
      }
    } catch (e) { console.warn('[md4x] mermaid re-render', e); }
  }
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

function applyRender(iframe, html) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const newDoc = new DOMParser().parseFromString(html, 'text/html');
  patchDOM(doc.body, newDoc.body);
  rerenderNewBlocks(iframe);
  fitPage(iframe);
}

function bootstrapIframe(iframe, html) {
  return new Promise(resolve => {
    iframe.addEventListener('load', () => {
      attachIframeHandlers(iframe);
      resolve();
    }, { once: true });
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
  doc.addEventListener('wheel', e => {
    win.scrollBy(e.deltaX, e.deltaY);
  }, { passive: true, capture: true });
  fitPage(iframe);
  if (win.ResizeObserver) {
    new win.ResizeObserver(() => scheduleTailTrim(iframe))
      .observe(doc.body);
  }
}

// ── Page fit (A4-zoom-to-fit) ───────────────────────────────────────────────
const A4_WIDTH_MM = 210;
const PX_PER_MM   = 96 / 25.4;
const PAGE_PAD_PX = 24 * 2;

function fitPage(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const targetPx = A4_WIDTH_MM * PX_PER_MM;
  const avail    = iframe.clientWidth - PAGE_PAD_PX;
  if (avail <= 0) return;
  const scale = Math.max(0.25, avail / targetPx);
  doc.body.style.transform = `scale(${scale})`;
  scheduleTailTrim(iframe);
}

const tailTrimTimers = new WeakMap();
const TAIL_TRIM_DELAY_MS = 250;

function scheduleTailTrim(iframe) {
  const prev = tailTrimTimers.get(iframe);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    tailTrimTimers.delete(iframe);
    trimTail(iframe);
  }, TAIL_TRIM_DELAY_MS);
  tailTrimTimers.set(iframe, timer);
}

function trimTail(iframe) {
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  const targetPx = A4_WIDTH_MM * PX_PER_MM;
  const avail    = iframe.clientWidth - PAGE_PAD_PX;
  if (avail <= 0) return;
  const scale = Math.max(0.25, avail / targetPx);
  const overhang = doc.body.offsetHeight * (1 - scale);
  const current = -parseFloat(doc.body.style.marginBottom || '0');
  if (Math.abs(current - overhang) < 1) return;
  doc.body.style.setProperty('margin-bottom', `${-overhang}px`, 'important');
}

function fitAll() {
  fitPage(iframeA);
  fitPage(iframeB);
}

// ── Core render pipeline ─────────────────────────────────────────────────────
async function render() {
  setStatus('rendering…');
  const t0 = performance.now();
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
  lastRenderMs = performance.now() - t0;
  updateCounts();
  setStatus('idle');
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

// ── Template switching (fade-swap) ───────────────────────────────────────────
async function switchTemplate(newTemplate) {
  currentTemplate = newTemplate;
  templateName.textContent = newTemplate;
  tmplStatus.textContent = newTemplate;
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
  const active = activeIframe();
  inactive.style.opacity = '1';
  inactive.style.pointerEvents = '';
  active.style.opacity = '0';
  active.style.pointerEvents = 'none';
  activeFrame = activeFrame === 'a' ? 'b' : 'a';
  bootstrapped = true;
  setStatus('idle');
}

// ── Template gallery (SVG previews) ─────────────────────────────────────────
// SVG illustrations from the v0.2.0 GUI mockups (docs/design/v0.2.0-gui-mockups.md).
// Strings are static literals — no user input flows in — and parsed via
// DOMParser into SVG documents that are then appended directly.
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
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t;
    tile.appendChild(name);
    tile.addEventListener('click', () => {
      gallery.hidden = true;
      if (t !== currentTemplate) switchTemplate(t);
    });
    galleryGrid.appendChild(tile);
  }
}

templateBtn.addEventListener('click', () => {
  buildGallery();
  gallery.hidden = false;
});
galleryClose.addEventListener('click', () => { gallery.hidden = true; });
gallery.addEventListener('click', (e) => {
  if (e.target === gallery) gallery.hidden = true;
});

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
  window.addEventListener('blur', endDrag);
  document.addEventListener('mouseleave', endDrag);
})();

// ── Trackpad/wheel scroll forwarding ────────────────────────────────────────
document.getElementById('preview-pane').addEventListener('wheel', (e) => {
  const win = activeIframe().contentWindow;
  if (win) win.scrollBy(e.deltaX, e.deltaY);
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
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'o' && !e.shiftKey && !e.altKey) {
    e.preventDefault(); openFile();
  } else if (k === 's' && !e.shiftKey && !e.altKey) {
    e.preventDefault(); saveFile();
  } else if (k === 's' && e.shiftKey && !e.altKey) {
    e.preventDefault(); saveFileAs();
  } else if (k === 'e' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (!exportBtn.disabled) exportBtn.click();
  } else if (k === 'n' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (isDirty) {
      showConfirmClose();
    } else {
      newDraft();
    }
  }
});

// ── Refit page preview on resize ────────────────────────────────────────────
const previewPaneEl = document.getElementById('preview-pane');
new ResizeObserver(() => fitAll()).observe(previewPaneEl);
window.addEventListener('resize', fitAll);

// ── Drag-and-drop (Tauri file drop event + HTML5 fallback) ──────────────────
async function setupDragDrop() {
  const t = window.__TAURI__;
  if (t && t.event) {
    try {
      await t.event.listen('tauri://drag-enter', () => document.body.classList.add('window-dragover'));
      await t.event.listen('tauri://drag-leave', () => document.body.classList.remove('window-dragover'));
      await t.event.listen('tauri://drag-drop', (ev) => {
        document.body.classList.remove('window-dragover');
        const paths = ev.payload && (ev.payload.paths || ev.payload);
        const path = Array.isArray(paths) ? paths[0] : null;
        if (path && /\.(md|markdown|mdx)$/i.test(path)) {
          openFromPath(path);
        }
      });
    } catch (e) {
      console.warn('[md4x] tauri drag-drop listen failed', e);
    }
  }
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
      if (isDirty) showConfirmClose();
      else newDraft();
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  availableTemplates = await invoke('list_templates');
  templateName.textContent = currentTemplate;
  tmplStatus.textContent = currentTemplate;

  editor.addEventListener('input', () => {
    setDirty(true);
    updateCounts();
    scheduleRender();
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

  await setupDragDrop();

  updateCounts();
  syncWindowTitle();
  await switchTemplate(currentTemplate);
  if (!editor.value && !currentFilePath) showWelcome();
}

init().catch(e => {
  console.error('[md4x] init failed', e);
  stateEl.textContent = 'init failed: ' + e;
});
