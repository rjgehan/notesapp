// What the editor extensions need from the app, provided through a facet so the extensions stay
// testable and never import React or global singletons directly.
import { Facet, StateEffect } from '@codemirror/state';
import type { NoteMeta, Settings } from '../api/types';
import type { NoteBlock } from '../features/blocks';
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
  /** Mod-E. */
  toggleMode(): void;
  /** Uploads files as attachments of this note and inserts their embeds at `range`. */
  insertFiles(files: File[], range: { from: number; to: number }, pasted: boolean): void;
  /** A link to a vault path as this note would write it (internal explorer drags). */
  linkTo(path: string): string;
  /**
   * `[[Note#^` completion (ROADMAP item 20): the current text of another note, and the id of one
   * of its blocks (read from `text`), added under `wanted` (or another free id) when it has none.
   * A failure is reported to the user by the implementation. Absent where blocks of other notes
   * are not offered.
   */
  blocks?: {
    noteText(path: string): Promise<string>;
    ensureBlockId(path: string, text: string, block: NoteBlock, wanted: string): Promise<string>;
  };
}

export const noteContext = Facet.define<NoteContext, NoteContext | null>({
  combine: (values) => values[0] ?? null,
});

/** Dispatched when the vault tree changes, so link decorations re-resolve. */
export const vaultChanged = StateEffect.define<null>();
