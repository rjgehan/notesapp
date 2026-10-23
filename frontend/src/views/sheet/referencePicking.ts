// Pointing at cells while a formula is typed (DESIGN §6.21.5), as in Google Sheets and Excel: with
// the caret where a reference can go (after `=`, `(`, `,`, an operator or `:`), a click on a cell
// inserts its reference instead of ending the edit, a drag inserts a range, and another click
// replaces the reference just inserted. It works in Glide's cell editor and in the formula bar,
// and on touch devices a tap (not a scroll) does the same while the keyboard stays up; a second tap
// makes the reference a range (`B2` then `B4`: `B2:B4`), and Shift-click does so with a mouse.
import type { DataEditorRef } from '@glideapps/glide-data-grid';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { setInputValue } from '../../formulas/assist';
import { pickSlot, placeReference, referenceSlot, spanOf, type PickedSlot, type RefAt } from '../../sheets/formulaText';
import type { CellRange } from '../../sheets/refs';
import { frozenRowAt, type CellAt, type GridLayout } from './gridModel';

// Shared with the tables of notes (sheets/formulaText.ts).
export { referenceSlot, spanOf, type PickedSlot };

interface Options {
  gridBox: RefObject<HTMLDivElement | null>;
  gridRef: RefObject<DataEditorRef | null>;
  /** Where Glide's cell editor opens. */
  portalRef: RefObject<HTMLDivElement | null>;
  /** The formula bar's field, while it edits a cell. */
  barInput(): HTMLInputElement | null;
  layout(): GridLayout;
  /** The range pointed at (to highlight), or null when pointing ends. */
  onPick(range: CellRange | null): void;
}

export function useReferencePicking({ gridBox, gridRef, portalRef, barInput, layout, onPick }: Options): void {
  const opts = useRef({ barInput, layout, onPick });
  useLayoutEffect(() => {
    opts.current = { barInput, layout, onPick };
  });

  useEffect(() => {
    let last: PickedSlot | null = null;
    /** A mouse drag from `anchor`, rewriting the reference that starts at `start`. */
    let drag: { el: HTMLInputElement | HTMLTextAreaElement; anchor: RefAt; start: number } | null = null;
    /** A touch on a cell, picked on its touchend unless it turned into a scroll. */
    let tap: { el: HTMLInputElement | HTMLTextAreaElement; at: CellAt; x: number; y: number } | null = null;
    /** The pointer went down on a cell for pointing: its mouse and click events are the picker's too. */
    let swallowing = false;

    const editing = (): HTMLInputElement | HTMLTextAreaElement | null => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
      return portalRef.current?.contains(el) || el === opts.current.barInput() ? el : null;
    };

    const cellAt = (x: number, y: number): CellAt | null => {
      const args = gridRef.current?.getMouseArgsForPosition(x, y);
      const l = opts.current.layout();
      if (args?.kind === 'cell') {
        const [col, row] = args.location;
        return col >= 0 && row >= 0 ? { col, row: row + l.frozenRows } : null;
      }
      if (args?.kind === 'header' && args.location[0] >= 0 && args.localEventY >= l.headerBand) {
        const row = frozenRowAt(l, args.localEventY - l.headerBand);
        return row === null ? null : { col: args.location[0], row };
      }
      return null;
    };

    const place = (el: HTMLInputElement | HTMLTextAreaElement, start: number, end: number, anchor: RefAt, at: RefAt) => {
      const next = placeReference(el.value, start, end, anchor, at);
      setInputValue(el, next.value);
      el.setSelectionRange(next.caret, next.caret);
      last = next.pick;
      opts.current.onPick(next.range);
    };
    const ref = (at: CellAt): RefAt => ({ sheet: null, ...at });

    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerDown = (e: PointerEvent) => {
      swallowing = false;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const el = editing();
      if (!el || !(e.target instanceof Node) || !gridBox.current?.contains(e.target)) return;
      const at = cellAt(e.clientX, e.clientY);
      const touch = e.pointerType !== 'mouse' && e.pointerType !== 'pen';
      const slot = at && pickSlot(el.value, el.selectionStart ?? el.value.length, last, ref(at), touch ? 'tap' : e.shiftKey ? 'extend' : 'click');
      if (!at || !slot) return;
      // Neither Glide (which would end the edit and select the cell) nor the focus moves.
      swallow(e);
      swallowing = true;
      if (!touch) {
        place(el, slot.start, slot.end, slot.anchor, ref(at));
        drag = { el, anchor: slot.anchor, start: slot.start };
      } else tap = { el, at, x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      // Released outside the window: the drag is over.
      if (e.buttons === 0) {
        drag = null;
        return;
      }
      swallow(e);
      const at = cellAt(e.clientX, e.clientY);
      if (at && last) place(drag.el, drag.start, last.end, drag.anchor, ref(at));
    };

    const onPointerEnd = (e: Event) => {
      if (!swallowing) return;
      swallow(e);
      drag = null;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tap) return;
      const t = e.changedTouches[0];
      const { el, at, x, y } = tap;
      tap = null;
      swallowing = false;
      // A scroll is not a tap.
      if (!t || Math.hypot(t.clientX - x, t.clientY - y) > 10 || document.activeElement !== el) return;
      const slot = pickSlot(el.value, el.selectionStart ?? el.value.length, last, ref(at), 'tap');
      if (!slot) return;
      // No emulated mouse events follow, so the field keeps the focus and the keyboard stays up.
      swallow(e);
      place(el, slot.start, slot.end, slot.anchor, ref(at));
    };

    const onFocusOut = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && (portalRef.current?.contains(e.target) || e.target === opts.current.barInput())) {
        last = null;
        opts.current.onPick(null);
      }
    };

    const options = { capture: true, passive: false } as const;
    window.addEventListener('pointerdown', onPointerDown, options);
    window.addEventListener('pointermove', onPointerMove, options);
    window.addEventListener('pointerup', onPointerEnd, options);
    window.addEventListener('mousedown', onPointerEnd, options);
    window.addEventListener('mouseup', onPointerEnd, options);
    window.addEventListener('click', onPointerEnd, options);
    window.addEventListener('touchend', onTouchEnd, options);
    window.addEventListener('focusout', onFocusOut, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, options);
      window.removeEventListener('pointermove', onPointerMove, options);
      window.removeEventListener('pointerup', onPointerEnd, options);
      window.removeEventListener('mousedown', onPointerEnd, options);
      window.removeEventListener('mouseup', onPointerEnd, options);
      window.removeEventListener('click', onPointerEnd, options);
      window.removeEventListener('touchend', onTouchEnd, options);
      window.removeEventListener('focusout', onFocusOut, true);
    };
  }, [gridBox, gridRef, portalRef, opts]);
}
