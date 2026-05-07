// Scroll-alignment ticks: dual gutter strips with drift auto-correction.
// Spec: docs/spec/v0.2.3-scroll-alignment-ticks.md
//
// This module owns the two tick strip overlays and a driver-state machine.
// All math is in alignment-math.js; this module only handles DOM, events,
// and the auto-correction dispatcher.
//
// Coupling to app.js is via a small bridge object passed to init() — no
// direct reads of app.js internals beyond what the bridge exposes.

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.md4xAlignmentTicks = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const STRIP_WIDTH_PX        = 14;
  const TICK_LEN_BLOCK        =  6;
  const TICK_LEN_HEADING      = 12;
  const SUB_OFFSET_THRESHOLD  =  2;
  const CORRECT_SETTLE_MS     = 50;
  const CORRECT_GUARD_MS      = 200;
  const DRIVER_DECAY_MS       = 600;

  let math    = null;
  let bridge  = null;
  let editorStrip  = null;
  let previewStrip = null;

  let lastUserScrollSource  = null;     // 'editor' | 'preview' | null
  let lastUserScrollTime    = 0;
  let correctionGuardUntil  = 0;
  let settleTimer           = null;
  let rafScheduled          = false;
  let installed             = false;
  let splitterDragging      = false;

  function init(opts) {
    if (installed) return;
    bridge = opts.bridge;
    math   = root.md4xAlignmentMath || (typeof require === 'function' ? require('./alignment-math.js') : null);
    if (!math) { console.warn('[md4x] alignment-math unavailable'); return; }

    editorStrip  = createStrip('md4x-tick-strip-editor');
    previewStrip = createStrip('md4x-tick-strip-preview');
    opts.editorPane .appendChild(editorStrip);
    opts.previewPane.appendChild(previewStrip);

    installed = true;
  }

  function createStrip(extraClass) {
    const el = document.createElement('div');
    el.className = 'md4x-tick-strip ' + extraClass;
    el.style.width = STRIP_WIDTH_PX + 'px';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function setSplitterDragActive(active) {
    splitterDragging = !!active;
    if (!editorStrip) return;
    editorStrip .classList.toggle('drag', !!active);
    previewStrip.classList.toggle('drag', !!active);
    // On drag start, clear ticks immediately so the layout doesn't flicker
    // through stale positions while we suppress further work.
    if (splitterDragging) {
      clearStrip(editorStrip);
      clearStrip(previewStrip);
    }
  }

  // markUserScroll: called from real wheel/touchmove/keydown handlers in
  // each pane. Programmatic scrolls do NOT call this.
  function markUserScroll(side) {
    lastUserScrollSource = side;
    lastUserScrollTime   = Date.now();
  }

  function currentDriver() {
    if (!lastUserScrollSource) return null;
    if (Date.now() - lastUserScrollTime > DRIVER_DECAY_MS) return null;
    return lastUserScrollSource;
  }

  // schedule(): coalesce multiple per-frame requests into one RAF render.
  function schedule() {
    if (!installed || rafScheduled || splitterDragging) return;
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; render(); });
  }

  function render() {
    if (!installed || splitterDragging) return;
    const ed = bridge.getEditorState();
    const pv = bridge.getPreviewState();
    clearStrip(editorStrip);
    clearStrip(previewStrip);
    if (!ed || !pv) return;
    paintStrip(editorStrip,  ed);
    paintStrip(previewStrip, pv);
  }

  function clearStrip(strip) {
    while (strip.firstChild) strip.removeChild(strip.firstChild);
  }

  function makeTick(cls, top, left, width) {
    const el = document.createElement('div');
    el.className = cls;
    el.style.top    = top    + 'px';
    el.style.left   = left   + 'px';
    el.style.width  = width  + 'px';
    return el;
  }

  // Red tick anchor (v0.2.3 revised): cursor-anchored.
  //  - If cursor's block is in this pane's viewport, place tick at block top.
  //  - Otherwise place tick at viewport center.
  // Both panes use the SAME cursor ordinal (cursor lives in editor; preview
  // mirrors its matching block by ordinal). Diagnostic value: both ticks
  // converge on the cursor's block when synced, diverge otherwise.
  function paintStrip(strip, state) {
    const { tops, kinds, scrollTop, viewportH, cursorTickY } = state;
    if (!tops || !tops.length || viewportH <= 0) return;
    const stripH = strip.clientHeight || viewportH;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < tops.length; i++) {
      const y = math.tickY(tops[i], scrollTop);
      if (y < -8 || y > stripH + 8) continue;
      const isHeading = math.isHeadingKind(kinds[i]);
      const cls = 'tick ' + (isHeading ? 'tick-heading' : 'tick-block');
      const len = isHeading ? TICK_LEN_HEADING : TICK_LEN_BLOCK;
      const inset = (STRIP_WIDTH_PX - len) / 2;
      frag.appendChild(makeTick(cls, y, inset, len));
    }

    // Red tick: caller passes precise cursorTickY (or null if off-viewport).
    // Off-viewport → render at center of strip with dim styling.
    let cy = -1;
    let off = false;
    if (cursorTickY != null && cursorTickY >= 0 && cursorTickY <= stripH) {
      cy = cursorTickY;
    } else if (state.cursorOrdinal != null && state.cursorOrdinal >= 0) {
      cy = Math.round(stripH / 2);
      off = true;
    }
    if (cy >= 0) {
      const cls = 'tick tick-current' + (off ? ' tick-current-off' : '');
      const RED_H = 12;
      frag.appendChild(makeTick(cls, Math.round(cy - RED_H / 2), 0, STRIP_WIDTH_PX));
    }
    strip.appendChild(frag);
  }

  // ── Auto-correction ───────────────────────────────────────────────────────
  function scheduleAutoCorrect() {
    if (splitterDragging) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      tryAutoCorrect();
    }, CORRECT_SETTLE_MS);
  }

  function tryAutoCorrect() {
    if (!installed) return;
    const driver = currentDriver();
    if (!driver) return;
    if (bridge.isSyncSuspended && bridge.isSyncSuspended()) return;
    if (bridge.isSmoothScrollLocked && bridge.isSmoothScrollLocked()) return;
    if (Date.now() < correctionGuardUntil) return;

    const ed = bridge.getEditorState();
    const pv = bridge.getPreviewState();
    if (!ed || !pv) return;
    const dState = driver === 'editor' ? ed : pv;
    const fState = driver === 'editor' ? pv : ed;
    if (!dState.tops.length || !fState.tops.length) return;

    const drift = math.hasDrift(
      dState.tops, dState.scrollTop,
      fState.tops, fState.scrollTop,
      SUB_OFFSET_THRESHOLD
    );
    if (!drift) return;

    const target = math.correctionTarget(dState.tops, dState.scrollTop, fState.tops);
    correctionGuardUntil = Date.now() + CORRECT_GUARD_MS;
    if (driver === 'editor' && typeof bridge.smoothScrollPreviewTo === 'function') {
      bridge.smoothScrollPreviewTo(target);
    } else if (driver === 'preview' && typeof bridge.smoothScrollEditorTo === 'function') {
      bridge.smoothScrollEditorTo(target);
    }
  }

  return {
    init,
    schedule,
    render,
    markUserScroll,
    scheduleAutoCorrect,
    setSplitterDragActive,
    _state: () => ({
      driver: currentDriver(),
      lastUserScrollSource,
      lastUserScrollTime,
      correctionGuardUntil,
    }),
  };
});
