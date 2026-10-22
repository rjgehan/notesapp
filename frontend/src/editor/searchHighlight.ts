// Search-hit navigation in the editor (DESIGN §6.4 `?line=N&q=`): the target line flashes and the
// query's terms are highlighted until the user edits the note.
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { findTermRanges, type HighlightTerm } from '../features/searchTerms';
import { isLocalEdit } from './remote';

/** `line` flashes (through `lineEnd`, inclusive, for a block: ROADMAP item 20). */
export const setSearchHighlight = StateEffect.define<{ terms: HighlightTerm[]; line: number | null; lineEnd?: number } | null>();

const termMark = Decoration.mark({ class: 'cm-search-term' });
const flashLine = Decoration.line({ class: 'cm-flash-line' });

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSearchHighlight)) continue;
      if (!e.value) return Decoration.none;
      const { terms, line, lineEnd } = e.value;
      const doc = tr.state.doc;
      const ranges: Range<Decoration>[] = findTermRanges(doc.toString(), terms).map((r) => termMark.range(r.from, r.to));
      if (line !== null && line >= 0) {
        for (let l = line; l <= Math.max(line, lineEnd ?? line) && l < doc.lines; l++) ranges.push(flashLine.range(doc.line(l + 1).from));
      }
      return Decoration.set(ranges, true);
    }
    if (isLocalEdit(tr)) return Decoration.none;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const searchHighlight: Extension = field;
