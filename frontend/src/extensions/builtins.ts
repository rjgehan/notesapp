// Every v1 view, panel and command, registered through the public extension points (DESIGN §6.8).
import { openSearchPanel } from '@codemirror/search';
import {
  Activity,
  Bookmark,
  BookmarkPlus,
  CalendarDays,
  Clock,
  CloudUpload,
  Command as CommandIcon,
  FileBraces,
  FileCheck,
  FileImage,
  FilePlay,
  FilePlus,
  GitCommitHorizontal,
  FileQuestionMark,
  FileSearch,
  FileText,
  Files,
  GitFork,
  History,
  Inbox,
  LayoutTemplate,
  Link2,
  ListTree,
  Mic,
  Search,
  Settings as SettingsIcon,
  Tags,
  Trash,
  Waypoints,
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
import { headingsFromState } from '../editor/outline';
import { followLinkAtCursor, toggleCheckbox } from '../editor/editorCommands';
import { setHeading, toggleBold, toggleBulletList, toggleHeading, toggleHighlight, toggleInlineCode, toggleItalic, toggleLink, toggleNumberedList, toggleQuote, toggleStrikethrough } from '../editor/formatting';
import { historyEditor, insertTable } from '../editor/livePreview/table';
import { pickAndInsertAttachments } from '../features/attachments';
import { currentBookmarks, isFileBookmarked, promptNewGroup, toggleFileBookmark, toggleSearchBookmark } from '../features/bookmarkStore';
import { findSearchBookmarks } from '../features/bookmarks';
import { promptRenameHeading } from '../features/headingRename';
import { getCommand, setViewCommandSource } from '../features/commands';
import { registerReminders } from '../features/reminders/register';
import { isDailyNote, openAdjacentDailyNote, openTodaysDailyNote } from '../features/daily';
import { toastError } from '../features/errors';
import { copyLink, createNote, downloadFile, nameWithExtension, newNoteFolder, renameEntry, validateNewName } from '../features/fileOps';
import { navigateTo, openSearch } from '../features/navigation';
import { mirrorConfigured, pushMirrorNow } from '../features/mirror';
import { toggleNoteMode, toggleSourceMode } from '../features/noteMode';
import { basenameOf, folderOf } from '../features/paths';
import { promptText } from '../state/dialogs';
import { toggleTheme } from '../state/prefs';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
import { documents } from '../sync/instance';
import { eventStream } from '../sync/liveSync';
import { registerTasks } from '../tasks/register';
import { registerFlashcards } from '../flashcards/register';
import { registerHabits } from '../habits/register';
import { registerCalendar } from '../calendar/register';
import { registerCanvasView } from '../views/canvas/register';
import { registerKanban } from '../views/kanban/register';
import { registerEncryption } from '../views/encrypted/register';
import { registerDrawingViews } from '../views/excalidraw/register';
import { registerPdfView } from '../views/pdf/register';
import { startVoiceNote, transcribeAtCursor } from '../features/voice/voiceNotes';
import { registerAi } from '../features/ai/register';
import { registerPublish } from '../components/publish/register';
import { isMarkdownViewPath, onViewsChanged, registeredViews, viewFor } from '../views/registry';
import { registerSheetView } from '../views/sheet/register';
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
        // the editor itself (the find panel's search field, which a table cell's is the note's).
        if (!historyEditor(view).dom.contains(document.activeElement)) view.focus();
      }
    },
  });
}

const hasFile = (c: { activePath: string | null }) => c.activePath !== null && currentTree().byPath.has(c.activePath);
// A note another view shows (an `.excalidraw.md` drawing) has no text to insert into.
const hasNote = (c: { activePath: string | null }) => c.activePath !== null && isMarkdownViewPath(c.activePath) && currentTree().byPath.has(c.activePath);

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
      run: (c) => createNote(newNoteFolder(c.activePath), create.initialContent(), create.extension, create.label),
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
    modes: ['live', 'source', 'locked'],
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
  registerSheetView();
  registerView({
    id: 'image',
    match: (e) => (e.kind === 'image' ? 2 : 0),
    icon: FileImage,
    textual: false,
    modes: ['read'],
    load: () => import('../views/ImageView'),
  });
  registerPdfView();
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
  registerDrawingViews();
  // JSON Canvas boards (ROADMAP item 25).
  registerCanvasView();
  registerKanban();
  registerEncryption();
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
  registerPanel({ id: 'bookmarks', side: 'left', title: 'Bookmarks', icon: Bookmark, load: () => import('../components/panels/BookmarksPanel') });
  registerPanel({ id: 'tags', side: 'left', title: 'Tags', icon: Tags, load: () => import('../components/panels/TagsPanel') });
  registerPanel({ id: 'recent', side: 'left', title: 'Recent files', icon: Clock, load: () => import('../components/panels/RecentPanel') });
  registerPanel({ id: 'backlinks', side: 'right', title: 'Backlinks', icon: Link2, load: () => import('../components/panels/BacklinksPanel') });
  registerPanel({ id: 'outline', side: 'right', title: 'Outline', icon: ListTree, load: () => import('../components/panels/OutlinePanel') });
  registerPanel({ id: 'history', side: 'right', title: 'History', icon: History, load: () => import('../components/panels/HistoryPanel') });
  // ROADMAP item 16: the open note's neighbourhood (DESIGN §6.28).
  registerPanel({ id: 'graph', side: 'right', title: 'Local graph', icon: Waypoints, load: () => import('../components/panels/LocalGraphPanel') });

  // ---------- pages ----------
  // The vault-wide history (ROADMAP item 28): timeline, changes over a period, deleted files.
  registerPage({ route: 'history', title: 'Vault history', icon: GitCommitHorizontal, load: () => import('../components/pages/VaultHistoryPage') });

  // ---------- app ----------
  registerCommand({ id: 'app.quickSwitcher', name: 'Open quick switcher', hotkey: 'Mod-o', icon: FileSearch, run: () => useUi.getState().setOverlay('switcher') });
  registerCommand({ id: 'app.commandPalette', name: 'Open command palette', hotkey: 'Mod-p', icon: CommandIcon, run: () => useUi.getState().setOverlay('palette') });
  registerCommand({ id: 'app.resync', name: 'Reload vault from server', run: () => eventStream.resyncNow() });
  // Quick capture (DESIGN §6.27): works everywhere, the editor included (features/hotkeys.ts).
  // Like quick add (§6.22), a capture key works while typing in a note or a field (globalHotkey).
  registerCommand({ id: 'capture.quick', name: 'Quick capture', hotkey: 'Mod-Shift-Space', globalHotkey: true, icon: Inbox, run: () => useUi.getState().setOverlay('capture') });

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
  const onNote = (c: { activePath: string | null }) => c.activePath !== null && isMarkdownViewPath(c.activePath);
  // Mod-E outside the note's text; in the text it is inline code, and in a locked note it unlocks (DESIGN §6.6.1).
  registerCommand({ id: 'editor.toggleMode', name: 'Toggle lock editing', hotkey: 'Mod-e', run: toggleNoteMode, when: onNote });
  registerCommand({ id: 'editor.toggleSource', name: 'Toggle source mode', run: toggleSourceMode, when: onNote });
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
  editorCommand('editor.strikethrough', 'Toggle strikethrough', toggleStrikethrough, 'Mod-Shift-x');
  editorCommand('editor.highlight', 'Toggle highlight', toggleHighlight, 'Mod-Shift-h');
  editorCommand('editor.inlineCode', 'Toggle inline code', toggleInlineCode, 'Mod-e');
  editorCommand('editor.insertLink', 'Insert or remove link', toggleLink, 'Mod-k');
  for (let level = 1; level <= 6; level++) editorCommand(`editor.heading${level}`, `Toggle heading ${level}`, toggleHeading(level));
  editorCommand('editor.headingNone', 'Remove heading', (v) => setHeading(v, 0));
  editorCommand('editor.bulletList', 'Toggle bulleted list', toggleBulletList);
  editorCommand('editor.numberedList', 'Toggle numbered list', toggleNumberedList);
  editorCommand('editor.quote', 'Toggle quote', toggleQuote);
  editorCommand('editor.insertWikilink', 'Insert internal link', insertWikilink);
  editorCommand('editor.insertTable', 'Insert table', insertTable);
  // In a table cell, find searches the note.
  editorCommand('editor.find', 'Find/replace in current note', (v) => openSearchPanel(historyEditor(v)), 'Mod-f');
  // Voice notes (ROADMAP item 33, DESIGN §6.30): recorded into the open note at its cursor.
  registerCommand({
    id: 'voice.record',
    name: 'Record voice note',
    icon: Mic,
    when: hasNote,
    run: (c) => {
      const session = documents.get(c.activePath!);
      if (session) startVoiceNote(session);
    },
  });
  registerCommand({
    id: 'voice.transcribe',
    name: 'Transcribe recording on this line',
    when: hasNote,
    run: async (c) => {
      const session = documents.get(c.activePath!);
      if (session) await transcribeAtCursor(session);
    },
  });
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

  // ---------- bookmarks (ROADMAP item 12) ----------
  const bookmarked = (c: { activePath: string | null }) => c.activePath !== null && isFileBookmarked(currentBookmarks(), c.activePath);
  registerCommand({ id: 'bookmarks.add', name: 'Bookmark current file', icon: BookmarkPlus, when: (c) => hasFile(c) && !bookmarked(c), run: (c) => toggleFileBookmark(c.activePath!) });
  registerCommand({ id: 'bookmarks.remove', name: 'Remove bookmark for current file', icon: Bookmark, when: (c) => hasFile(c) && bookmarked(c), run: (c) => toggleFileBookmark(c.activePath!) });
  registerCommand({
    id: 'bookmarks.heading',
    name: 'Bookmark heading at cursor',
    icon: BookmarkPlus,
    when: (c) => hasNote(c) && activeEditor() !== null,
    run: (c) => {
      const view = activeEditor();
      if (!view || !c.activePath) return;
      const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      const heading = headingsFromState(view.state)
        .filter((h) => h.line <= line)
        .pop();
      if (!heading || !heading.text) {
        toast('Put the cursor in a section with a heading to bookmark it');
        return;
      }
      const subpath = '#' + heading.text;
      if (isFileBookmarked(currentBookmarks(), c.activePath, subpath)) {
        toast(`“${heading.text}” is already bookmarked`);
        return;
      }
      void toggleFileBookmark(c.activePath, subpath);
    },
  });
  registerCommand({
    id: 'bookmarks.search',
    name: 'Bookmark current search',
    icon: BookmarkPlus,
    when: () => useUi.getState().searchQuery.trim() !== '' && findSearchBookmarks(currentBookmarks(), useUi.getState().searchQuery).length === 0,
    run: () => toggleSearchBookmark(useUi.getState().searchQuery),
  });
  registerCommand({
    id: 'editor.renameHeading',
    name: 'Rename heading and update links to it…',
    when: (c) => hasNote(c) && activeEditor() !== null,
    run: (c) => {
      const view = activeEditor();
      if (view && c.activePath) void promptRenameHeading(view, c.activePath);
    },
  });
  registerCommand({ id: 'bookmarks.newGroup', name: 'Create new bookmark group', run: () => promptNewGroup() });

  // ---------- layout ----------
  registerCommand({ id: 'view.toggleLeft', name: 'Toggle left sidebar', run: () => toggleSidebar('left') });
  registerCommand({ id: 'view.toggleRight', name: 'Toggle right sidebar', run: () => toggleSidebar('right') });
  registerCommand({ id: 'view.files', name: 'Show files', run: () => showPanel('left', 'files') });
  registerCommand({ id: 'view.search', name: 'Show search', run: () => showPanel('left', 'search') });
  registerCommand({ id: 'view.tags', name: 'Show tags', run: () => showPanel('left', 'tags') });
  registerCommand({ id: 'view.bookmarks', name: 'Show bookmarks', icon: Bookmark, run: () => showPanel('left', 'bookmarks') });
  registerCommand({ id: 'view.recent', name: 'Show recent files', icon: Clock, run: () => showPanel('left', 'recent') });
  registerCommand({ id: 'view.backlinks', name: 'Show backlinks', run: () => showPanel('right', 'backlinks') });
  registerCommand({ id: 'view.outline', name: 'Show outline', run: () => showPanel('right', 'outline') });
  registerCommand({ id: 'view.history', name: 'Show file history', run: () => showPanel('right', 'history') });
  registerCommand({ id: 'view.localGraph', name: 'Open local graph', icon: Waypoints, run: () => showPanel('right', 'graph') });

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
  registerCommand({ id: 'mirror.push', name: 'Push history to the mirror now', icon: CloudUpload, when: () => mirrorConfigured(), run: pushMirrorNow });
  registerCommand({ id: 'nav.back', name: 'Navigate back', hotkey: 'Mod-Alt-ArrowLeft', run: () => window.history.back() });
  registerCommand({ id: 'nav.forward', name: 'Navigate forward', hotkey: 'Mod-Alt-ArrowRight', run: () => window.history.forward() });
  registerCommand({ id: 'trash.open', name: 'Open trash', icon: Trash, run: () => goTo('/trash') });
  // The server at a glance (ROADMAP item 38, DESIGN §6.18.1): /x/status, a ribbon and drawer entry, and "Open Status".
  registerPage({ route: 'status', title: 'Status', icon: Activity, load: () => import('../components/pages/StatusPage') });
  // ROADMAP item 16 (DESIGN §6.28): /x/graph, the graph of every note, and "Open Graph".
  registerPage({ route: 'graph', title: 'Graph', icon: GitFork, load: () => import('../components/pages/GraphPage') });
  // ROADMAP item 24 (DESIGN §6.29): /x/compat, how an imported Obsidian vault works here.
  registerPage({ route: 'compat', title: 'Compatibility report', icon: FileCheck, load: () => import('../components/pages/CompatPage') });
  // Flashcards and spaced repetition (ROADMAP item 34, DESIGN §6.34).
  registerFlashcards();
  // The habit tracker (ROADMAP item 35, DESIGN §6.35).
  registerHabits();
  // Ask your vault and summaries, powered by Claude (ROADMAP item 18, DESIGN §6.31).
  registerAi();
  // The calendar: daily notes and tasks by day (ROADMAP item 14, DESIGN §6.32).
  registerCalendar();
  // Reminders and push notifications (ROADMAP items 9 and 4c, DESIGN §6.38).
  registerReminders();
  registerPublish();
  registerCommand({ id: 'settings.open', name: 'Open settings', hotkey: 'Mod-,', icon: SettingsIcon, run: () => goTo('/settings') });
  registerCommand({ id: 'theme.toggle', name: 'Toggle dark/light theme', run: toggleTheme });

  // ---------- roadmap features, through the same extension points ----------
  registerTasks();
}
