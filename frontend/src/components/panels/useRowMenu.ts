// Row menus for list panels (DESIGN §6.15 pattern): right-click on desktop, and on touch a long
// press (about 500 ms without moving; iOS Safari fires no contextmenu) or the row's ⋯ button.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

export interface RowMenu<T> {
  target: T;
  x: number;
  y: number;
}

export function useRowMenu<T>() {
  const [menu, setMenu] = useState<RowMenu<T> | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);

  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  /** Pointer and context-menu handlers for a row. */
  const rowHandlers = (target: T) => ({
    onContextMenu: (e: { preventDefault(): void; clientX: number; clientY: number }) => {
      e.preventDefault();
      cancel();
      setMenu({ target, x: e.clientX, y: e.clientY });
    },
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      const { clientX: x, clientY: y } = e;
      const state = {
        x,
        y,
        fired: false,
        timer: setTimeout(() => {
          state.fired = true;
          setMenu({ target, x, y });
        }, LONG_PRESS_MS),
      };
      press.current = state;
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const p = press.current;
      if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: () => {
      if (!press.current?.fired) cancel();
    },
    onPointerCancel: cancel,
  });

  /** True (once) when the click that follows a long press must not activate the row. */
  const swallowClick = (): boolean => {
    if (press.current?.fired) {
      cancel();
      return true;
    }
    return false;
  };

  /** Opens the menu under an element (the ⋯ button, or the row for the ContextMenu key). */
  const openAt = (target: T, el: Element, alignRight = false) => {
    const rect = el.getBoundingClientRect();
    setMenu({ target, x: alignRight ? rect.right - 200 : rect.left + 24, y: rect.bottom });
  };

  return { menu, close: () => setMenu(null), rowHandlers, swallowClick, openAt };
}
