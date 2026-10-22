// The app's items of the `/` menu (DESIGN §6.6.2): its palette commands that insert into the open
// note (templates, attachments, encrypted text, voice notes, tasks) and a new embedded file of each
// view that can create one (drawing, spreadsheet, canvas). The editor's own items are in
// editor/slashItems.ts.
import type { EditorView } from '@codemirror/view';
import { activeEditor } from '../editor/activeEditor';
import { historyEditor } from '../editor/livePreview/table';
import { registerSlashItem, type SlashItem } from '../editor/slash';
import { getCommand, runCommand } from '../features/commands';
import { createAndEmbed, noteSessionOf, pickAndInsertImages } from '../features/editorInsertions';
import { activePath } from '../features/navigation';
import { registeredViews } from '../views/registry';

/** Whether `view` is the open note's editor (or one of its table cells): the one palette commands work on. */
function isActiveNote(view: EditorView): boolean {
  return activeEditor() !== null && historyEditor(view) === activeEditor();
}

/** An item that runs a palette command, offered while the command is available. */
function commandItem(command: string, item: Omit<SlashItem, 'id' | 'run' | 'when'>): SlashItem {
  return {
    id: command,
    ...item,
    when: (view) => {
      const c = getCommand(command);
      return c !== undefined && isActiveNote(view) && (!c.when || c.when({ activePath: activePath() }));
    },
    run: () => {
      runCommand(command, { activePath: activePath() });
    },
  };
}

export function registerAppSlashItems(): void {
  registerSlashItem(commandItem('templates.insert', { label: 'Template…', keywords: 'insert template snippet', group: 'Insert', scope: 'block', order: 30 }));
  registerSlashItem({
    id: 'image',
    label: 'Image…',
    keywords: 'picture photo upload attachment',
    group: 'File',
    scope: 'block',
    order: 55,
    run: (view) => pickAndInsertImages(view),
  });
  registerSlashItem(commandItem('editor.insertAttachment', { label: 'Attachment…', keywords: 'file upload pdf document', group: 'File', scope: 'block', order: 56 }));
  registerSlashItem(commandItem('encryption.insertSection', { label: 'Encrypted text…', keywords: 'encrypt secret password lock private', group: 'Insert', scope: 'block', order: 70 }));
  registerSlashItem(commandItem('voice.record', { label: 'Voice note', keywords: 'record audio microphone dictate transcribe', group: 'Insert', scope: 'block', order: 71 }));
  registerSlashItem(commandItem('tasks.quickAdd', { label: 'New task…', keywords: 'task todo add reminder due', group: 'Insert', scope: 'block', order: 72 }));
  registerSlashItem(commandItem('properties.add', { label: 'Add property', keywords: 'property properties frontmatter metadata yaml field', group: 'Insert', scope: 'block', order: 73 }));
  registerEmbedSlashItems();
}

/** "New drawing (embedded)" and the like, for every view that can create a file (also ones registered later). */
export function registerEmbedSlashItems(): void {
  let order = 60;
  for (const d of registeredViews()) {
    const create = d.create;
    if (!create || d.id === 'markdown') continue;
    registerSlashItem({
      id: `embed.new.${d.id}`,
      label: `New ${create.label} (embedded)`,
      keywords: `embed create new ${create.label} ${d.id} ${create.extension}`,
      group: 'File',
      scope: 'block',
      order: order++,
      when: (view) => noteSessionOf(view) !== undefined,
      run: (view) => void createAndEmbed(view, create),
    });
  }
}
