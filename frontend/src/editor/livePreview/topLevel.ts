// The note's top-level blocks that Live Preview shows as block widgets (ROADMAP 10b, 10c): tables
// (grids), comment blocks, and the rich blocks (callouts, `$$` math, Mermaid; ROADMAP item 3; script
// and Dataview blocks, items 40 and 17). One
// walk over the top level of the Lezer tree per tree, shared by
// the state fields that need them, with a cursor (no node objects), so a keystroke in a
// 10,000-line note costs little here.
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';

export interface TopLevelBlock {
  /** The node's range. */
  from: number;
  to: number;
  /**
   * Whether the parse is past the block: another top-level block follows it. Only the last block
   * the parse reached can be cut short by an unfinished parse (`parsedPast` decides for it).
   */
  complete: boolean;
  /** A comment block whose `%%` is closed. */
  closed?: boolean;
  /** A rich block's kind. */
  rich?: RichKind;
}

/** `script` and `dataview` are fenced blocks the app runs (ROADMAP items 40 and 17, DESIGN §6.42). */
export type RichKind = 'callout' | 'math' | 'mermaid' | 'script' | 'dataview';

/** A blockquote whose first line is a callout header (`> [!type]`, with an optional `|metadata`, fold and title). */
const CALLOUT_START = /^[ \t]*>[ \t]?\[![^\]|\s]+(?:\|[^\]]*)?\][+-]?(?:[ \t]|$)/;

export interface TopLevel {
  tables: readonly TopLevelBlock[];
  comments: readonly TopLevelBlock[];
  /** Callouts, `$$` math blocks and Mermaid code blocks. */
  rich: readonly TopLevelBlock[];
  /** Where the last top-level block the parse reached starts: before it, the parse is final. */
  lastFrom: number;
}

const cache = new WeakMap<Tree, TopLevel>();

/** The tables, comment blocks and rich blocks at the top level of the note (not in quotes or lists), as far as it is parsed. */
export function topLevel(state: EditorState): TopLevel {
  const tree = syntaxTree(state);
  let found = cache.get(tree);
  if (found) return found;
  const tables: TopLevelBlock[] = [];
  const comments: TopLevelBlock[] = [];
  const rich: TopLevelBlock[] = [];
  // The Markdown body: the frontmatter's sibling, or the top node itself.
  const cursor = tree.cursor();
  if (cursor.firstChild()) {
    while (cursor.name !== 'Document' && cursor.nextSibling());
    if (cursor.name !== 'Document') cursor.parent();
  }
  let last: TopLevelBlock | null = null;
  let lastFrom = 0;
  if (cursor.firstChild()) {
    do {
      lastFrom = cursor.from;
      if (last) last.complete = true;
      last = null;
      if (cursor.name === 'Table') {
        last = { from: cursor.from, to: cursor.to, complete: false };
        tables.push(last);
      } else if (cursor.name === 'CommentBlock' && state.doc.sliceString(cursor.from, cursor.from + 4) !== '%%🔐') {
        // (A line that is an encrypted section, ROADMAP item 27, is not a comment block: its chip shows.)
        last = { from: cursor.from, to: cursor.to, complete: false, closed: cursor.node.getChildren('CommentMark').length >= 2 };
        comments.push(last);
      } else {
        const kind = richKind(state, cursor.name, cursor.from, cursor.to, () => cursor.node.getChild('CodeInfo'));
        if (kind) {
          last = { from: cursor.from, to: cursor.to, complete: false, rich: kind };
          rich.push(last);
        }
      }
    } while (cursor.nextSibling());
  }
  found = { tables, comments, rich, lastFrom };
  cache.set(tree, found);
  return found;
}

function richKind(state: EditorState, name: string, from: number, to: number, info: () => { from: number; to: number } | null): RichKind | null {
  if (name === 'BlockMath') return 'math';
  if (name === 'Blockquote') return CALLOUT_START.test(state.doc.lineAt(from).text) ? 'callout' : null;
  if (name === 'FencedCode') {
    const node = info();
    // Only an info string of these words' lengths is read: a keystroke reads no other code block again (10c).
    if (!node || node.to > to || node.to - node.from < 6 || node.to - node.from > 8) return null;
    const word = state.doc.sliceString(node.from, node.to).toLowerCase();
    return word === 'mermaid' || word === 'script' || word === 'dataview' ? word : null;
  }
  return null;
}

/** Whether the parse has reached past `to` (the end of a block's last line): its next line, so the block is not cut short. */
export function parsedPast(state: EditorState, to: number): boolean {
  return to >= state.doc.length || syntaxTreeAvailable(state, state.doc.lineAt(to + 1).to);
}

/** A block's lines, `from` the start of its first and `to` the end of its last, when it is whole. */
export function wholeLines(state: EditorState, block: TopLevelBlock): { from: number; to: number } | null {
  const to = state.doc.lineAt(block.to).to;
  if (!block.complete && !parsedPast(state, to)) return null;
  return { from: state.doc.lineAt(block.from).from, to };
}
