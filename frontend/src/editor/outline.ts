// Headings of an open note from its live Lezer tree (DESIGN §6.6): the Outline panel, `[[#`
// completion and heading targets (`#Heading` routes, `[[Note#Heading]]`).
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

export interface OutlineHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** 0-based line number. */
  line: number;
  /** Document offset of the heading line start. */
  from: number;
}

const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** Headings in document order. Parses up to `timeoutMs` when the tree is incomplete. */
export function headingsFromState(state: EditorState, timeoutMs = 50): OutlineHeading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs) ?? syntaxTree(state);
  const out: OutlineHeading[] = [];
  tree.iterate({
    enter(node) {
      const m = HEADING.exec(node.name);
      if (!m) return undefined;
      let text = '';
      let pos = node.from;
      const marks: Array<[number, number]> = [];
      const cursor = node.node.cursor();
      if (cursor.firstChild()) {
        do {
          if (cursor.name === 'HeaderMark') marks.push([cursor.from, cursor.to]);
        } while (cursor.nextSibling());
      }
      for (const [from, to] of marks) {
        text += state.sliceDoc(pos, from);
        pos = to;
      }
      text += state.sliceDoc(pos, node.to);
      const line = state.doc.lineAt(node.from);
      out.push({
        level: Number(m[1]) as OutlineHeading['level'],
        text: text.replace(/\s+/g, ' ').trim(),
        line: line.number - 1,
        from: line.from,
      });
      return false;
    },
  });
  return out;
}

/** Normalizes heading text for target comparison: case-insensitive, whitespace collapsed. */
export function headingKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Finds the heading addressed by a subpath (DESIGN §6.4): the last `#` segment, compared
 * case-insensitively with whitespace collapsed; the first match in document order wins.
 * `^blockid` subpaths address no heading in v1.
 */
export function findHeading<T extends { text: string }>(headings: T[], subpath: string): T | null {
  const last = subpath.split('#').pop() ?? '';
  if (last === '' || last.startsWith('^')) return null;
  const key = headingKey(last);
  return headings.find((h) => headingKey(h.text) === key) ?? null;
}
