// Modal dialog frame (DESIGN §6.19): role=dialog, aria-modal, a focus trap, Esc and backdrop close,
// and focus returned to where it was. Content that needs the keyboard on iOS focuses its own
// input synchronously in a layout effect, inside the opening gesture. On touch devices the dialog
// owns a history entry, so the back gesture closes it (§6.4).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { returnFocus } from '../../features/focus';
import { useOverlayHistory } from '../../features/overlayHistory';

interface Props {
  label: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  /** `sheet` is full-screen on phones; `dialog` is a centered card. */
  variant?: 'dialog' | 'sheet' | 'wide';
  /** Esc and backdrop close the dialog unless this is false (e.g. while a request runs). */
  dismissible?: boolean;
  describedBy?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ label, onClose, children, className, variant = 'dialog', dismissible = true, describedBy }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  // Captured during the first render, before the content's layout effects move the focus.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useLayoutEffect(() => {
    // Content focuses its own field first; otherwise the panel takes focus.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
    const el = panel.current;
    return () => returnFocus(previous, el);
  }, [previous]);

  useOverlayHistory(true, () => {
    if (!dismissibleRef.current) return false;
    onCloseRef.current();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissibleRef.current) {
        // Only the topmost dialog handles Esc.
        const dialogs = document.querySelectorAll('.modal-panel');
        if (dialogs[dialogs.length - 1] !== panel.current) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Portaled to the body, so no sticky or transformed ancestor can trap it in its stacking context.
  return createPortal(
    <div className={`modal modal-${variant}`}>
      <div className="modal-backdrop" onClick={() => dismissibleRef.current && onCloseRef.current()} />
      <div
        ref={panel}
        className={`modal-panel${className ? ' ' + className : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
