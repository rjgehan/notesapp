// Image or PDF paste and file drop into a note (DESIGN §6.6 #10): files become attachments
// inserted at the current selection (paste) or at the drop point. An explorer row dragged in
// (`application/x-notesapp-path`) inserts a link to it instead.
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { noteContext } from './context';

export const INTERNAL_PATH_TYPE = 'application/x-notesapp-path';

/**
 * What an explorer row's drag allows. Its targets ask for different operations: an explorer
 * folder `move`, a note's editor `link` (it inserts a link), other apps `copy`. A drop whose
 * `dropEffect` the source does not allow never fires (HTML drag-and-drop processing model).
 */
export const EXPLORER_DRAG_EFFECTS: DataTransfer['effectAllowed'] = 'all';

/** Whether a drag whose source allows `allowed` can drop with `effect` (the HTML spec's table). */
export function effectAllows(allowed: DataTransfer['effectAllowed'], effect: DataTransfer['dropEffect']): boolean {
  if (effect === 'none') return false;
  if (allowed === 'all' || allowed === 'uninitialized') return true;
  return allowed.toLowerCase().includes(effect);
}

/** Pasted images and PDFs become attachments; other clipboard content stays a text paste. */
function isPastableFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type === 'application/pdf';
}

function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files];
}

export const pasteAndDrop = EditorView.domEventHandlers({
  paste(event, view) {
    const ctx = view.state.facet(noteContext);
    if (!ctx || view.state.readOnly) return false;
    const files = filesOf(event.clipboardData).filter(isPastableFile);
    if (files.length === 0) return false;
    event.preventDefault();
    const { from, to } = view.state.selection.main;
    ctx.insertFiles(files, { from, to }, true);
    return true;
  },
  dragover(event, view) {
    const types = event.dataTransfer?.types ?? [];
    if (view.state.readOnly || !(types.includes('Files') || types.includes(INTERNAL_PATH_TYPE))) return false;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'link';
    return false;
  },
  drop(event, view) {
    const ctx = view.state.facet(noteContext);
    if (!ctx || view.state.readOnly || !event.dataTransfer) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    const internal = event.dataTransfer.getData(INTERNAL_PATH_TYPE);
    if (internal) {
      event.preventDefault();
      const link = ctx.linkTo(internal);
      view.dispatch({ changes: { from: pos, insert: link }, selection: EditorSelection.cursor(pos + link.length), userEvent: 'input.drop' });
      view.focus();
      return true;
    }
    const files = filesOf(event.dataTransfer);
    if (files.length === 0) return false;
    event.preventDefault();
    ctx.insertFiles(files, { from: pos, to: pos }, false);
    return true;
  },
});
