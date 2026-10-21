// The optimistic "New note" (DESIGN §6.15): the pending view is shown at once with its title
// focused, while the POST runs in the background.
import { create } from 'zustand';

export interface PendingNote {
  id: number;
  folder: string;
  /** The extension of the file being created (`md` for a note) and what it is called ("note", "drawing"). */
  extension: string;
  label: string;
  /** The title as typed so far (without the extension). */
  title: string;
  /** The user committed a title (Enter or blur) before the note existed: it becomes a rename. */
  committed: boolean;
  /** The title field's selection, carried over to the real note's title. */
  selectionStart: number;
  selectionEnd: number;
}

export interface TitleHandoff {
  path: string;
  title: string;
  selectionStart: number;
  selectionEnd: number;
}

interface PendingState {
  pending: PendingNote | null;
  /** Hands the typed title over to the real note's inline title once the note exists. */
  handoff: TitleHandoff | null;
}

export const usePendingNote = create<PendingState>()(() => ({ pending: null, handoff: null }));

/** A new pending note (or other file) whose whole title is selected, so typing replaces it. */
export function startPendingNote(id: number, folder: string, title: string, file: { extension: string; label: string } = { extension: 'md', label: 'note' }): void {
  usePendingNote.setState({
    pending: { id, folder, ...file, title, committed: false, selectionStart: 0, selectionEnd: title.length },
    handoff: null,
  });
}

export function updatePendingTitle(id: number, title: string, committed: boolean): void {
  const { pending } = usePendingNote.getState();
  if (pending?.id === id) usePendingNote.setState({ pending: { ...pending, title, committed } });
}

export function updatePendingSelection(id: number, selectionStart: number, selectionEnd: number): void {
  const { pending } = usePendingNote.getState();
  if (pending?.id === id && (pending.selectionStart !== selectionStart || pending.selectionEnd !== selectionEnd)) {
    usePendingNote.setState({ pending: { ...pending, selectionStart, selectionEnd } });
  }
}

export function clearPendingNote(id?: number): void {
  const { pending } = usePendingNote.getState();
  if (pending && (id === undefined || pending.id === id)) usePendingNote.setState({ pending: null });
}

/** Consumed once by the inline title of the note at `path`. */
export function takeTitleHandoff(path: string): TitleHandoff | null {
  const { handoff } = usePendingNote.getState();
  if (!handoff || handoff.path !== path) return null;
  usePendingNote.setState({ handoff: null });
  return handoff;
}
