// Function suggestions and the signature hint (formulas/assist.ts) in the spreadsheet view: in
// Glide's cell editor and in the formula bar, while what is typed starts with `=`. The list takes
// the arrows, Enter, Tab and Escape before the editor does (they would commit or move otherwise).
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { FormulaAssist, inputField, type AssistKey } from '../../formulas/assist';
import type { FunctionInfo } from '../../sheets/formulaText';
import { loadSheetEngine } from '../../sheets/loadEngine';

const KEYS = new Set<string>(['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape']);

interface Options {
  /** Where Glide's cell editor opens. */
  portalRef: RefObject<HTMLDivElement | null>;
  /** The formula bar's field, while it edits a cell. */
  barInput(): HTMLInputElement | null;
}

export function useFormulaAssist({ portalRef, barInput }: Options): void {
  const bar = useRef(barInput);
  useLayoutEffect(() => {
    bar.current = barInput;
  });

  useEffect(() => {
    let catalog: readonly FunctionInfo[] | null = null;
    let assist: { el: HTMLInputElement | HTMLTextAreaElement; help: FormulaAssist } | null = null;
    let gone = false;
    void loadSheetEngine().then(
      (m) => {
        catalog = m.functionCatalog();
        assist?.help.update();
      },
      () => undefined,
    );

    const editing = (target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null => {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return null;
      return portalRef.current?.contains(target) || target === bar.current() || target.classList.contains('sheet-formula-input') ? target : null;
    };

    const refresh = () => {
      const el = editing(document.activeElement);
      if (!el) {
        assist?.help.destroy();
        assist = null;
        return;
      }
      if (assist && assist.el !== el) {
        assist.help.destroy();
        assist = null;
      }
      if (!el.value.startsWith('=')) {
        assist?.help.hide();
        return;
      }
      assist ??= { el, help: new FormulaAssist(inputField(el), () => catalog) };
      assist.help.update();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!assist || e.target !== assist.el || !KEYS.has(e.key) || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (assist.help.key(e.key as AssistKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Typing, caret moves and focus changes; after the event, so the field holds its new value.
    const later = () => queueMicrotask(() => !gone && refresh());
    const onFocusOut = () => setTimeout(() => !gone && refresh(), 0);

    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('input', later, true);
    document.addEventListener('selectionchange', later);
    document.addEventListener('keyup', later, true);
    document.addEventListener('pointerup', later, true);
    document.addEventListener('focusin', later, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      gone = true;
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('input', later, true);
      document.removeEventListener('selectionchange', later);
      document.removeEventListener('keyup', later, true);
      document.removeEventListener('pointerup', later, true);
      document.removeEventListener('focusin', later, true);
      document.removeEventListener('focusout', onFocusOut, true);
      assist?.help.destroy();
    };
  }, [portalRef]);
}
