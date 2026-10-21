// Pinch-to-zoom for the PDF view (DESIGN §6.8.2): two fingers on a phone or tablet, Ctrl or ⌘ with the
// wheel (a trackpad pinch) on a computer. The browser's own page zoom is suppressed inside the viewer,
// which re-renders the pages at the new scale instead of magnifying the bitmaps of the old one.

export interface Point {
  x: number;
  y: number;
}

/** One zoom step: the factor since the last step, the point that stays put, and how far the fingers moved. */
export interface ZoomStep {
  factor: number;
  origin: [number, number];
  pan: [number, number];
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 10;

function measure(a: Point, b: Point): { distance: number; mid: Point } {
  return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/** Tracks a two-finger gesture; each move is a step relative to the previous one. */
export class PinchTracker {
  #prev: { distance: number; mid: Point } | null = null;

  get active(): boolean {
    return this.#prev !== null;
  }

  start(a: Point, b: Point): void {
    this.#prev = measure(a, b);
  }

  move(a: Point, b: Point): ZoomStep | null {
    const prev = this.#prev;
    if (!prev) return null;
    const now = measure(a, b);
    this.#prev = now;
    return {
      factor: now.distance / prev.distance,
      origin: [now.mid.x, now.mid.y],
      pan: [prev.mid.x - now.mid.x, prev.mid.y - now.mid.y],
    };
  }

  end(): void {
    this.#prev = null;
  }
}

/** The zoom factor of one Ctrl/⌘ + wheel event (deltaMode 0 = pixels, 1 = lines, 2 = pages). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 30 : deltaMode === 2 ? deltaY * 300 : deltaY;
  return Math.exp(-Math.max(-100, Math.min(100, pixels)) / 100);
}

/**
 * Collects the small factors of a gesture: the viewer keeps scales in whole percents, so a step of
 * 0.3 % would otherwise be rounded away on every event and the pinch would never move.
 */
export class ScaleAccumulator {
  #pending = 1;

  /** The scale to set now, or null while the change is under one percent (or past a limit). */
  add(current: number, factor: number): number | null {
    this.#pending *= factor;
    const wanted = current * this.#pending;
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(wanted * 100) / 100));
    if (target === current) {
      // At a limit, pushing further must not have to be undone before the other direction works.
      if (wanted < MIN_SCALE || wanted > MAX_SCALE) this.#pending = 1;
      return null;
    }
    this.#pending = 1;
    return target;
  }

  reset(): void {
    this.#pending = 1;
  }
}

export interface PinchHandlers {
  step(step: ZoomStep): void;
  /** The fingers left: the viewer may render at the final scale now. */
  end?(): void;
}

function point(t: Touch): Point {
  return { x: t.clientX, y: t.clientY };
}

/** Listens on `el` (the viewer's scroll container); returns the cleanup. */
export function attachPinch(el: HTMLElement, handlers: PinchHandlers): () => void {
  const tracker = new PinchTracker();
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      tracker.start(point(e.touches[0]), point(e.touches[1]));
    } else if (tracker.active) {
      tracker.end();
      handlers.end?.();
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!tracker.active || e.touches.length !== 2) return;
    e.preventDefault();
    const step = tracker.move(point(e.touches[0]), point(e.touches[1]));
    if (step) handlers.step(step);
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (tracker.active && e.touches.length < 2) {
      tracker.end();
      handlers.end?.();
    }
  };
  // Safari's own pinch gesture would zoom the whole page.
  const onGesture = (e: Event) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    handlers.step({ factor: wheelZoomFactor(e.deltaY, e.deltaMode), origin: [e.clientX, e.clientY], pan: [0, 0] });
  };
  const active = { passive: false } as const;
  el.addEventListener('touchstart', onTouchStart, active);
  el.addEventListener('touchmove', onTouchMove, active);
  el.addEventListener('touchend', onTouchEnd);
  el.addEventListener('touchcancel', onTouchEnd);
  el.addEventListener('gesturestart', onGesture, active);
  el.addEventListener('gesturechange', onGesture, active);
  el.addEventListener('wheel', onWheel, active);
  return () => {
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchEnd);
    el.removeEventListener('gesturestart', onGesture);
    el.removeEventListener('gesturechange', onGesture);
    el.removeEventListener('wheel', onWheel);
  };
}
