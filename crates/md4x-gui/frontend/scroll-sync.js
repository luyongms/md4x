// scroll-sync.js — single coordinator for editor↔preview scroll, cursor,
// and click sync. Spec: docs/spec/v0.2.5-scroll-sync.md.
//
// Layered:
//   - Pure math primitives (folded in from alignment-math.js).
//   - Pure reducer:   reduce(state, action) → { state, outputs[] }
//   - Side-effects shell (init/dispatch/wireup) — added in later phases.
//
// Tests target the reducer + math directly (no DOM).

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md4xScrollSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Math (folded from alignment-math.js, kept identical semantics) ──────

  function currentBlock(tops, scrollTop) {
    if (!tops || tops.length === 0) return -1;
    if (scrollTop < tops[0]) return 0;
    let lo = 0, hi = tops.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] <= scrollTop) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }
  function tickY(top, scrollTop) { return top - scrollTop; }
  function tickYClampedForCurrent(top, scrollTop, stripHeight) {
    const y = top - scrollTop;
    if (y < 0) return 0;
    if (y > stripHeight) return stripHeight;
    return y;
  }
  function hasDrift(driverTops, driverScroll, followerTops, followerScroll, threshold) {
    const dOrd = currentBlock(driverTops, driverScroll);
    const fOrd = currentBlock(followerTops, followerScroll);
    if (dOrd === -1 || fOrd === -1) return false;
    if (dOrd !== fOrd) return true;
    const dSub = driverScroll  - driverTops[dOrd];
    const fSub = followerScroll - followerTops[fOrd];
    return Math.abs(dSub - fSub) > threshold;
  }
  function correctionTarget(driverTops, driverScroll, followerTops) {
    const ord = currentBlock(driverTops, driverScroll);
    if (ord === -1) return 0;
    if (ord >= followerTops.length) return followerTops[followerTops.length - 1] || 0;
    const subOffset = driverScroll - driverTops[ord];
    return followerTops[ord] + subOffset;
  }
  function isHeadingKind(kind) {
    if (!kind) return false;
    return /^(ATX|Setext)Heading[1-6]?$/.test(kind) || /^H[1-6]$/.test(kind);
  }
  function lineYInBlock(L, L1, L2, blockTop, blockHeight) {
    if (L2 <= L1) return blockTop;
    let fraction = (L - L1) / (L2 - L1);
    if (fraction < 0) fraction = 0;
    else if (fraction > 1) fraction = 1;
    return blockTop + fraction * blockHeight;
  }
  function lineFromClickY(clickY, height, L1, L2) {
    if (height <= 0 || L2 <= L1) return L1;
    let fraction = clickY / height;
    if (fraction < 0) fraction = 0;
    else if (fraction > 1) fraction = 1;
    return L1 + Math.round(fraction * (L2 - L1));
  }

  const math = {
    currentBlock, tickY, tickYClampedForCurrent, hasDrift, correctionTarget,
    isHeadingKind, lineYInBlock, lineFromClickY,
  };

  // ── Reducer ─────────────────────────────────────────────────────────────
  // State shape:
  //   fsm:                   'IDLE' | 'DRIVING_EDITOR' | 'DRIVING_PREVIEW'
  //                        | 'LOCKED_PROGRAMMATIC' | 'SUSPENDED'
  //   prevDriver:            'editor' | 'preview' | null
  //   prevFsmBeforeSuspend:  the fsm value to restore on splitter/render end
  //   expected:              { side, y } | null  (during LOCKED_PROGRAMMATIC)
  //   expectedFrames:        number of frameTicks observed since lock
  //   pendingAlign:          { follower, drift, atEnd } | null
  // Actions are objects with a `type` and shape-dependent payload.

  function initial() {
    return {
      fsm: 'IDLE',
      prevDriver: null,
      prevFsmBeforeSuspend: null,
      expected: null,
      expectedFrames: 0,
      pendingAlign: null,
    };
  }

  function out() { return []; }

  function setDriver(state, side) {
    return { ...state, prevDriver: side };
  }

  function reduce(state, action) {
    switch (state.fsm) {

      case 'SUSPENDED': {
        if (action.type === 'splitterDragEnd' || action.type === 'renderComplete') {
          const restore = state.prevFsmBeforeSuspend || 'IDLE';
          return {
            state: { ...state, fsm: restore, prevFsmBeforeSuspend: null },
            outputs: [
              { type: 'invalidateBlockCache' },
              { type: 'resolveOnce' },
            ],
          };
        }
        // Everything else is gated.
        return { state, outputs: out() };
      }

      case 'IDLE':
      case 'DRIVING_EDITOR':
      case 'DRIVING_PREVIEW': {
        // Splitter / render → SUSPENDED, save prior fsm.
        if (action.type === 'splitterDragStart' || action.type === 'renderStart') {
          return {
            state: { ...state, fsm: 'SUSPENDED', prevFsmBeforeSuspend: state.fsm },
            outputs: out(),
          };
        }
        // Idle decay: only valid from a driving state.
        if (action.type === 'idleTimeout') {
          if (state.fsm === 'DRIVING_EDITOR' || state.fsm === 'DRIVING_PREVIEW') {
            return {
              state: { ...state, fsm: 'IDLE', prevDriver: null },
              outputs: [{ type: 'publishDriver', side: null }],
            };
          }
          return { state, outputs: out() };
        }
        // Wheel inputs → claim driver (no resolve, scroll event will follow).
        if (action.type === 'editorWheel') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_EDITOR' }, 'editor'),
            outputs: [{ type: 'publishDriver', side: 'editor' }],
          };
        }
        if (action.type === 'previewWheel') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_PREVIEW' }, 'preview'),
            outputs: [{ type: 'publishDriver', side: 'preview' }],
          };
        }
        // Cursor change → editor drives, resolve preview from cursor line.
        if (action.type === 'editorCursor') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_EDITOR' }, 'editor'),
            outputs: [
              { type: 'publishDriver', side: 'editor' },
              { type: 'resolveFromCursor', line: action.line },
            ],
          };
        }
        // Click on preview → preview drives; move editor cursor to clicked line.
        if (action.type === 'previewClick') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_PREVIEW' }, 'preview'),
            outputs: [
              { type: 'publishDriver', side: 'preview' },
              { type: 'setEditorCursor', line: action.line },
            ],
          };
        }
        // Editor scroll while driving editor → resolve to follower, lock.
        if (action.type === 'editorScroll' && state.fsm === 'DRIVING_EDITOR') {
          return {
            state: {
              ...state,
              fsm: 'LOCKED_PROGRAMMATIC',
              expected: { side: 'preview', y: action.targetPreviewY },
              expectedFrames: 0,
            },
            outputs: [{ type: 'setPreviewScrollTop', y: action.targetPreviewY }],
          };
        }
        // Preview scroll while driving preview → resolve to editor, lock.
        if (action.type === 'previewScroll' && state.fsm === 'DRIVING_PREVIEW') {
          return {
            state: {
              ...state,
              fsm: 'LOCKED_PROGRAMMATIC',
              expected: { side: 'editor', y: action.targetEditorY },
              expectedFrames: 0,
            },
            outputs: [{ type: 'setEditorScrollTop', y: action.targetEditorY }],
          };
        }
        // editorScroll/previewScroll arriving in IDLE → start driving (rare;
        // wheel input usually fires first but keyboard PageDown does not).
        if (action.type === 'editorScroll' && state.fsm === 'IDLE') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_EDITOR' }, 'editor'),
            outputs: [{ type: 'publishDriver', side: 'editor' }],
          };
        }
        if (action.type === 'previewScroll' && state.fsm === 'IDLE') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_PREVIEW' }, 'preview'),
            outputs: [{ type: 'publishDriver', side: 'preview' }],
          };
        }
        // frameTick handles pending force-align.
        if (action.type === 'frameTick') {
          return tickWithAlign(state);
        }
        return { state, outputs: out() };
      }

      case 'LOCKED_PROGRAMMATIC': {
        // Splitter / render still take precedence.
        if (action.type === 'splitterDragStart' || action.type === 'renderStart') {
          return {
            state: { ...state, fsm: 'SUSPENDED', prevFsmBeforeSuspend: state.fsm, expected: null },
            outputs: out(),
          };
        }
        // Matching scroll on the expected side → consume; restore driver.
        const matches = (a) =>
          state.expected
          && ((a.type === 'previewScroll' && state.expected.side === 'preview')
              || (a.type === 'editorScroll' && state.expected.side === 'editor'))
          && Math.abs(a.y - state.expected.y) <= 1;
        if (matches(action)) {
          const restoredFsm = state.prevDriver === 'preview' ? 'DRIVING_PREVIEW' : 'DRIVING_EDITOR';
          return {
            state: { ...state, fsm: restoredFsm, expected: null, expectedFrames: 0 },
            outputs: out(),
          };
        }
        // Non-matching follower scroll → user took over.
        if (action.type === 'previewScroll' && state.expected && state.expected.side === 'preview') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_PREVIEW', expected: null, expectedFrames: 0 }, 'preview'),
            outputs: [
              { type: 'publishDriver', side: 'preview' },
              { type: 'resolveFromPreviewScroll', y: action.y },
            ],
          };
        }
        if (action.type === 'editorScroll' && state.expected && state.expected.side === 'editor') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_EDITOR', expected: null, expectedFrames: 0 }, 'editor'),
            outputs: [
              { type: 'publishDriver', side: 'editor' },
              { type: 'resolveFromEditorScroll', y: action.y },
            ],
          };
        }
        // 2 frame ticks elapsed without matching scroll → expectation expired.
        if (action.type === 'frameTick') {
          const next = state.expectedFrames + 1;
          if (next >= 2) {
            const restoredFsm = state.prevDriver === 'preview' ? 'DRIVING_PREVIEW' : 'DRIVING_EDITOR';
            return tickWithAlign({ ...state, fsm: restoredFsm, expected: null, expectedFrames: 0 });
          }
          return { state: { ...state, expectedFrames: next }, outputs: out() };
        }
        // Wheel on either side during lock → user took over; bail to that driver.
        if (action.type === 'editorWheel') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_EDITOR', expected: null, expectedFrames: 0 }, 'editor'),
            outputs: [{ type: 'publishDriver', side: 'editor' }],
          };
        }
        if (action.type === 'previewWheel') {
          return {
            state: setDriver({ ...state, fsm: 'DRIVING_PREVIEW', expected: null, expectedFrames: 0 }, 'preview'),
            outputs: [{ type: 'publishDriver', side: 'preview' }],
          };
        }
        return { state, outputs: out() };
      }

      default:
        return { state, outputs: out() };
    }
  }

  // frameTick handler shared between DRIVING_* states. If a pendingAlign is
  // set and the drift is in the corrective range, emit a one-shot
  // forceAlignTick. Always clears pendingAlign — one-shot.
  function tickWithAlign(state) {
    const pa = state.pendingAlign;
    if (!pa) return { state, outputs: out() };
    const next = { ...state, pendingAlign: null };
    if (pa.atEnd) return { state: next, outputs: out() };
    const abs = Math.abs(pa.drift);
    if (abs > 1 && abs <= 8) {
      return {
        state: next,
        outputs: [{ type: 'forceAlignTick', side: pa.follower, delta: pa.drift }],
      };
    }
    return { state: next, outputs: out() };
  }

  // ── Side-effects shell ──────────────────────────────────────────────────
  // Drives the pure reducer with real callbacks, an rAF frameTick loop,
  // and a 600 ms idle decay. Adapters in app.js plumb the actual DOM
  // reads/writes via callbacks.

  function createShell() {
    let state = initial();
    let callbacks = null;
    let frameScheduled = false;
    let idleTimer = null;

    function needsFrameTick(s) {
      return s.fsm === 'LOCKED_PROGRAMMATIC' || s.pendingAlign != null;
    }

    function scheduleFrameIfNeeded() {
      if (frameScheduled) return;
      if (!needsFrameTick(state)) return;
      frameScheduled = true;
      const raf = (typeof requestAnimationFrame !== 'undefined')
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
      raf(() => {
        frameScheduled = false;
        dispatch({ type: 'frameTick' });
      });
    }

    function armIdleTimer() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (state.fsm === 'DRIVING_EDITOR' || state.fsm === 'DRIVING_PREVIEW') {
        idleTimer = setTimeout(() => dispatch({ type: 'idleTimeout' }), 600);
      }
    }

    function emit(outputs) {
      if (!callbacks) return;
      for (const o of outputs) {
        switch (o.type) {
          case 'publishDriver':
            callbacks.onDriverChange && callbacks.onDriverChange(o.side); break;
          case 'setPreviewScrollTop':
            callbacks.setPreviewScrollTop && callbacks.setPreviewScrollTop(o.y); break;
          case 'setEditorScrollTop':
            callbacks.setEditorScrollTop && callbacks.setEditorScrollTop(o.y); break;
          case 'setEditorCursor':
            callbacks.setEditorCursor && callbacks.setEditorCursor(o.line); break;
          case 'forceAlignTick':
            callbacks.forceAlignTick && callbacks.forceAlignTick(o.side, o.delta); break;
          case 'invalidateBlockCache':
            callbacks.invalidateBlockCache && callbacks.invalidateBlockCache(); break;
          case 'resolveFromCursor':
            callbacks.resolveFromCursor && callbacks.resolveFromCursor(o.line); break;
          case 'resolveFromPreviewScroll':
            callbacks.resolveFromPreviewScroll && callbacks.resolveFromPreviewScroll(o.y); break;
          case 'resolveFromEditorScroll':
            callbacks.resolveFromEditorScroll && callbacks.resolveFromEditorScroll(o.y); break;
          case 'resolveOnce':
            callbacks.resolveOnce && callbacks.resolveOnce(); break;
        }
      }
    }

    function dispatch(action) {
      const r = reduce(state, action);
      state = r.state;
      emit(r.outputs);
      scheduleFrameIfNeeded();
      armIdleTimer();
    }

    function init(opts) {
      callbacks = (opts && opts.callbacks) || {};
    }

    function getState()  { return state; }
    function getDriver() { return state.prevDriver || null; }

    function setPendingAlign(follower, drift, atEnd) {
      state = { ...state, pendingAlign: { follower, drift, atEnd: !!atEnd } };
      scheduleFrameIfNeeded();
    }

    return { init, dispatch, getState, getDriver, setPendingAlign };
  }

  const shell = createShell();

  return {
    // pure layer (testable)
    reduce, initial, math,
    // shell layer (used by adapters)
    init: (opts) => shell.init(opts),
    dispatch: (action) => shell.dispatch(action),
    getState: () => shell.getState(),
    getDriver: () => shell.getDriver(),
    setPendingAlign: (follower, drift, atEnd) => shell.setPendingAlign(follower, drift, atEnd),
  };
});
