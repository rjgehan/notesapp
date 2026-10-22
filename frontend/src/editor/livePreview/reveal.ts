// Editing what Live Preview renders (DESIGN §6.6.1, "Everything rendered is editable"): a click
// on an element that shows as a widget (an image or embed, a footnote, a comment) puts the caret
// into its source, which then shows as text (a selection end inside hidden markup reveals it).
// Keyboard moves still step over the element; this is the pointer's way in.
import { EditorSelection, type EditorState, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { collectElements, type ElementKind, type LiveElement } from './model';

/** The user event of a caret put into an element's source by a click on its rendering. */
export const REVEAL_EVENT = 'select.reveal';

/** The element of one of `kinds` that starts at `from` (a widget's `posAtDOM`), if any. */
export function elementStartingAt(state: EditorState, from: number, kinds: readonly ElementKind[]): LiveElement | null {
  if (from < 0 || from > state.doc.length) return null;
  const line = state.doc.lineAt(from);
  return collectElements(state, [{ from: line.from, to: line.to }]).find((el) => el.from === from && kinds.includes(el.kind)) ?? null;
}

/**
 * Where the caret goes in an element's source: before the closing brackets of an embed or a
 * footnote (`![[pic.png|300‸]]`, `![alt](pic.png‸)`, `[^note‸]`, `^[text‸]`), at the start of a
 * comment's text (`%%‸text%%`).
 */
export function sourceCaret(state: EditorState, el: Pick<LiveElement, 'from' | 'to' | 'kind'>): number {
  const text = state.sliceDoc(el.from, el.to);
  if (el.kind === 'comment') return Math.min(el.from + 2, el.to);
  if (text.endsWith(']]')) return el.to - 2;
  return Math.max(el.from, el.to - 1);
}

/** Puts the caret at `pos` (inside an element's hidden source) and focuses the editor. False in a note that cannot be written. */
export function revealSource(view: EditorView, pos: number, effects: StateEffect<unknown>[] = []): boolean {
  if (view.state.readOnly) return false;
  view.dispatch({ selection: EditorSelection.cursor(pos), effects, scrollIntoView: true, userEvent: REVEAL_EVENT });
  view.focus();
  return true;
}

/** Reveals the source of the element of `kinds` drawn by `dom` (a widget's element). */
export function revealElementAt(view: EditorView, dom: Node, kinds: readonly ElementKind[]): boolean {
  if (view.state.readOnly) return false;
  let from: number;
  try {
    from = view.posAtDOM(dom);
  } catch {
    return false;
  }
  const el = elementStartingAt(view.state, from, kinds);
  return el ? revealSource(view, sourceCaret(view.state, el)) : false;
}
