// Edit/read mode of the open note (DESIGN §6.4, §6.7). `?mode=read` forces the reading view;
// a note this tab has just created opens in the editor; otherwise the mode chosen in this page
// load, else `settings.editor.defaultMode`. The scroll position maps between the modes through
// the source line at the top of the workspace.
import { useLocation } from 'react-router';
import { currentSettings, useVaultSettings } from '../api/hooks';
import { useUi, type NoteMode } from '../state/ui';
import { lastInputWasKeyboard, requestNoteFocus } from './focus';
import { activePath, navigateTo } from './navigation';
import { pathFromLocation } from './paths';

function forcedMode(search: string): NoteMode | null {
  return new URLSearchParams(search).get('mode') === 'read' ? 'read' : null;
}

/** "New note, title, Enter, type" must land in an editor, even when other notes show reading view. */
function newNoteMode(path: string | null, editingNew: string | null): NoteMode | null {
  return path !== null && path === editingNew ? 'edit' : null;
}

export function useNoteMode(): NoteMode {
  const location = useLocation();
  const chosen = useUi((s) => s.noteMode);
  const editingNew = useUi((s) => s.editingNew);
  const settings = useVaultSettings();
  return forcedMode(location.search) ?? newNoteMode(pathFromLocation(location.pathname), editingNew) ?? chosen ?? settings.editor.defaultMode;
}

export function currentNoteMode(): NoteMode {
  const ui = useUi.getState();
  return forcedMode(window.location.search) ?? newNoteMode(activePath(), ui.editingNew) ?? ui.noteMode ?? currentSettings().editor.defaultMode;
}

/** The note at `path` (just created, or its title left with Enter) shows the editor. */
export function editNote(path: string): void {
  useUi.getState().setEditingNew(path);
}

let topLineProbe: (() => number | null) | null = null;
let pendingLine: number | null = null;

/** The visible view registers how to read its top source line before a mode switch. */
export function setTopLineProbe(probe: (() => number | null) | null): void {
  topLineProbe = probe;
}

/** The line the newly shown mode should scroll to (consumed once). */
export function takePendingModeLine(): number | null {
  const line = pendingLine;
  pendingLine = null;
  return line;
}

export function setNoteMode(mode: NoteMode): void {
  if (mode === currentNoteMode()) return;
  pendingLine = topLineProbe?.() ?? null;
  // Toggling from the keyboard, or from inside the note, keeps the focus in the note: the
  // incoming editor or reading view takes it (DESIGN §6.19).
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (lastInputWasKeyboard() || (active instanceof HTMLElement && active.closest('.markdown-view'))) requestNoteFocus();
  useUi.getState().setEditingNew(null);
  useUi.getState().setNoteMode(mode);
  const params = new URLSearchParams(window.location.search);
  if (params.has('mode')) {
    params.delete('mode');
    const search = params.toString();
    navigateTo(window.location.pathname + (search ? '?' + search : '') + window.location.hash, { replace: true });
  }
}

export function toggleNoteMode(): void {
  setNoteMode(currentNoteMode() === 'edit' ? 'read' : 'edit');
}
