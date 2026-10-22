// Typing a formatting character over selected text wraps it (ROADMAP item 31, DESIGN §6.6.2), as
// in Obsidian: `*` makes `*text*` and keeps the text selected, so a second `*` makes it bold. The
// brackets and quotes are closeBrackets' (§6.6 #3), which wraps a selection the same way.
import { EditorSelection, Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { inCode } from './linkAt';

const MARKUP = new Set(['*', '_', '~', '=', '`', '$']);

export const markupPairs: Extension = Prec.high(
  EditorView.inputHandler.of((view, _from, _to, text) => {
    const { state } = view;
    if (!MARKUP.has(text) || state.readOnly || view.composing) return false;
    const ranges = state.selection.ranges;
    // Every range selects text on one line, outside code (where the character is just typed).
    if (ranges.some((r) => r.empty || state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number || inCode(state, r.from + 1))) return false;
    view.dispatch(
      state.changeByRange((r) => ({
        changes: [
          { from: r.from, insert: text },
          { from: r.to, insert: text },
        ],
        range: EditorSelection.range(r.anchor + 1, r.head + 1),
      })),
      { userEvent: 'input.type', scrollIntoView: true },
    );
    return true;
  }),
);
