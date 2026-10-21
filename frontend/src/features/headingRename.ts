// Updating [[Note#Heading]] links after a heading is renamed (ROADMAP item 21, DESIGN §6.24).
// The editor notices a heading whose text changed and, when links (or bookmarks) point at the old
// text, offers to update them; "Rename heading…" in the palette does the same on purpose. Either
// way the note is saved first, then the server rewrites the links (API.md §22).
import type { EditorView } from '@codemirror/view';
import { api } from '../api/endpoints';
import type { HeadingRenameResult } from '../api/types';
import { headingKey, headingsFromState, type OutlineHeading } from '../editor/outline';
import { promptText } from '../state/dialogs';
import { toast } from '../state/toasts';
import { applyHeadingRenameResult } from '../sync/applyEvents';
import { documents } from '../sync/instance';
import { syncTarget } from '../sync/liveSync';
import { toastError } from './errors';
import { failedReason, updatedFilesText } from './fileOps';
import { displayName } from './paths';

export interface HeadingRename {
  /** Position of the heading in the outline. */
  index: number;
  from: string;
  to: string;
}

/**
 * The rename between two outlines of a note: the same number of headings at the same levels, and
 * exactly one whose text changed beyond case and spacing (which heading targets ignore). Anything
 * else (a heading added, removed, or several edited) is not a rename.
 */
export function detectHeadingRename(before: readonly OutlineHeading[], after: readonly OutlineHeading[]): HeadingRename | null {
  if (before.length !== after.length) return null;
  let found: HeadingRename | null = null;
  for (let i = 0; i < before.length; i++) {
    if (before[i].level !== after[i].level) return null;
    if (headingKey(before[i].text) === headingKey(after[i].text)) continue;
    if (found) return null;
    found = { index: i, from: before[i].text, to: after[i].text };
  }
  if (!found || found.from.trim() === '' || found.to.trim() === '') return null;
  return found;
}

/** "3 links in 2 notes and 1 bookmark" ("files" once a task list is among them), from a (dry-run) result. */
export function describeUpdates(r: Pick<HeadingRenameResult, 'linkUpdates' | 'bookmarks'>): string {
  const links = r.linkUpdates.reduce((n, u) => n + u.links, 0);
  const parts: string[] = [];
  if (links > 0) parts.push(`${links} ${links === 1 ? 'link' : 'links'} in ${updatedFilesText(r.linkUpdates)}`);
  if (r.bookmarks > 0) parts.push(`${r.bookmarks} ${r.bookmarks === 1 ? 'bookmark' : 'bookmarks'}`);
  return parts.join(' and ');
}

export interface HeadingRenameDeps {
  /** Saves the note now, so the server sees the new heading. */
  flush(): Promise<void>;
  /** Applies the server's result to this tab's caches and open notes. */
  apply(result: HeadingRenameResult): void;
}

/** The page's wiring: the live sync target applies results like a move's link updates. */
function pageDeps(path: string): HeadingRenameDeps {
  return {
    flush: async () => {
      await documents.get(path)?.flush();
    },
    apply: (result) => applyHeadingRenameResult(syncTarget, result),
  };
}

/** Rewrites the links to `from` in `path` to `to` (after saving the note); reports the outcome. */
export async function updateHeadingLinks(path: string, from: string, to: string, deps?: HeadingRenameDeps): Promise<HeadingRenameResult | null> {
  try {
    const d = deps ?? pageDeps(path);
    await d.flush();
    const result = await api.renameHeading({ path, from, to });
    d.apply(result);
    const what = describeUpdates(result);
    toast(what ? `Updated ${what} to “${to}”` : `No links pointed at “${from}”`, { kind: what ? 'success' : 'info' });
    // As for a move: each file with the reason (a drawing or a task list is named as such).
    if (result.failed.length > 0) toast(`Links could not be updated in ${result.failed.map((f) => `${displayName(f.path)} (${failedReason(f)})`).join(', ')}`, { kind: 'error', timeout: 8000 });
    return result;
  } catch (e) {
    toastError(e, 'Heading links');
    return null;
  }
}

/**
 * Asks the server what renaming `from` to `to` would update (after saving the note); null when
 * nothing points at the old heading or the server refuses (the note still has the old heading).
 */
export async function previewHeadingRename(path: string, from: string, to: string, deps?: Pick<HeadingRenameDeps, 'flush'>): Promise<HeadingRenameResult | null> {
  try {
    await (deps ?? pageDeps(path)).flush();
    const preview = await api.renameHeading({ path, from, to, dryRun: true });
    return preview.linkUpdates.length > 0 || preview.bookmarks > 0 ? preview : null;
  } catch {
    return null;
  }
}

const ATX = /^(\s{0,3}#{1,6}[ \t]+)(.*?)([ \t]+#+[ \t]*)?$/;

/** The heading at the cursor, or the nearest one above it. */
export function headingAtCursor(view: EditorView): OutlineHeading | null {
  const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  return headingsFromState(view.state).filter((h) => h.line <= line).pop() ?? null;
}

/** Replaces a heading's text in the editor, keeping its `#` marks (one undoable edit). */
export function replaceHeadingText(view: EditorView, heading: OutlineHeading, text: string): boolean {
  const line = view.state.doc.line(heading.line + 1);
  const m = ATX.exec(line.text);
  if (m) {
    const from = line.from + m[1].length;
    view.dispatch({ changes: { from, to: from + m[2].length, insert: text } });
    return true;
  }
  // A setext heading: the line above its underline is the text.
  if (line.text.trim() !== '') {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: text } });
    return true;
  }
  return false;
}

/** "Rename heading…": asks for the new text, edits the heading, then updates the links to it. */
export async function promptRenameHeading(view: EditorView, path: string): Promise<void> {
  const heading = headingAtCursor(view);
  if (!heading || heading.text === '') {
    toast('Put the cursor in a section with a heading to rename it');
    return;
  }
  const to = await promptText({
    title: 'Rename heading',
    label: 'New heading (links to it are updated)',
    value: heading.text,
    confirmLabel: 'Rename',
    validate: (v) => (/[\r\n]/.test(v) ? 'A heading is one line' : null),
  });
  if (to === null || headingKey(to) === headingKey(heading.text) || to.trim() === '') return;
  if (!replaceHeadingText(view, heading, to.trim())) return;
  await updateHeadingLinks(path, heading.text, to.trim());
}
