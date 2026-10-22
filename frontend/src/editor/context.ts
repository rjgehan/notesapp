// What the editor extensions need from the app, provided through a facet so the extensions stay
// testable and never import React or global singletons directly.
import { Facet, StateEffect } from '@codemirror/state';
import type { FileEntry, NoteMeta, Settings } from '../api/types';
import type { VaultTree } from '../api/vaultTree';

export interface NoteContext {
  /** The open note's current path (it changes when the note is moved). */
  path(): string;
  tree(): VaultTree;
  settings(): Settings;
  /** Follows a link target as written in this note. */
  openLink(target: string, subpath: string | null): void;
  openTag(tag: string): void;
  noteMeta(path: string): Promise<NoteMeta>;
  /** Every tag in the vault (without `#`). */
  vaultTags(): Promise<string[]>;
  /** Recently opened paths, most recent first. */
  recentPaths(): string[];
  /** Mod-S. */
  save(): void;
  /** Locks or unlocks editing (Mod-E outside the text, or in a locked note). */
  toggleMode(): void;
  /** Uploads files as attachments of this note and inserts their embeds at `range`. */
  insertFiles(files: File[], range: { from: number; to: number }, pasted: boolean): void;
  /** A link to a vault path as this note would write it (internal explorer drags). */
  linkTo(path: string): string;
  /** Shows a context menu at a point of the screen (a table's row, column and cell menus). */
  showMenu(at: { x: number; y: number }, label: string, items: EditorMenuEntry[]): void;
  /**
   * Live Preview (ROADMAP 10b): shows a vault file's embed in `el` as the reading of the note does
   * (an image, audio, video, a PDF, a note one level deep, a file chip). Returns what removes it.
   */
  renderEmbed(el: HTMLElement, embed: EmbedRequest): () => void;
  /**
   * Live Preview (ROADMAP 10b): shows the note's properties (its frontmatter's YAML) in `el`, with an
   * edit button when `onEdit` is given. Returns what removes them.
   */
  renderProperties(el: HTMLElement, yaml: string, onEdit: (() => void) | null): () => void;
}

/** An embed to show: the file, the part of it (`#Heading`, `#page=2`), the display text and the size. */
export interface EmbedRequest {
  entry: FileEntry;
  subpath: string | null;
  display: string | null;
  size: { width: number; height: number | null } | null;
}

export type EditorMenuEntry = { id: string; label: string; danger?: boolean; disabled?: boolean; run(): void } | 'separator';

export const noteContext = Facet.define<NoteContext, NoteContext | null>({
  combine: (values) => values[0] ?? null,
});

/** Dispatched when the vault tree changes, so link decorations re-resolve. */
export const vaultChanged = StateEffect.define<null>();
