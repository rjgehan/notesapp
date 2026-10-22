// What the palette, the ⋯ menus and the panel's quick actions ask (ROADMAP item 18): summaries of
// the open note, its folder, the editor's selection and this week's daily notes, and suggestions
// for the open note. Every one opens the conversation view first, so the answer is seen streaming.
import { currentSettings, currentTree } from '../../api/hooks';
import type { DailyNotesSettings } from '../../api/types';
import { findFileIgnoreCase, type VaultTree } from '../../api/vaultTree';
import { currentBreakpoint } from '../../components/layout/useBreakpoint';
import { showPanel } from '../../components/layout/showPanel';
import { activeEditor } from '../../editor/activeEditor';
import { dailyNotePath } from '../daily';
import { stripSections } from '../encryption/meld';
import { dayjs, type Dayjs } from '../dates';
import { navigateTo } from '../navigation';
import { folderOf, isNotePath } from '../paths';
import { useUi } from '../../state/ui';
import { summarize } from './run';
import { appPathname } from '../../state/vault';

export const AI_PAGE_ROUTE = '/x/ask';

/** The side panel on desktops and tablets; the full page on phones, where the sheet is small. */
export function openAiView(): void {
  if (currentBreakpoint() === 'phone') {
    useUi.getState().setDrawerOpen(false);
    useUi.getState().setSheetOpen(false);
    if (appPathname() !== AI_PAGE_ROUTE) navigateTo(AI_PAGE_ROUTE);
    return;
  }
  if (appPathname() === AI_PAGE_ROUTE) return;
  showPanel('right', 'ai');
}

export function aiEnabled(): boolean {
  return currentSettings().ai?.enabled === true;
}

export function canSummarizeNote(path: string | null): path is string {
  return path !== null && isNotePath(path) && currentTree().byPath.has(path);
}

export function summarizeNote(path: string): void {
  openAiView();
  summarize({ scope: 'note', path }, `Summarize [[${linkOf(path)}]]`);
}

export function suggestForNote(path: string): void {
  openAiView();
  summarize({ action: 'suggest', scope: 'note', path }, `Suggest links, tags and tasks for [[${linkOf(path)}]]`);
}

export function summarizeFolder(folder: string): void {
  openAiView();
  summarize({ scope: 'folder', path: folder }, `Summarize the folder “${folder}”`);
}

/** The editor's selected text (all ranges), or '' when nothing is selected. */
export function selectedText(): string {
  const view = activeEditor();
  if (!view) return '';
  // Encrypted sections become `[encrypted]`: their ciphertext never leaves for Claude (the server strips it too).
  return stripSections(
    view.state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => view.state.sliceDoc(r.from, r.to))
      .join('\n\n'),
  );
}

export function summarizeSelection(path: string | null): boolean {
  const text = selectedText();
  if (!text.trim()) return false;
  openAiView();
  const first = text.replace(/\s+/g, ' ').trim();
  const preview = first.length > 80 ? first.slice(0, 79) + '…' : first;
  summarize({ scope: 'selection', path, text }, `Summarize the selection “${preview}”${path ? ` from [[${linkOf(path)}]]` : ''}`);
  return true;
}

/** Monday to Sunday of the week of `now`, as dates. */
export function weekDays(now: Dayjs): Dayjs[] {
  const monday = now.startOf('day').subtract((now.day() + 6) % 7, 'day');
  return Array.from({ length: 7 }, (_, i) => monday.add(i, 'day'));
}

/** The daily notes of this week that exist, oldest first. */
export function weekDailyNotes(tree: VaultTree, settings: Pick<DailyNotesSettings, 'format' | 'folder'>, now: Dayjs): string[] {
  const paths: string[] = [];
  for (const day of weekDays(now)) {
    const entry = findFileIgnoreCase(tree, dailyNotePath(settings, day));
    if (entry) paths.push(entry.path);
  }
  return paths;
}

/** Returns false when this week has no daily note yet. */
export function summarizeWeek(now: Dayjs = dayjs()): boolean {
  const paths = weekDailyNotes(currentTree(), currentSettings().dailyNotes, now);
  if (paths.length === 0) return false;
  const days = weekDays(now);
  const label = `this week's daily notes, ${days[0].format('ddd D MMM')} to ${days[6].format('ddd D MMM YYYY')}`;
  openAiView();
  summarize({ scope: 'notes', paths, label }, `Summarize ${label}`);
  return true;
}

export function folderOfNote(path: string | null): string | null {
  if (!path) return null;
  const folder = folderOf(path);
  return folder === '' ? null : folder;
}

/** The wikilink target of a path, as the server cites notes: without `.md`. */
export function linkOf(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

