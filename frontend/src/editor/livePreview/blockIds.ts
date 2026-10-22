// Block ids in Live Preview (ROADMAP item 20, DESIGN §6.6.1): the ` ^id` that closes a line, or a
// line that holds nothing but `^id`, is hidden in Live Preview and locked notes, as Obsidian hides
// it; the id is the link target of `[[Note#^id]]`, not text to read. While editing, it shows while
// a selection touches it, so it can be changed or deleted. Code, math and the frontmatter keep it.
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { LINE_BLOCK_ID } from '../../features/blocks';

const hidden = Decoration.replace({});

/** Nodes whose text keeps a `^id` as typed. */
const LITERAL = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'BlockMath', 'InlineMath', 'Frontmatter', 'CommentBlock', 'Comment']);

function literalAt(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (LITERAL.has(node.name)) return true;
  }
  return false;
}

function build(view: EditorView, locked: boolean): DecorationSet {
  const { state } = view;
  const reveal = !locked && !state.readOnly;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      const m = line.text.includes('^') ? LINE_BLOCK_ID.exec(line.text) : null;
      if (m) {
        // From the space before the caret (kept on a line of its own) to the line's end.
        const caret = m.index + m[0].indexOf('^');
        const start = line.from + (caret > 0 ? m.index : caret);
        const end = line.to;
        const touched = reveal && state.selection.ranges.some((r) => r.from <= end && r.to >= start);
        if (!touched && !literalAt(state, line.from + caret)) ranges.push(hidden.range(start, end));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/** Hides block ids (` ^id`) in Live Preview; `locked` never shows them. */
export function hiddenBlockIds(locked: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, locked);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = build(update.view, locked);
        }
      }
    },
    { decorations: (p) => p.decorations },
  );
}
