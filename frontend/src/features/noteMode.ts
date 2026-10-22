// The open file's mode (DESIGN §6.4, §6.6.1). Notes show Live Preview (`live`, the default),
// styled source (`source`) or Live Preview read-only (`locked`), which is also the reading view:
// since ROADMAP 10b there is one look everywhere. Other views show `edit` or `read`. The mode is
// chosen per file for the page load: `?mode=read` forces reading (a locked note); a note this tab
// has just created opens in the editor; otherwise the mode chosen for the file, else
// `settings.editor.defaultMode` (`edit` is Live Preview, `read` a locked note). The scroll
// position maps between the modes through the source line at the top of the workspace.
import { useLocation } from 'react-router';
import { currentSettings, useVaultSettings } from '../api/hooks';
import type { Settings } from '../api/types';
import { useUi, type ViewMode } from '../state/ui';
import { lastInputWasKeyboard, requestNoteFocus } from './focus';
import { activePath, navigateTo } from './navigation';
import { pathFromLocation } from './paths';
import { appPathname } from '../state/vault';

/** `?mode=read` (a link from search, say): a note shows locked, another file its reading mode (`viewModeFor`). */
function forcedMode(search: string): ViewMode | null {
  return new URLSearchParams(search).get('mode') === 'read' ? 'locked' : null;
}

/**
 * "New note, title, Enter, type" must land in an editor, even when the note would otherwise be
 * locked. It keeps a note's own choice of source mode.
 */
function newNoteMode(path: string | null, editingNew: string | null, chosen: ViewMode | null): ViewMode | null {
  return path !== null && path === editingNew ? (chosen === 'source' ? 'source' : 'live') : null;
}

/** `settings.editor.defaultMode`: `edit` is Live Preview, `read` a locked note (the reading view). */
function defaultMode(settings: Settings): ViewMode {
  return settings.editor.defaultMode === 'read' ? 'locked' : 'live';
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
    navigateTo(appPathname() + (search ? '?' + search : '') + window.location.hash, { replace: true });
  }
}

/**
 * Mod-E: locks a note being edited (Live Preview, read-only: the reading view) and unlocks it into
 * Live Preview. Views without the note modes toggle between `edit` and `read`.
 */
export function toggleNoteMode(): void {
  const mode = currentNoteMode();
  if (mode === 'edit') setNoteMode('read');
  else setNoteMode(mode === 'live' || mode === 'source' ? 'locked' : 'live');
}

/** Switches a note between Live Preview and source mode (a locked note opens in source). */
export function toggleSourceMode(): void {
  setNoteMode(currentNoteMode() === 'source' ? 'live' : 'source');
}

/** The note at `path` (just created, or its title left with Enter) shows the editor. */
export function editNote(path: string): void {
  useUi.getState().setEditingNew(path);
}
