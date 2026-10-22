// Remote updates (DESIGN §6.6 "Remote updates"): the annotations that tell edits apart, and the
// wait for an IME or iOS autocorrect composition (compositionend, or at most 300 ms) before remote
// text goes in. The change set itself is computed in remoteDiff.ts.
import { Annotation, Transaction } from '@codemirror/state';
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
 * Marks a change copied from another editor of the same note (another pane, DESIGN §6.40): the
 * editor where it was typed reports it, so this one does not count it again.
 */
export const paneSync = Annotation.define<boolean>();

/** True for a transaction that changes the document on behalf of the user. */
export function isLocalEdit(tr: Transaction): boolean {
  return tr.docChanged && !tr.annotation(Transaction.remote) && !tr.annotation(sessionEdit) && !tr.annotation(paneSync);
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
