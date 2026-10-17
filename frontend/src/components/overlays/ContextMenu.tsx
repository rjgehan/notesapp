// A context menu at a point (right-click, long-press, or a ⋯ button): role=menu, arrow keys,
// Esc and outside taps close it, and focus returns to where it was. On touch devices the back
// gesture closes it too (DESIGN §6.4).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { returnFocus } from '../../features/focus';
import { useOverlayHistory } from '../../features/overlayHistory';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

export type MenuEntry = MenuItem | 'separator';

interface Props {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
  onClose(): void;
}

export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep the menu inside the viewport (measured before paint).
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    el.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [x, y]);

  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const close = () => onCloseRef.current();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const el = ref.current;
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      returnFocus(previous, el);
    };
  }, [previous]);

  useOverlayHistory(true, () => onCloseRef.current());

  const moveFocus = (delta: number) => {
    const options = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (options.length === 0) return;
    const i = options.indexOf(document.activeElement as HTMLElement);
    options[(i + delta + options.length) % options.length].focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="menu context-menu"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') moveFocus(1);
        else if (e.key === 'ArrowUp') moveFocus(-1);
        else return;
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep-${i}`} className="menu-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
