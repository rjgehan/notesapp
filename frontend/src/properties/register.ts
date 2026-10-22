// Properties (ROADMAP item 13, DESIGN §6.41) through the extension points of DESIGN §6.8: the
// Properties panel of the left sidebar, "Add property" (Mod-;) and "Rename property in every
// note…" commands, and event handlers that refresh the property list as notes change and the
// types when another device changes them (`types.changed`, API.md §38.2).
import { ListPlus, SlidersHorizontal } from 'lucide-react';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { registerCommand, registerEventHandler, registerPanel } from '../extensions';
import { promptText } from '../state/dialogs';
import { propertyKeys } from './api';
import { renameAcrossVault } from './rename';

/** Any note may gain, change or lose properties. */
const NOTE_EVENTS = ['file.created', 'file.changed', 'file.deleted', 'entry.moved', 'folder.deleted'];
export const REFRESH_DEBOUNCE_MS = 1000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Refetches the property list and values soon (one refetch for a burst of changes). */
export function schedulePropertiesRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void queryClient.invalidateQueries({ queryKey: ['properties', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['properties', 'values'] });
  }, REFRESH_DEBOUNCE_MS);
}

const isNote = (path: string | null): path is string => path !== null && currentTree().byPath.get(path)?.kind === 'note';

let registered = false;

export function registerProperties(): void {
  if (registered) return;
  registered = true;
  registerPanel({ id: 'properties', side: 'left', title: 'Properties', icon: SlidersHorizontal, load: () => import('./ui/PropertiesPanel') });
  registerCommand({
    id: 'properties.add',
    name: 'Add file property',
    hotkey: 'Mod-;',
    globalHotkey: true,
    icon: ListPlus,
    when: (c) => isNote(c.activePath),
    // The editor's code loads with the command (an open note's editor has loaded it already).
    run: (c) => void import('./addProperty').then((m) => m.addPropertyToActiveNote(c.activePath!)),
  });
  registerCommand({
    id: 'properties.renameEverywhere',
    name: 'Rename property in every note…',
    run: async () => {
      const from = await promptText({ title: 'Rename property', label: 'Property to rename', value: '', confirmLabel: 'Next' });
      if (from?.trim()) await renameAcrossVault(from.trim());
    },
  });
  for (const name of NOTE_EVENTS) registerEventHandler(name, schedulePropertiesRefresh);
  registerEventHandler('types.changed', () => {
    void queryClient.invalidateQueries({ queryKey: propertyKeys.types() });
    void queryClient.invalidateQueries({ queryKey: propertyKeys.list() });
  });
}
