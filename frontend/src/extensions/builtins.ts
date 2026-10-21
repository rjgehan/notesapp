// Every v1 view, panel and command, registered through the public extension points (DESIGN §6.8).
import { openSearchPanel } from '@codemirror/search';
import {
  CalendarDays,
  Command as CommandIcon,
  FileBraces,
  FileImage,
  FilePlay,
  FilePlus,
  GitCommitHorizontal,
  FileQuestionMark,
  FileSearch,
  FileText,
  Files,
  History,
  LayoutTemplate,
  Link2,
  ListTree,
  Search,
  Settings as SettingsIcon,
  Tags,
  Trash,
} from 'lucide-react';
import { api } from '../api/endpoints';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import { showPanel, toggleSidebar } from '../components/layout/showPanel';
import SearchPanel from '../components/panels/SearchPanel';
import { confirmDelete, promptNewFolder } from '../components/explorer/rowActions';
import { activeEditor } from '../editor/activeEditor';
import { insertWikilink } from '../editor/completion';
import { followLinkAtCursor, insertMarkdownLink, toggleBold, toggleCheckbox, toggleItalic } from '../editor/editorCommands';
import { pickAndInsertAttachments } from '../features/attachments';
import { getCommand, setViewCommandSource } from '../features/commands';
import { isDailyNote, openAdjacentDailyNote, openTodaysDailyNote } from '../features/daily';
import { toastError } from '../features/errors';
import { copyLink, createNote, downloadFile, nameWithExtension, newNoteFolder, renameEntry, validateNewName } from '../features/fileOps';
import { navigateTo, openSearch } from '../features/navigation';
import { toggleNoteMode } from '../features/noteMode';
import { basenameOf, folderOf, isNotePath } from '../features/paths';
import { promptText } from '../state/dialogs';
import { toggleTheme } from '../state/prefs';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
import { documents } from '../sync/instance';
import { eventStream } from '../sync/liveSync';
import { onViewsChanged, registeredViews, viewFor } from '../views/registry';
import { registerCommand, registerPage, registerPanel, registerView } from './index';

let registered = false;

function goTo(route: string): void {
  useUi.getState().setDrawerOpen(false);
  navigateTo(route);
}

function editorCommand(id: string, name: string, run: (view: NonNullable<ReturnType<typeof activeEditor>>) => unknown, editorHotkey?: string) {
  registerCommand({
    id,
    name,
    editorHotkey,
    when: () => activeEditor() !== null,
    run: () => {
      const view = activeEditor();
      if (view) {
        run(view);
        // Back to the text from the palette or toolbar, unless the command moved the focus into
        // the editor itself (the find panel's search field).
        if (!view.dom.contains(document.activeElement)) view.focus();
      }
    },
  });
}

const hasFile = (c: { activePath: string | null }) => c.activePath !== null && currentTree().byPath.has(c.activePath);
const hasNote = (c: { activePath: string | null }) => c.activePath !== null && isNotePath(c.activePath) && currentTree().byPath.has(c.activePath);

/**
 * Views that can create files add "Create new <label>" to the palette (DESIGN §6.8), also those
 * registered later. The Markdown view's create is the built-in file.newNote (Mod-Alt-N).
 */
function registerCreateCommands(): void {
  for (const d of registeredViews()) {
    const create = d.create;
    if (!create || d.id === 'markdown' || getCommand(`file.new.${d.id}`)) continue;
    registerCommand({
      id: `file.new.${d.id}`,
      name: `Create new ${create.label}`,
      icon: d.icon,
      run: (c) => createNote(newNoteFolder(c.activePath), create.initialContent(), create.extension),
    });
  }
}

/** F2 / "Rename current file": the inline title when the note shows one, otherwise a prompt. */
function renameCurrent(path: string): void {
  const title = document.querySelector<HTMLTextAreaElement>('.inline-title-input:not([readonly])');
  if (title) {
    title.focus();
    title.select();
    return;
  }
  void promptText({
    title: 'Rename file',
    label: 'Name',
    value: basenameOf(path),
    confirmLabel: 'Rename',
    validate: (v) => (v.trim() === '' ? null : validateNewName(nameWithExtension(path, v.trim(), 'file'))),
  }).then((name) => {
    if (name) renameEntry(path, name, 'file').catch((e: unknown) => toastError(e));
  });
}

export function registerBuiltins(): void {
  if (registered) return;
  registered = true;

  // ---------- views ----------
  registerView({
    id: 'markdown',
    match: (e) => (e.path.toLowerCase().endsWith('.md') ? 3 : 0),
    icon: FileText,
    textual: true,
    modes: ['edit', 'read'],
    load: () => import('../views/markdown/MarkdownView'),
    loadEmbed: () => import('../render/NoteEmbed'),
    create: { label: 'note', extension: 'md', initialContent: () => '' },
  });
  registerView({
    id: 'text',
    match: (e) => (e.kind === 'text' ? 2 : 0),
    icon: FileBraces,
    textual: true,
    modes: ['edit'],
    load: () => import('../views/TextView'),
  });
  registerView({
    id: 'image',
    match: (e) => (e.kind === 'image' ? 2 : 0),
    icon: FileImage,
    textual: false,
    modes: ['read'],
    load: () => import('../views/ImageView'),
  });
  registerView({
    id: 'pdf',
    match: (e) => (e.kind === 'pdf' ? 2 : 0),
    icon: FileText,
    textual: false,
    modes: ['read'],
    load: () => import('../views/PdfView'),
  });
  registerView({
    id: 'media',
    match: (e) => (e.kind === 'audio' || e.kind === 'video' ? 2 : 0),
    icon: FilePlay,
    textual: false,
    modes: ['read'],
    load: () => import('../views/MediaView'),
  });
  registerView({
    id: 'unsupported',
    match: () => 1,
    icon: FileQuestionMark,
    textual: false,
    modes: ['read'],
    load: () => import('../views/UnsupportedView'),
  });
  registerCreateCommands();
  onViewsChanged(registerCreateCommands);
  // Commands contributed by a view are active only while that view shows the open file.
  setViewCommandSource((path) => {
    const entry = path ? currentTree().byPath.get(path) : undefined;
    return entry ? (viewFor(entry).commands ?? []) : [];
  });

  // ---------- panels ----------
  registerPanel({ id: 'files', side: 'left', title: 'Files', icon: Files, load: () => import('../components/panels/FilesPanel') });
  // Eager: Mod-Shift-F focuses its field inside the key press.
  registerPanel({ id: 'search', side: 'left', title: 'Search', icon: Search, component: SearchPanel, load: () => Promise.resolve({ default: SearchPanel }) });
  registerPanel({ id: 'tags', side: 'left', title: 'Tags', icon: Tags, load: () => import('../components/panels/TagsPanel') });
  registerPanel({ id: 'backlinks', side: 'right', title: 'Backlinks', icon: Link2, load: () => import('../components/panels/BacklinksPanel') });
  registerPanel({ id: 'outline', side: 'right', title: 'Outline', icon: ListTree, load: () => import('../components/panels/OutlinePanel') });
  registerPanel({ id: 'history', side: 'right', title: 'History', icon: History, load: () => import('../components/panels/HistoryPanel') });

  // ---------- pages ----------
  // The vault-wide history (ROADMAP item 28): timeline, changes over a period, deleted files.
  registerPage({ route: 'history', title: 'Vault history', icon: GitCommitHorizontal, load: () => import('../components/pages/VaultHistoryPage') });

  // ---------- app ----------
  registerCommand({ id: 'app.quickSwitcher', name: 'Open quick switcher', hotkey: 'Mod-o', icon: FileSearch, run: () => useUi.getState().setOverlay('switcher') });
  registerCommand({ id: 'app.commandPalette', name: 'Open command palette', hotkey: 'Mod-p', icon: CommandIcon, run: () => useUi.getState().setOverlay('palette') });
  registerCommand({ id: 'app.resync', name: 'Reload vault from server', run: () => eventStream.resyncNow() });

  // ---------- files ----------
  registerCommand({ id: 'file.newNote', name: 'Create new note', hotkey: 'Mod-Alt-n', icon: FilePlus, run: (c) => createNote(newNoteFolder(c.activePath)) });
  registerCommand({ id: 'file.newNoteFromTemplate', name: 'Create new note from template', icon: LayoutTemplate, run: () => useUi.getState().setOverlay('templates-new') });
  registerCommand({ id: 'file.newFolder', name: 'Create new folder', run: (c) => promptNewFolder(c.activePath ? folderOf(c.activePath) : '') });
  registerCommand({ id: 'file.rename', name: 'Rename current file', hotkey: 'F2', when: hasFile, run: (c) => renameCurrent(c.activePath!) });
  registerCommand({ id: 'file.move', name: 'Move current file to…', when: hasFile, run: (c) => useUi.getState().setMoveTarget({ path: c.activePath!, type: 'file' }) });
  registerCommand({ id: 'file.delete', name: 'Delete current file', when: hasFile, run: (c) => confirmDelete(c.activePath!, 'file') });
  registerCommand({
    id: 'file.reveal',
    name: 'Reveal current file in explorer',
    when: hasFile,
    run: (c) => {
      showPanel('left', 'files');
      useUi.getState().revealInExplorer(c.activePath!);
    },
  });
  registerCommand({ id: 'file.copyLink', name: 'Copy link to current file', when: hasFile, run: (c) => copyLink(c.activePath!, c.activePath) });
  registerCommand({
    id: 'file.download',
    name: 'Download current file',
    when: hasFile,
    run: (c) => {
      const entry = currentTree().byPath.get(c.activePath!);
      if (entry) downloadFile(entry);
    },
  });

  // ---------- editor ----------
  registerCommand({ id: 'editor.toggleMode', name: 'Toggle reading/editing view', hotkey: 'Mod-e', run: toggleNoteMode, when: (c) => c.activePath !== null && isNotePath(c.activePath) });
  registerCommand({
    id: 'editor.save',
    name: 'Save now',
    hotkey: 'Mod-s',
    when: (c) => c.activePath !== null,
    run: (c) => {
      const s = c.activePath ? documents.get(c.activePath) : undefined;
      if (s) void s.flush();
    },
  });
  editorCommand('editor.followLink', 'Follow link under cursor', followLinkAtCursor, 'Mod-Enter');
  editorCommand('editor.toggleCheckbox', 'Toggle checklist status', toggleCheckbox, 'Mod-l');
  editorCommand('editor.bold', 'Toggle bold', toggleBold, 'Mod-b');
  editorCommand('editor.italic', 'Toggle italic', toggleItalic, 'Mod-i');
  editorCommand('editor.insertLink', 'Insert Markdown link', insertMarkdownLink, 'Mod-k');
  editorCommand('editor.insertWikilink', 'Insert internal link', insertWikilink);
  editorCommand('editor.find', 'Find/replace in current note', openSearchPanel, 'Mod-f');
  registerCommand({
    id: 'editor.insertAttachment',
    name: 'Insert attachment…',
    when: hasNote,
    run: (c) => {
      const session = documents.get(c.activePath!);
      if (session) pickAndInsertAttachments(session);
    },
  });

  // ---------- search, daily notes, templates ----------
  registerCommand({
    id: 'search.open',
    name: 'Search in all notes',
    hotkey: 'Mod-Shift-f',
    icon: Search,
    run: () => {
      openSearch(useUi.getState().searchQuery);
      useUi.getState().requestSearchFocus();
    },
  });
  registerCommand({
    id: 'daily.today',
    name: "Open today's daily note",
    icon: CalendarDays,
    run: async () => {
      await openTodaysDailyNote();
    },
  });
  registerCommand({ id: 'daily.prev', name: 'Open previous daily note', when: (c) => isDailyNote(c.activePath), run: (c) => openAdjacentDailyNote(c.activePath!, -1) });
  registerCommand({ id: 'daily.next', name: 'Open next daily note', when: (c) => isDailyNote(c.activePath), run: (c) => openAdjacentDailyNote(c.activePath!, 1) });
  registerCommand({ id: 'templates.insert', name: 'Insert template', icon: LayoutTemplate, when: hasNote, run: () => useUi.getState().setOverlay('templates') });

  // ---------- layout ----------
  registerCommand({ id: 'view.toggleLeft', name: 'Toggle left sidebar', run: () => toggleSidebar('left') });
  registerCommand({ id: 'view.toggleRight', name: 'Toggle right sidebar', run: () => toggleSidebar('right') });
  registerCommand({ id: 'view.files', name: 'Show files', run: () => showPanel('left', 'files') });
  registerCommand({ id: 'view.search', name: 'Show search', run: () => showPanel('left', 'search') });
  registerCommand({ id: 'view.tags', name: 'Show tags', run: () => showPanel('left', 'tags') });
  registerCommand({ id: 'view.backlinks', name: 'Show backlinks', run: () => showPanel('right', 'backlinks') });
  registerCommand({ id: 'view.outline', name: 'Show outline', run: () => showPanel('right', 'outline') });
  registerCommand({ id: 'view.history', name: 'Show file history', run: () => showPanel('right', 'history') });

  // ---------- history, navigation, pages ----------
  registerCommand({
    id: 'history.commitNow',
    name: 'Commit pending changes now',
    run: async () => {
      try {
        const { commitId } = await api.commitHistory();
        toast(commitId ? 'Committed pending changes' : 'Nothing to commit');
        void queryClient.invalidateQueries({ queryKey: queryKeys.historyAll() });
      } catch (e) {
        toastError(e);
      }
    },
  });
  registerCommand({ id: 'nav.back', name: 'Navigate back', hotkey: 'Mod-Alt-ArrowLeft', run: () => window.history.back() });
  registerCommand({ id: 'nav.forward', name: 'Navigate forward', hotkey: 'Mod-Alt-ArrowRight', run: () => window.history.forward() });
  registerCommand({ id: 'trash.open', name: 'Open trash', icon: Trash, run: () => goTo('/trash') });
  registerCommand({ id: 'settings.open', name: 'Open settings', hotkey: 'Mod-,', icon: SettingsIcon, run: () => goTo('/settings') });
  registerCommand({ id: 'theme.toggle', name: 'Toggle dark/light theme', run: toggleTheme });

}
