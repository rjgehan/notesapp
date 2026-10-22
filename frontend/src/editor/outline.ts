// Headings of an open note from its live Lezer tree (DESIGN §6.6): the Outline panel, `[[#`
// completion and heading targets (`#Heading` routes, `[[Note#Heading]]`).
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { OutlineHeading } from './headingKeys';

export { findHeading, headingKey, type OutlineHeading } from './headingKeys';

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
