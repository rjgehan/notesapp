// Keeps the focused editor's caret in view (DESIGN §6.16): the keyboard opened, the toolbar showed.
import { EditorView } from '@codemirror/view';
import { activeEditor } from './activeEditor';

/** Scrolls the focused editor's caret back into view (keyboard opened, toolbar shown). */
export function revealCaret(): void {
  const view = activeEditor();
  if (!view || !view.hasFocus) return;
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) });
}
