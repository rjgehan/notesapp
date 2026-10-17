// The open file's mode (DESIGN §6.4, §6.6.1). Notes show Live Preview (`live`, the default),
// styled source (`source`), Live Preview read-only (`locked`) or, until ROADMAP 10b replaces it
// with `locked`, the v1 reading view (`read`). The mode is chosen per file for the page load:
// `?mode=read` forces the reading view; a note this tab has just created opens in the editor;
// otherwise the mode chosen for the file, else `settings.editor.defaultMode` (`edit` is Live
// Preview). The scroll position maps between the modes through the source line at the top of the
// workspace.
import { useLocation } from 'react-router';
import { currentSettings, useVaultSettings } from '../api/hooks';
import type { Settings } from '../api/types';
import { useUi, type ViewMode } from '../state/ui';
import { lastInputWasKeyboard, requestNoteFocus } from './focus';
import { activePath, navigateTo } from './navigation';
import { pathFromLocation } from './paths';

function forcedMode(search: string): ViewMode | null {
  return new URLSearchParams(search).get('mode') === 'read' ? 'read' : null;
}

/**
 * "New note, title, Enter, type" must land in an editor, even when the note would otherwise show
 * the reading view or be locked. It keeps a note's own choice of source mode.
 */
function newNoteMode(path: string | null, editingNew: string | null, chosen: ViewMode | null): ViewMode | null {
  return path !== null && path === editingNew ? (chosen === 'source' ? 'source' : 'live') : null;
}

function defaultMode(settings: Settings): ViewMode {
  return settings.editor.defaultMode === 'read' ? 'read' : 'live';
}

function resolve(path: string | null, search: string, settings: Settings, modes: Record<string, ViewMode>, editingNew: string | null): ViewMode {
  const chosen = path === null ? null : (modes[path] ?? null);
  return forcedMode(search) ?? newNoteMode(path, editingNew, chosen) ?? chosen ?? defaultMode(settings);
}

export function useNoteMode(): ViewMode {
  const location = useLocation();
  const path = pathFromLocation(location.pathname);
  const modes = useUi((s) => s.noteModes);
  const editingNew = useUi((s) => s.editingNew);
  const settings = useVaultSettings();
  return resolve(path, location.search, settings, modes, editingNew);
}

export function currentNoteMode(): ViewMode {
  const ui = useUi.getState();
  return resolve(activePath(), window.location.search, currentSettings(), ui.noteModes, ui.editingNew);
}

/** True for the modes that edit the text (Live Preview and source). */
export function isEditingMode(mode: ViewMode): boolean {
  return mode === 'live' || mode === 'source' || mode === 'edit';
}

/**
 * The mode a view shows for the chosen `mode`: the mode itself when the view has it, otherwise
 * its nearest equivalent (an editing mode becomes `edit`, `locked` becomes `read`), else the
 * view's first mode.
 */
export function viewModeFor(mode: ViewMode, modes: readonly ViewMode[]): ViewMode {
  if (modes.includes(mode)) return mode;
  const near: ViewMode[] = isEditingMode(mode) ? ['edit', 'live'] : mode === 'locked' ? ['read'] : mode === 'read' ? ['locked'] : [];
  return near.find((m) => modes.includes(m)) ?? modes[0] ?? 'read';
}

/** Puts a note shown in `mode` into the mode the toggles would leave it in (the default when it is one). */
function choose(path: string, mode: ViewMode): void {
  const ui = useUi.getState();
  ui.setNoteMode(path, mode === defaultMode(currentSettings()) ? null : mode);
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

/** Shows the open file in `mode`. */
export function setNoteMode(mode: ViewMode): void {
  const path = activePath();
  if (path === null || mode === currentNoteMode()) return;
  pendingLine = topLineProbe?.() ?? null;
  // Toggling from the keyboard, or from inside the note, keeps the focus in the note: the
  // incoming editor or reading view takes it (DESIGN §6.19).
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (lastInputWasKeyboard() || (active instanceof HTMLElement && active.closest('.markdown-view'))) requestNoteFocus();
  useUi.getState().setEditingNew(null);
  choose(path, mode);
  const params = new URLSearchParams(window.location.search);
  if (params.has('mode')) {
    params.delete('mode');
    const search = params.toString();
    navigateTo(window.location.pathname + (search ? '?' + search : '') + window.location.hash, { replace: true });
  }
}

/**
 * Mod-E: locks a note being edited (Live Preview, read-only) and unlocks it into Live Preview; the
 * reading view goes back to editing. Views without the note modes toggle between `edit` and `read`.
 */
export function toggleNoteMode(): void {
  const mode = currentNoteMode();
  if (mode === 'edit') setNoteMode('read');
  else setNoteMode(mode === 'live' || mode === 'source' ? 'locked' : 'live');
}

/** Switches a note between Live Preview and source mode (a locked note or the reading view opens in source). */
export function toggleSourceMode(): void {
  setNoteMode(currentNoteMode() === 'source' ? 'live' : 'source');
}

/** The v1 reading view and back (ROADMAP 10b replaces it with `locked`). */
export function toggleReadingView(): void {
  setNoteMode(currentNoteMode() === 'read' ? 'live' : 'read');
}

/** The note at `path` (just created, or its title left with Enter) shows the editor. */
export function editNote(path: string): void {
  useUi.getState().setEditingNew(path);
}
