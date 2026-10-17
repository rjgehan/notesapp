// Overlay containers (DESIGN §6.16): the phone drawer (left, 88 % width, with an optional footer),
// the tablet sidebar overlays, and the phone bottom sheet (70 % height, dismissed by dragging its
// handle or swiping down from the top of its content). Esc and a backdrop tap close them, and on
// touch devices so does the back gesture (§6.4).
import { useEffect, useRef, type ReactNode } from 'react';
import { returnFocus } from '../../features/focus';
import { useOverlayHistory } from '../../features/overlayHistory';
import { useSheetDrag } from './BottomSheet';

interface Props {
  open: boolean;
  onClose(): void;
  side: 'left' | 'right' | 'bottom';
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  /** A bottom sheet that takes the whole screen (the history panel on phones, DESIGN §6.11). */
  full?: boolean;
}

export function Overlay({ open, onClose, side, label, children, footer, full }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLDivElement>(null);

  useOverlayHistory(open, onClose);
  useSheetDrag(panel, grip, open && side === 'bottom', onClose);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      // A dialog or menu opened from the overlay handles its own Esc first.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      returnFocus(previous, el);
    };
  }, [open, onClose]);

  return (
    <div className={`overlay overlay-${side}${open ? ' is-open' : ''}${full ? ' is-full' : ''}`} aria-hidden={!open} inert={!open}>
      <div className="overlay-backdrop" onClick={onClose} />
      <div ref={panel} className="overlay-panel" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {side === 'bottom' && (
          <div ref={grip} className="sheet-grip" aria-hidden>
            <div className="sheet-handle" />
          </div>
        )}
        <div className="overlay-content">{children}</div>
        {footer && <div className="overlay-footer">{footer}</div>}
      </div>
    </div>
  );
}
