// Properties (ROADMAP item 13, DESIGN §6.41) through the extension points of DESIGN §6.8: the
// Properties panel of the left sidebar, "Add property" (Mod-;) and "Rename property in every
// note…" commands, and event handlers that refresh the property list as notes change and the
// types when another device changes them (`types.changed`, API.md §38.2).
import { EditorSelection } from '@codemirror/state';
import { ListPlus, SlidersHorizontal } from 'lucide-react';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { activeEditor } from '../editor/activeEditor';
import { editingProperties, editProperties, hasPropertiesBlock } from '../editor/livePreview/blocks';
import { registerCommand, registerEventHandler, registerPanel } from '../extensions';
import { splitFrontmatter } from '../features/frontmatter';
import { promptText } from '../state/dialogs';
import { toast } from '../state/toasts';
import { propertyKeys } from './api';
import { renameAcrossVault } from './rename';
import { addRequests } from './requests';

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

/** "Add property": opens the new-property row of the open note, creating its frontmatter if it has none. */
export function addPropertyToActiveNote(path: string): void {
  const view = activeEditor();
  if (!view || view.state.readOnly) {
    toast('Open the note for editing to add a property');
    return;
  }
  const text = view.state.doc.toString();
  const split = splitFrontmatter(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (hasPropertiesBlock(view.state)) {
    if (split.yaml === null) view.dispatch({ changes: { from: 0, insert: `---${eol}---${eol}` }, userEvent: 'properties.edit' });
    // Properties shown as YAML text go back to the editor, whose new-property row opens.
    else if (editingProperties(view.state)) view.dispatch({ effects: editProperties.of(false) });
    addRequests.request(path, view.dom);
    return;
  }
  // Source mode: the caret goes on a new line at the end of the frontmatter.
  if (split.yaml === null) {
    view.dispatch({ changes: { from: 0, insert: `---${eol}${eol}---${eol}` }, selection: EditorSelection.cursor(4 + eol.length - 1), scrollIntoView: true, userEvent: 'input' });
  } else {
    const yamlEnd = text.indexOf('\n') + 1 + split.yaml.length;
    view.dispatch({ changes: { from: yamlEnd, insert: eol }, selection: EditorSelection.cursor(yamlEnd), scrollIntoView: true, userEvent: 'input' });
  }
  view.focus();
}

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
    run: (c) => addPropertyToActiveNote(c.activePath!),
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
