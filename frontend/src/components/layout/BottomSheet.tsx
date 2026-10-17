// Bottom-sheet dismissal (DESIGN §6.16): dragging the handle down, or swiping down on the content
// only while the content is scrolled to its top, so scrolling the sheet never closes it. The
// sheet follows the finger through `--sheet-drag`; a long or fast enough drag closes it,
// anything else springs back.
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** Fraction of the sheet's height, or a fast flick, that closes it. */
const CLOSE_FRACTION = 0.25;
const CLOSE_VELOCITY = 0.6; // px/ms
const FLICK_MIN_DISTANCE = 24;

/** The nearest vertically scrollable element between `target` and `root`. */
function scrollParent(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

export function useSheetDrag(panel: RefObject<HTMLElement | null>, grip: RefObject<HTMLElement | null>, active: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const sheet = panel.current;
    const handle = grip.current;
    if (!active || !sheet || !handle) return;

    let drag: { startY: number; lastY: number; lastTime: number; velocity: number; distance: number } | null = null;
    let touch: { x: number; y: number; scroller: HTMLElement | null } | null = null;

    const begin = (y: number) => {
      drag = { startY: y, lastY: y, lastTime: performance.now(), velocity: 0, distance: 0 };
      sheet.classList.add('is-dragging');
    };
    const move = (y: number) => {
      if (!drag) return;
      const now = performance.now();
      drag.velocity = (y - drag.lastY) / Math.max(1, now - drag.lastTime);
      drag.lastY = y;
      drag.lastTime = now;
      drag.distance = Math.max(0, y - drag.startY);
      sheet.style.setProperty('--sheet-drag', `${drag.distance}px`);
    };
    const end = () => {
      if (!drag) return;
      const { distance, velocity } = drag;
      drag = null;
      const close = distance > sheet.offsetHeight * CLOSE_FRACTION || (velocity > CLOSE_VELOCITY && distance > FLICK_MIN_DISTANCE);
      // The transition comes back on, so the sheet animates from where the finger left it.
      sheet.classList.remove('is-dragging');
      sheet.style.removeProperty('--sheet-drag');
      if (close) onCloseRef.current();
    };

    // The handle: any pointer.
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      handle.setPointerCapture?.(e.pointerId);
      begin(e.clientY);
    };
    const onPointerMove = (e: PointerEvent) => move(e.clientY);

    // The content: a downward swipe that starts while it is scrolled to the top. The decision is
    // made on the first move, because iOS ignores preventDefault once it has started scrolling.
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || handle.contains(e.target as Node)) {
        touch = null;
        return;
      }
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY, scroller: scrollParent(e.target, sheet) };
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (drag) {
        e.preventDefault();
        move(t.clientY);
        return;
      }
      if (!touch || !t) return;
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      if (dx === 0 && dy === 0) return;
      const start = touch;
      touch = null;
      const atTop = !start.scroller || start.scroller.scrollTop <= 0;
      if (atTop && dy > 0 && dy >= Math.abs(dx)) {
        e.preventDefault();
        begin(start.y);
        move(t.clientY);
      }
    };
    const onTouchEnd = () => {
      touch = null;
      end();
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    sheet.addEventListener('touchstart', onTouchStart, { passive: true });
    sheet.addEventListener('touchmove', onTouchMove, { passive: false });
    sheet.addEventListener('touchend', onTouchEnd);
    sheet.addEventListener('touchcancel', onTouchEnd);
    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      sheet.removeEventListener('touchstart', onTouchStart);
      sheet.removeEventListener('touchmove', onTouchMove);
      sheet.removeEventListener('touchend', onTouchEnd);
      sheet.removeEventListener('touchcancel', onTouchEnd);
      sheet.classList.remove('is-dragging');
      sheet.style.removeProperty('--sheet-drag');
    };
  }, [active, panel, grip]);
}
