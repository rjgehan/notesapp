// Remote text as a minimal change set (DESIGN §6.6 "Remote updates"), computed with
// @codemirror/merge's diff: annotated Transaction.remote and kept out of undo history, so the
// cursor, scroll position and local undo stack survive. Not in the main chunk: sessions load it
// with their file (sync/sessionKit.ts), editors with their own code.
import { diff } from '@codemirror/merge';
import { Transaction, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';

export function remoteChanges(current: string, next: string): ChangeSpec[] {
  return diff(current, next).map((c) => ({ from: c.fromA, to: c.toA, insert: next.slice(c.fromB, c.toB) }));
}

export function remoteTransaction(state: EditorState, next: string): TransactionSpec | null {
  const current = state.doc.toString();
  if (current === next) return null;
  return {
    changes: remoteChanges(current, next),
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  };
}

/** Applies `next` (already LF-normalized) to a state without a view. */
export function applyRemoteTextToState(state: EditorState, next: string): EditorState {
  const spec = remoteTransaction(state, next);
  return spec ? state.update(spec).state : state;
}
