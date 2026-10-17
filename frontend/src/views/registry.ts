// File-type → view registry (DESIGN §6.8). Re-exported from extensions/.
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { FileEntry } from '../api/types';
import type { Command } from '../features/commands';

export interface FileViewProps {
  path: string;
  entry: FileEntry;
  mode: 'edit' | 'read';
}

export interface EmbedProps {
  path: string;
  entry: FileEntry;
  subpath?: string;
  display?: string;
  sourcePath: string;
  depth: number;
}

export interface FileViewDescriptor {
  /** 'markdown' | 'image' | 'pdf' | 'media' | 'text' | 'unsupported' | later 'sheet', 'excalidraw', ... */
  id: string;
  /** 0 = no match; highest wins. Convention: length of the matched suffix (".excalidraw.md" beats ".md"). */
  match(entry: FileEntry): number;
  icon: LucideIcon;
  /** true → content via DocumentSession over GET/PUT /api/files (versioned, autosave, conflicts, live sync). */
  textual: boolean;
  /** Which toggles the header shows. */
  modes: Array<'edit' | 'read'>;
  load(): Promise<{ default: ComponentType<FileViewProps> }>;
  /** For `![[file]]` in the reading view. */
  loadEmbed?(): Promise<{ default: ComponentType<EmbedProps> }>;
  /** Adds "New <label>" to the explorer menu and palette. */
  create?: { label: string; extension: string; initialContent(): string };
  /** Optional semantic 3-way merge for conflicts (null = fall back to the banner). */
  merge?(base: string, mine: string, theirs: string): string | null;
  /** Contributed to the palette while this view is active. */
  commands?: Command[];
}

const views: FileViewDescriptor[] = [];
const listeners = new Set<() => void>();

export function registerView(d: FileViewDescriptor): void {
  const existing = views.findIndex((v) => v.id === d.id);
  if (existing >= 0) views.splice(existing, 1, d);
  else views.push(d);
  for (const l of listeners) l();
}

/** Never null once the built-ins are registered: 'unsupported' matches everything with 1. */
export function viewFor(entry: FileEntry): FileViewDescriptor {
  let best: FileViewDescriptor | null = null;
  let bestScore = 0;
  for (const v of views) {
    const score = v.match(entry);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  if (!best) throw new Error(`No view registered for ${entry.path}`);
  return best;
}

/**
 * True when the Markdown view shows the note at `path`: false for other files, and for notes
 * another view claims by name (an `.excalidraw.md` drawing), whose text has no outline, word
 * count or insertion point.
 */
export function isMarkdownViewPath(path: string): boolean {
  if (!path.toLowerCase().endsWith('.md')) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const probe: FileEntry = { path, name, basename: name.slice(0, -3), extension: 'md', kind: 'note', size: 0, mtime: '', version: null, aliases: [] };
  try {
    return viewFor(probe).id === 'markdown';
  } catch {
    return true;
  }
}

export function registeredViews(): readonly FileViewDescriptor[] {
  return views;
}

export function onViewsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
