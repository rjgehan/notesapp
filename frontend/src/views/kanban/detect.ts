// Which notes are Kanban boards, and which of them this tab shows as Markdown (ROADMAP item 15,
// DESIGN §6.8.4). In the main bundle: the Markdown view asks it for every note; the board, its
// format and its editor are a lazy chunk.
import { useSyncExternalStore } from 'react';

export const FRONTMATTER = /^\uFEFF?---[ \t]*\n([\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;

/** True when the note's frontmatter has a `kanban-plugin` property (the Obsidian plugin's own test). */
export function isKanbanText(text: string): boolean {
  const fm = FRONTMATTER.exec(text);
  return !!fm && /^kanban-plugin[ \t]*:/m.test(fm[1] ?? '');
}

/** How much of a note's start is read to find its frontmatter. */
export const KANBAN_PROBE_CHARS = 16384;

// Boards shown as Markdown in this tab, by path (as in Obsidian, a board opens as a board).
const asMarkdown = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function showsKanbanAsMarkdown(path: string): boolean {
  return asMarkdown.has(path);
}

export function setKanbanAsMarkdown(path: string, markdown: boolean): void {
  if (markdown === asMarkdown.has(path)) return;
  if (markdown) asMarkdown.add(path);
  else asMarkdown.delete(path);
  version++;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useKanbanAsMarkdown(path: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return asMarkdown.has(path);
}
