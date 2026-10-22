// Applies remote text as a minimal change set (DESIGN §6.6 "Remote updates"): annotated
// Transaction.remote and kept out of undo history, so the cursor, scroll position and local undo
// stack survive. While an IME or iOS autocorrect composition is active, the update waits for
// compositionend (or at most 300 ms).
import { diff } from '@codemirror/merge';
import { Annotation, Transaction, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Marks an edit the session makes itself that must not count as a local change (it stays in the
 * undo history, unlike remote updates). Used by "Take theirs" so that undo brings mine back.
 */
export const sessionEdit = Annotation.define<boolean>();

/**
 * Marks a transaction that replaces the note's text as a whole (Take theirs and its undo, a merged or
 * restored text): Live Preview's editing rules (around tables and hidden blocks) leave it exactly as
 * it comes, so the editor holds the text the session meant.
 */
export const textReplace = Annotation.define<boolean>();

/**
 * Marks a change copied from another editor of the same note (another pane, DESIGN §6.38): the
 * editor where it was typed reports it, so this one does not count it again.
 */
export const paneSync = Annotation.define<boolean>();

/** True for a transaction that changes the document on behalf of the user. */
export function isLocalEdit(tr: Transaction): boolean {
  return tr.docChanged && !tr.annotation(Transaction.remote) && !tr.annotation(sessionEdit) && !tr.annotation(paneSync);
}

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

/**
 * Editors nested in a note's editor that write into its document (a table cell being edited,
 * DESIGN §6.6.1). Their compositions count as the note's.
 */
const nested = new WeakMap<EditorView, Set<EditorView>>();

export function addNestedEditor(host: EditorView, inner: EditorView): void {
  let set = nested.get(host);
  if (!set) nested.set(host, (set = new Set()));
  set.add(inner);
}

export function removeNestedEditor(host: EditorView, inner: EditorView): void {
  nested.get(host)?.delete(inner);
}

/** The editor composing text for `view`: the view itself or an editor nested in it, or null. */
function composingEditor(view: EditorView): EditorView | null {
  if (view.composing) return view;
  for (const inner of nested.get(view) ?? []) if (inner.composing) return inner;
  return null;
}

/** Whether an IME or autocorrect composition is active in `view` or an editor nested in it. */
export function isComposing(view: EditorView): boolean {
  return composingEditor(view) !== null;
}

/**
 * Resolves once `view` (and the editors nested in it) has no active IME or autocorrect
 * composition: at once, or after compositionend (and CodeMirror's read of the final DOM text), or
 * at most 300 ms.
 */
export function waitForComposition(view: EditorView): Promise<void> {
  return new Promise((done) => {
    const editor = composingEditor(view);
    if (!editor) {
      done();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      editor.contentDOM.removeEventListener('compositionend', onEnd);
      clearTimeout(timer);
      // compositionend fires before CodeMirror reads the final DOM text; let it settle first.
      setTimeout(done, 0);
    };
    const onEnd = () => finish();
    editor.contentDOM.addEventListener('compositionend', onEnd);
    const timer = setTimeout(finish, 300);
  });
}
