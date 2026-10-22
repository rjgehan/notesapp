// Kanban boards (ROADMAP item 15, DESIGN §6.8.4): palette commands. The board is not a view of its
// own (a board is a note, recognized by its frontmatter): the Markdown view shows it.
import { FileText, LayoutDashboard, SquareKanban } from 'lucide-react';
import { registerCommand } from '../../features/commands';
import { createNote, newNoteFolder } from '../../features/fileOps';
import { documents } from '../../sync/instance';
import { isKanbanText, KANBAN_PROBE_CHARS, setKanbanAsMarkdown, showsKanbanAsMarkdown } from './detect';

function isOpenBoard(path: string | null): path is string {
  const session = path ? documents.get(path) : undefined;
  return !!session && session.getSnapshot().loaded && isKanbanText(session.editorState.doc.sliceString(0, KANBAN_PROBE_CHARS));
}

export function registerKanban(): void {
  registerCommand({
    id: 'file.new.kanban',
    name: 'Create new Kanban board',
    icon: SquareKanban,
    run: (c) => createNote(newNoteFolder(c.activePath), import('./format').then((m) => m.newBoardText())),
  });
  registerCommand({
    id: 'kanban.showMarkdown',
    name: 'Kanban: Open as Markdown',
    icon: FileText,
    when: (c) => isOpenBoard(c.activePath) && !showsKanbanAsMarkdown(c.activePath),
    run: (c) => {
      if (c.activePath) setKanbanAsMarkdown(c.activePath, true);
    },
  });
  registerCommand({
    id: 'kanban.showBoard',
    name: 'Kanban: Open as board',
    icon: LayoutDashboard,
    when: (c) => isOpenBoard(c.activePath) && showsKanbanAsMarkdown(c.activePath),
    run: (c) => {
      if (c.activePath) setKanbanAsMarkdown(c.activePath, false);
    },
  });
}
