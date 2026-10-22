// `[[` completion in property fields (ROADMAP item 13): a field whose text before the caret has an
// unclosed `[[` is offered the vault's notes; picking one writes a wikilink, which Obsidian always
// uses in properties (the value is quoted in the YAML, so `[[` is never read as a list).
import { currentSettings, currentTree } from '../api/hooks';
import type { FileEntry } from '../api/types';
import { fuzzyRank } from '../features/fuzzy';
import { assembleLink, linkText } from '../features/links';

export interface Suggestion {
  /** What the list shows. */
  label: string;
  /** A second, fainter line (a note's folder). */
  detail?: string;
  /** The field's text and caret after picking it. */
  apply(text: string, caret: number): { text: string; caret: number };
  /** Picking it also commits the field (a value chosen for a list). */
  commit?: boolean;
}

/** A wikilink to `path` as the note `source` writes it (the configured link format, always `[[…]]`). */
export function wikiLinkTo(path: string, source: string): string {
  const tree = currentTree();
  const text = linkText(path, source, currentSettings().files.newLinkFormat, 'wiki', tree.links);
  return assembleLink(text, 'wiki', path, {});
}

/** Where an unclosed `[[` before the caret starts, and the text typed after it; null when there is none. */
export function openLinkAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start < 0 || before.indexOf(']]', start) >= 0) return null;
  const query = before.slice(start + 2);
  if (/[\]|\n]/.test(query)) return null;
  return { start, query };
}

/** Notes to link from the `[[` at the caret, best first. */
export function linkSuggestions(text: string, caret: number, source: string, limit = 8): Suggestion[] {
  const open = openLinkAt(text, caret);
  if (!open) return [];
  const notes = currentTree().notes;
  const ranked: FileEntry[] =
    open.query.trim() === ''
      ? notes.slice(0, limit)
      : fuzzyRank(open.query, notes, [(n) => n.basename, (n) => n.path], limit).map((r) => r.item);
  // An already typed `]]` right after the caret is replaced, not doubled.
  const closeAfter = text.startsWith(']]', caret) ? 2 : 0;
  return ranked.map((note) => ({
    label: note.basename,
    detail: note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : undefined,
    apply: (t, c) => {
      const link = wikiLinkTo(note.path, source);
      const next = t.slice(0, open.start) + link + t.slice(c + closeAfter);
      return { text: next, caret: open.start + link.length };
    },
  }));
}

/** Suggestions from fixed strings that contain the typed text (case-insensitive), the typed text itself left out. */
export function stringSuggestions(options: readonly string[], typed: string, limit = 8, commit = false): Suggestion[] {
  const q = typed.trim().toLowerCase();
  const out: Suggestion[] = [];
  for (const option of options) {
    if (out.length >= limit) break;
    const lower = option.toLowerCase();
    if (lower === q || (q !== '' && !lower.includes(q))) continue;
    out.push({ label: option, commit, apply: () => ({ text: option, caret: option.length }) });
  }
  return out;
}
