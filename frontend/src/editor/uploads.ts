// Pending attachment uploads (DESIGN §6.6 #10). A pending upload is a position in the editor
// state, shown as a widget, never document text: saves, drafts and other devices never see a
// placeholder, so an upload interrupted by a killed tab leaves nothing behind in the note.
// The position maps through every change (local or remote) until the upload resolves. The
// widgets are uploadsView.ts's, in the editor; this field is also a session's, without one.
import { StateEffect, StateField, type EditorState } from '@codemirror/state';

export interface PendingUpload {
  id: number;
  pos: number;
  label: string;
  /** What the widget says is happening; "Uploading" by default ("Transcribing" for a voice note's text). */
  verb?: string;
}

/** Starts showing a pending upload at `pos`. */
export const addUpload = StateEffect.define<PendingUpload>({
  map: (u, mapping) => ({ ...u, pos: mapping.mapPos(u.pos, -1) }),
});

/**
 * Ends a pending upload. When its embed was inserted at `from` (in the same transaction, ending
 * at `end`), other uploads of the same batch still waiting at `from` move after it, so a batch
 * keeps its order.
 */
export const endUpload = StateEffect.define<{ id: number; from?: number; end?: number }>();

export const uploadsField = StateField.define<readonly PendingUpload[]>({
  create: () => [],
  update(value, tr) {
    // Text typed at an upload's position goes after its (future) embed.
    let next = tr.docChanged ? value.map((u) => ({ ...u, pos: tr.changes.mapPos(u.pos, -1) })) : value;
    for (const e of tr.effects) {
      if (e.is(addUpload)) next = [...next, e.value];
      else if (e.is(endUpload)) {
        const { id, from, end } = e.value;
        next = next.filter((u) => u.id !== id).map((u) => (from !== undefined && end !== undefined && u.pos === from ? { ...u, pos: end } : u));
      }
    }
    return next;
  },
});

/** The pending uploads of a state (none when the field is not configured). */
export function pendingUploads(state: EditorState): readonly PendingUpload[] {
  return state.field(uploadsField, false) ?? [];
}
