// The one-time hint of DESIGN §6.14: Tab indents in the editor, so the first time the editor gets
// keyboard focus on this device, a toast says how to leave it (CodeMirror's Esc-then-Tab escape).
import { lastInputWasKeyboard } from '../features/focus';
import { isCoarsePointer } from '../features/platform';
import { toast } from '../state/toasts';

const SHOWN_KEY = 'notesapp:tabEscapeHintShown';

export function maybeShowTabEscapeHint(): void {
  if (isCoarsePointer() || !lastInputWasKeyboard()) return;
  try {
    if (localStorage.getItem(SHOWN_KEY)) return;
    localStorage.setItem(SHOWN_KEY, '1');
  } catch {
    // Without storage the hint would repeat on every focus; skip it.
    return;
  }
  toast('Tab indents in the editor. Press Esc, then Tab, to move focus out of it.', { timeout: 8000 });
}
