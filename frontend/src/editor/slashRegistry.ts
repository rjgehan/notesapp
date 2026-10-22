// The app's items of the `/` menu (DESIGN §6.6.2), registered at startup. Small and eager: the
// menu itself (slash.ts) is part of the editor's chunk and reads them from here.
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * `block` items change or insert whole lines, so a table cell (where the text is one line of a
 * row) offers only the `inline` ones, which insert text at the cursor.
 */
export type SlashScope = 'block' | 'inline';

export interface SlashItem {
  id: string;
  label: string;
  /** Other words the filter matches (`h1`, `todo`, `hr`). */
  keywords?: string;
  /** Shown on the right of the option, unless `hint` gives something more useful (a date's value). */
  group: string;
  hint?(state: EditorState): string;
  scope: SlashScope;
  /** Order in the unfiltered menu (lower first). */
  order: number;
  /** Hidden when false: an item that needs the open note's session, a command whose `when` fails. */
  when?(view: EditorView): boolean;
  /** Runs at the cursor, where the typed `/query` was (it is removed first). */
  run(view: EditorView): void;
}

const registered = new Map<string, SlashItem>();

/** Adds an item to the `/` menu (the app's commands: templates, attachments, voice notes, …). */
export function registerSlashItem(item: SlashItem): void {
  registered.set(item.id, item);
}

/** The registered items, in registration order. */
export function registeredSlashItems(): Iterable<SlashItem> {
  return registered.values();
}
