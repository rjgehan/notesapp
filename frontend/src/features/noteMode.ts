// The open file's mode (DESIGN §6.4, §6.6.1). Every note opens in Live Preview (`live`): rendered
// and editable in place, so there is no reading view to switch to and nothing to switch back.
// The Markdown source (`source`) is a troubleshooting escape hatch ("Show Markdown source" in the
// ⋯ menu and the palette), kept per note for the page load only, so a reload shows every note in
// Live Preview again. `settings.editor.defaultMode`, `?mode=read` and the modes older builds
// stored are ignored: no note can open locked or stuck in source mode. Other views show their
// own `edit` or `read`. The scroll position maps between the modes through the source line at the
// top of the workspace.
import { useLocation } from 'react-router';
import { useUi, type ViewMode } from '../state/ui';
import { lastInputWasKeyboard, requestNoteFocus } from './focus';
import { activePath, navigateTo } from './navigation';
import { pathFromLocation } from './paths';
import { appPathname } from '../state/vault';

/** A note's mode from the stored choice: `source` only when it was chosen in this page load. */
export function noteModeOf(chosen: unknown): 'live' | 'source' {
  return chosen === 'source' ? 'source' : 'live';
}

function resolve(path: string | null, modes: Record<string, string>): ViewMode {
  return noteModeOf(path === null ? null : modes[path]);
}

export function useNoteMode(): ViewMode {
  const location = useLocation();
  const path = pathFromLocation(location.pathname);
  const modes = useUi((s) => s.noteModes);
  return resolve(path, modes);
}

export function currentNoteMode(): ViewMode {
  return resolve(activePath(), useUi.getState().noteModes);
}

/** True for the modes that edit the text (Live Preview and source). */
export function isEditingMode(mode: ViewMode): boolean {
  return mode === 'live' || mode === 'source' || mode === 'edit';
}

/**
 * The mode a view shows for the chosen `mode`: the mode itself when the view has it, otherwise
 * its nearest equivalent (an editing mode becomes `edit` or `live`, `read` a note's `live`), else
 * the view's first mode.
 */
export function viewModeFor(mode: ViewMode, modes: readonly ViewMode[]): ViewMode {
  if (modes.includes(mode)) return mode;
  const near: ViewMode[] = isEditingMode(mode) ? ['edit', 'live'] : ['live'];
  return near.find((m) => modes.includes(m)) ?? modes[0] ?? 'read';
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

/** Shows the open note as Markdown source (`source`) or in Live Preview (anything else). */
export function setNoteMode(mode: ViewMode): void {
  const path = activePath();
  const next = noteModeOf(mode);
  if (path === null || next === currentNoteMode()) return;
  pendingLine = topLineProbe?.() ?? null;
  // Switching from the keyboard, or from inside the note, keeps the focus in the note: the
  // incoming editor takes it (DESIGN §6.19).
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (lastInputWasKeyboard() || (active instanceof HTMLElement && active.closest('.markdown-view'))) requestNoteFocus();
  useUi.getState().setNoteMode(path, next === 'source' ? 'source' : null);
  // An old `?mode=read` link means nothing now; it goes from the address with the first switch.
  const params = new URLSearchParams(window.location.search);
  if (params.has('mode')) {
    params.delete('mode');
    const search = params.toString();
    navigateTo(appPathname() + (search ? '?' + search : '') + window.location.hash, { replace: true });
  }
}

/** "Show Markdown source": shows the open note's source, or Live Preview again. */
export function toggleSourceMode(): void {
  setNoteMode(currentNoteMode() === 'source' ? 'live' : 'source');
}

/** "Back to normal view": Live Preview again. */
export function showLivePreview(): void {
  setNoteMode('live');
}
