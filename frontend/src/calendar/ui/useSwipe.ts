// A horizontal swipe on a touch screen (DESIGN §6.32): a quick, mostly sideways stroke of at
// least 48 px turns the month. The grid has `touch-action: pan-y`, so vertical strokes still
// scroll the page while sideways ones reach us as pointer events. The click that may end a swipe
// is swallowed, so a swipe never also opens the day it ended on.
import type { MouseEvent, PointerEvent } from 'react';
import { useRef } from 'react';

const MIN_DISTANCE = 48;
const MAX_DURATION_MS = 800;
const SWALLOW_MS = 400;

/** `direction`: 1 for a swipe to the left (the next month), -1 to the right (the previous). */
export function useSwipe(onSwipe: (direction: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const swipedAt = useRef(-Infinity);
  return {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'mouse') return;
      start.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    },
    onPointerUp(e: PointerEvent) {
      const s = start.current;
      start.current = null;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < 1.5 * Math.abs(dy) || e.timeStamp - s.t > MAX_DURATION_MS) return;
      swipedAt.current = e.timeStamp;
      onSwipe(dx < 0 ? 1 : -1);
    },
    onPointerCancel() {
      start.current = null;
    },
    onClickCapture(e: MouseEvent) {
      if (e.timeStamp - swipedAt.current < SWALLOW_MS) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
