'use strict';
// Window position and size (docs/DESKTOP.md): remembered between launches, and brought back onto a
// screen when the monitor it was on is gone.

const DEFAULT = { width: 1200, height: 800 };
const MIN = { width: 480, height: 360 };
/** At least this much of the title bar must be on a screen for the saved position to be kept. */
const VISIBLE_MARGIN = 80;

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function intersection(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The bounds to open the main window with.
 * @param {unknown} saved what was stored ({ x, y, width, height, maximized })
 * @param {{ x: number, y: number, width: number, height: number }[]} workAreas the displays' work areas
 * @returns {{ width: number, height: number, x?: number, y?: number, maximized: boolean }}
 */
function restoreBounds(saved, workAreas) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const primary = workAreas[0] || { x: 0, y: 0, width: DEFAULT.width, height: DEFAULT.height };
  // No larger than the largest screen, no smaller than the minimum.
  const maxW = workAreas.length ? Math.max(MIN.width, ...workAreas.map((a) => a.width)) : Infinity;
  const maxH = workAreas.length ? Math.max(MIN.height, ...workAreas.map((a) => a.height)) : Infinity;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(Math.round(n), hi));
  const width = isNum(s.width) ? clamp(s.width, MIN.width, maxW) : Math.min(DEFAULT.width, maxW);
  const height = isNum(s.height) ? clamp(s.height, MIN.height, maxH) : Math.min(DEFAULT.height, maxH);
  const maximized = s.maximized === true;
  if (isNum(s.x) && isNum(s.y)) {
    // The strip along the top of the window, where it is dragged from.
    const titleBar = { x: Math.round(s.x), y: Math.round(s.y), width, height: 32 };
    const visible = workAreas.some((a) => {
      const i = intersection(titleBar, a);
      return i !== null && i.w >= Math.min(VISIBLE_MARGIN, width);
    });
    if (visible) return { x: Math.round(s.x), y: Math.round(s.y), width, height, maximized };
  }
  // No position, or off every screen: centred on the primary display (Electron centres when x/y are absent).
  return { width: Math.min(width, Math.max(primary.width, MIN.width)), height: Math.min(height, Math.max(primary.height, MIN.height)), maximized };
}

/** What to store for a window: its normal (un-maximized) bounds plus whether it was maximized. */
function snapshot(normalBounds, maximized) {
  return { x: normalBounds.x, y: normalBounds.y, width: normalBounds.width, height: normalBounds.height, maximized: !!maximized };
}

/**
 * Where to put the capture window: centred horizontally, a third of the way down the display the
 * pointer is on, so it appears where the user is looking.
 */
function captureBounds(workArea, size = { width: 520, height: 440 }) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 3)),
    width,
    height,
  };
}

module.exports = { restoreBounds, snapshot, captureBounds, DEFAULT, MIN };
