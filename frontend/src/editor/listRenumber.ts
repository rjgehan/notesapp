// Numbered lists keep counting (ROADMAP item 31, DESIGN §6.6.2). CodeMirror's Markdown Enter
// renumbers the items after a new one; this does the same after the edits that leave a list out of
// order: deleting, moving or pasting lines, and indenting or outdenting items. Typing never
// renumbers, so a number being typed is left alone. "Renumber list" fixes the list at the cursor.
import { syntaxTree } from '@codemirror/language';
import { EditorState, Transaction, type ChangeSpec, type Extension, type Text } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/** An ordered item: quote markers, indentation, the number and its delimiter, then a space (or the line's end). */
const ITEM = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(\d{1,9})([.)])(?=[ \t]|$)/;
const QUOTE_PREFIX = /^((?:[ \t]*>[ \t]?)*)([ \t]*)/;

interface Item {
  line: number;
  /** Where the number starts and ends in the document. */
  from: number;
  to: number;
  value: number;
  /** The list a line belongs to: its quote depth, indentation and delimiter. */
  key: string;
}

function width(indent: string): number {
  let w = 0;
  for (const ch of indent) w += ch === '\t' ? 4 - (w % 4) : 1;
  return w;
}

function quoteDepth(prefix: string): number {
  return (prefix.match(/>/g) ?? []).length;
}

function itemAt(doc: Text, n: number): Item | null {
  const line = doc.line(n);
  const m = ITEM.exec(line.text);
  if (!m) return null;
  const from = line.from + m[1].length + m[2].length;
  return { line: n, from, to: from + m[3].length, value: Number(m[3]), key: `${quoteDepth(m[1])}|${width(m[2])}|${m[4]}` };
}

/**
 * Whether line `n` can sit between two items of the list `key` (blank, or more indented: an
 * item's continuation, a nested list, code in the item).
 */
function inside(doc: Text, n: number, key: string): boolean {
  const text = doc.line(n).text;
  const [depth, indent] = key.split('|').map(Number);
  const m = QUOTE_PREFIX.exec(text)!;
  if (quoteDepth(m[1]) !== depth) return false;
  if (text.slice(m[0].length).trim() === '') return true;
  return width(m[2]) > indent;
}

/** The items of the list line `n` is an item of, in order, or null. */
export function listRun(doc: Text, n: number): Item[] | null {
  const at = itemAt(doc, n);
  if (!at) return null;
  let first = n;
  for (let k = n - 1; k >= 1; k--) {
    const item = itemAt(doc, k);
    if (item) {
      if (item.key !== at.key) {
        if (inside(doc, k, at.key)) continue;
        break;
      }
      first = k;
    } else if (!inside(doc, k, at.key)) break;
  }
  const items: Item[] = [];
  for (let k = first; k <= doc.lines; k++) {
    const item = itemAt(doc, k);
    if (item && item.key === at.key) items.push(item);
    else if (!inside(doc, k, at.key)) break;
  }
  // Blank lines after the last item belong to no list.
  return items;
}

/** The changes that number `items` from `start` on. */
export function renumberChanges(items: readonly Item[], start: number): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  items.forEach((item, i) => {
    const want = String(start + i);
    if (String(item.value) !== want || item.to - item.from !== want.length) changes.push({ from: item.from, to: item.to, insert: want });
  });
  return changes;
}

const SKIP = new Set(['FencedCode', 'CodeBlock', 'Frontmatter', 'FrontmatterContent', 'HTMLBlock', 'CommentBlock', 'BlockMath']);

function inSkipped(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (SKIP.has(node.name)) return true;
  }
  return false;
}

/** The lists (by first line) of the items on lines `from`..`to` and the lines around them. */
function runsNear(doc: Text, from: number, to: number): Map<number, Item[]> {
  const runs = new Map<number, Item[]>();
  for (let n = Math.max(1, from - 1); n <= Math.min(doc.lines, to + 1); n++) {
    const run = listRun(doc, n);
    if (run && run.length > 0 && !runs.has(run[0].line)) runs.set(run[0].line, run);
  }
  return runs;
}

function renumbers(tr: Transaction): boolean {
  if (tr.annotation(Transaction.remote) || !tr.docChanged) return false;
  if (tr.isUserEvent('input.indent') || tr.isUserEvent('delete.dedent')) return true;
  if (!(tr.isUserEvent('delete') || tr.isUserEvent('move') || tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) return false;
  // Only edits that add or remove line breaks: an item's number being edited is left alone.
  let lines = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.lines > 1 || tr.startState.doc.lineAt(fromA).number !== tr.startState.doc.lineAt(toA).number) lines = true;
  });
  return lines;
}

/**
 * After a deletion, move, paste or indent that touches a numbered list, the list counts on from
 * where it started before the edit (its first item may be the one that went), as one undo step
 * with the edit.
 */
export const listRenumbering: Extension = EditorState.transactionFilter.of((tr) => {
  if (!renumbers(tr)) return tr;
  const before = tr.startState.doc;
  const after = tr.newDoc;
  const indent = tr.isUserEvent('input.indent') || tr.isUserEvent('delete.dedent');
  const changes: ChangeSpec[] = [];
  const done = new Set<number>();
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (inSkipped(tr.startState, fromA)) return;
    const startOf = new Map<string, number>();
    for (const run of runsNear(before, before.lineAt(fromA).number, before.lineAt(toA).number).values()) {
      if (!startOf.has(run[0].key)) startOf.set(run[0].key, run[0].value);
    }
    for (const run of runsNear(after, after.lineAt(fromB).number, after.lineAt(toB).number).values()) {
      if (done.has(run[0].line)) continue;
      done.add(run[0].line);
      // An item indented into a list of its own starts it at 1.
      const start = startOf.get(run[0].key) ?? (indent ? 1 : run[0].value);
      changes.push(...renumberChanges(run, start));
    }
  });
  if (changes.length === 0) return tr;
  return [tr, { changes, sequential: true }];
});

/** "Renumber list": the numbered list at the cursor counts from its first item's number. */
export const renumberList: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const run = listRun(state.doc, state.doc.lineAt(state.selection.main.head).number);
  if (!run || run.length === 0) return false;
  const changes = renumberChanges(run, run[0].value);
  if (changes.length > 0) view.dispatch({ changes, userEvent: 'input.format' });
  return true;
};
