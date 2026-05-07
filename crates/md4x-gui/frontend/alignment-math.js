// Scroll-alignment tick math. Pure functions. No DOM, no globals besides
// the export shim. Spec: docs/spec/v0.2.3-scroll-alignment-ticks.md
//
// Inputs are arrays of block doc-Y values (`tops`), already produced by
// the existing block-sync layer in app.js (lezer side via coordsAtPos,
// preview side via getPreviewBlocksCached.tops).
//
// Same module loaded in browser as a classic script (sets
// window.md4xAlignmentMath) and in Node tests via require().

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md4xAlignmentMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // currentBlock(tops, scrollTop) → ordinal of the block whose top is the
  // largest value ≤ scrollTop. If scrollTop is above the first block,
  // return 0. If `tops` is empty, return -1.
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

  // tickY(top, scrollTop) → block's Y in viewport coords. May be negative
  // (block above viewport) or past the strip's bottom (block below).
  // Caller culls or clamps for rendering.
  function tickY(top, scrollTop) {
    return top - scrollTop;
  }

  // tickYClampedForCurrent: render position for the current-block (red)
  // tick. If the block's top is above viewport, clamp to 0 (top of strip)
  // so the tick remains visible. If it would render past stripHeight,
  // clamp there too. Both panes clamp identically when truly aligned, so
  // diagnostic value is preserved.
  function tickYClampedForCurrent(top, scrollTop, stripHeight) {
    const y = top - scrollTop;
    if (y < 0) return 0;
    if (y > stripHeight) return stripHeight;
    return y;
  }

  // hasDrift: returns true if driver and follower disagree by ordinal or
  // by sub-block offset beyond `threshold` px.
  //
  // `driverTops`/`followerTops` are aligned by ordinal (caller guarantees
  // shared block-count via min-length truncation upstream).
  function hasDrift(
    driverTops, driverScroll,
    followerTops, followerScroll,
    threshold
  ) {
    const dOrd = currentBlock(driverTops, driverScroll);
    const fOrd = currentBlock(followerTops, followerScroll);
    if (dOrd === -1 || fOrd === -1) return false;
    if (dOrd !== fOrd) return true;
    const dSub = driverScroll  - driverTops[dOrd];
    const fSub = followerScroll - followerTops[fOrd];
    return Math.abs(dSub - fSub) > threshold;
  }

  // correctionTarget: scrollTop value the follower should adopt to match
  // the driver's current block AND sub-offset.
  //
  // followerTarget = followerTops[driverOrdinal] + (driverScroll - driverTops[driverOrdinal])
  function correctionTarget(driverTops, driverScroll, followerTops) {
    const ord = currentBlock(driverTops, driverScroll);
    if (ord === -1) return 0;
    if (ord >= followerTops.length) return followerTops[followerTops.length - 1] || 0;
    const subOffset = driverScroll - driverTops[ord];
    return followerTops[ord] + subOffset;
  }

  // isHeadingKind: matches editor-side lezer node names
  // (ATXHeading1..6, SetextHeading1..2) and preview-side tag names (H1..6).
  // Used to render heading ticks longer/darker than paragraph ticks.
  function isHeadingKind(kind) {
    if (!kind) return false;
    return /^(ATX|Setext)Heading[1-6]?$/.test(kind) || /^H[1-6]$/.test(kind);
  }

  return {
    currentBlock,
    tickY,
    tickYClampedForCurrent,
    hasDrift,
    correctionTarget,
    isHeadingKind,
  };
});
