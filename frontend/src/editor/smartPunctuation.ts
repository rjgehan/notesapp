// iOS Smart Punctuation guard (DESIGN §6.6 #12). Inside frontmatter, fenced or inline code, and
// for `--`/`---` at the start of a line, typed em dashes and curly quotes are reverted, so iOS
// cannot silently break frontmatter delimiters, YAML strings or `"[[Link]]"` property values.
import { EditorState, Transaction, type ChangeSpec, type Extension } from '@codemirror/state';
import { inCode, inFrontmatter } from './linkAt';

const SMART = /[—“”‘’]/;

function straighten(text: string): string {
  return text.replace(/—/g, '--').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** True when an em dash typed at `from` would start a line (so it is a `--`/`---` delimiter). */
function atLineStart(state: EditorState, from: number): boolean {
  const line = state.doc.lineAt(from);
  return /^[\s-]*$/.test(state.sliceDoc(line.from, from));
}

/** Frontmatter is only recognized at the top; a `---` line typed there may not be parsed yet. */
function inTopBlock(state: EditorState, from: number): boolean {
  if (inFrontmatter(state, from)) return true;
  const firstLine = state.doc.line(1).text.trim();
  if (firstLine !== '---' || from <= state.doc.line(1).to) return false;
  for (let n = 2; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() === '---') return from <= line.from;
    if (line.from > from) return true;
  }
  return true;
}

export const smartPunctuationGuard: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;
  let needed = false;
  const start = tr.startState;
  const specs: ChangeSpec[] = [];
  let delta = 0;
  let cursor: number | null = null;
  tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
    const text = inserted.toString();
    let insert = text;
    if (SMART.test(text)) {
      const guarded =
        inTopBlock(start, fromA) ||
        inCode(start, fromA) ||
        (text.includes('—') && atLineStart(start, fromA));
      if (guarded) {
        insert = straighten(text);
        needed = true;
      }
    }
    specs.push({ from: fromA, to: toA, insert });
    delta += insert.length - text.length;
    cursor = toB + delta;
  });
  if (!needed) return tr;
  const main = tr.newSelection.main;
  return {
    changes: specs,
    selection: main.empty && cursor !== null ? { anchor: cursor } : undefined,
    annotations: [Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? 'input')],
    scrollIntoView: tr.scrollIntoView,
  };
});
