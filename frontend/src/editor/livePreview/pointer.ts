// Whether a selection change came from a pointer (DESIGN §6.6.1). CodeMirror labels a mouse
// selection `select.pointer`; on iOS a tap moves the native caret after the touch has ended, often
// later than CodeMirror's 50 ms window, so the change arrives as a plain `select`. A selection
// change shortly after a touch ends counts as the tap's.
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const TAP_WINDOW_MS = 400;
let lastTouchEnd = -Infinity;

/** Records the end of each touch on the editor. */
export const touchTracking = EditorView.domEventHandlers({
  touchend() {
    lastTouchEnd = Date.now();
    return false;
  },
});

/** Whether `tr` moves the selection where a click or tap put it. */
export function isPointerSelection(tr: Transaction): boolean {
  if (tr.isUserEvent('select.pointer')) return true;
  return tr.annotation(Transaction.userEvent) === 'select' && Date.now() - lastTouchEnd < TAP_WINDOW_MS;
}

/** Tests: a touch ends at `at`. */
export function noteTouchEnd(at = Date.now()): void {
  lastTouchEnd = at;
}
