// Heading folding (ROADMAP item 31, DESIGN §6.6.2): a heading's section (up to the next heading of
// the same or a higher level, lang-markdown's fold service) folds from a chevron left of the
// heading, or with "Fold heading" (Mod-Shift-[) and "Unfold heading" (Mod-Shift-]). Folds are view
// state only: nothing is written to the note, and they work in a locked note too.
import { codeFolding, ensureSyntaxTree, foldable, foldedRanges, foldEffect, syntaxTree, unfoldAll, unfoldEffect } from '@codemirror/language';
import { RangeSetBuilder, type EditorState, type Extension, type Line } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type Command, type DecorationSet, type ViewUpdate } from '@codemirror/view';

const HEADING = /^#{1,6}(?:[ \t]|$)/;

/** The section a heading line folds, or null (not a heading, or nothing under it). */
export function headingRange(state: EditorState, line: Line): { from: number; to: number } | null {
  if (!HEADING.test(line.text)) return null;
  const range = foldable(state, line.from, line.to);
  return range && range.from === line.to ? range : null;
}

/** The fold that starts at the end of `line`, if any. */
function foldAt(state: EditorState, line: Line): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => {
    if (from === line.to) found = { from, to };
  });
  return found;
}

function toggleAt(view: EditorView, line: Line): boolean {
  const folded = foldAt(view.state, line);
  if (folded) {
    view.dispatch({ effects: unfoldEffect.of(folded) });
    return true;
  }
  const range = headingRange(view.state, line);
  if (!range) return false;
  const { head } = view.state.selection.main;
  const hidden = head > range.from && head <= range.to;
  view.dispatch({ effects: foldEffect.of(range), selection: hidden ? { anchor: line.to } : undefined });
  return true;
}

/** The heading whose section holds the cursor: its own line, or the nearest heading above that covers it. */
function headingAtCursor(state: EditorState): Line | null {
  const head = state.selection.main.head;
  for (let n = state.doc.lineAt(head).number; n >= 1; n--) {
    const line = state.doc.line(n);
    if (!HEADING.test(line.text)) continue;
    const range = headingRange(state, line);
    // The nearest heading above decides: its section holds the cursor, or nothing does.
    return range && (head <= line.to || head <= range.to) ? line : null;
  }
  return null;
}

/** "Fold heading": folds the section the cursor is in. */
export const foldHeading: Command = (view) => {
  const line = headingAtCursor(view.state);
  if (!line || foldAt(view.state, line)) return line !== null;
  return toggleAt(view, line);
};

/** "Unfold heading": unfolds the folds on the cursor's line (a folded heading's line). */
export const unfoldHeading: Command = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const effects: ReturnType<typeof unfoldEffect.of>[] = [];
  foldedRanges(view.state).between(line.from, line.to, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

/** "Fold all headings". */
export const foldAllHeadings: Command = (view) => {
  const state = view.state;
  ensureSyntaxTree(state, state.doc.length, 500);
  const effects: ReturnType<typeof foldEffect.of>[] = [];
  const folded = foldedRanges(state);
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const range = headingRange(state, line);
    if (!range) continue;
    let already = false;
    folded.between(range.from, range.from, (from) => {
      if (from === range.from) already = true;
    });
    if (!already) effects.push(foldEffect.of(range));
  }
  if (effects.length === 0) return false;
  // A cursor folded away goes to the end of the outermost heading that hides it.
  const head = state.selection.main.head;
  const outer = effects.map((e) => e.value).filter((r) => head > r.from && head <= r.to).sort((a, b) => a.from - b.from)[0];
  view.dispatch({ effects, selection: outer ? { anchor: outer.from } : undefined });
  return true;
};

export const unfoldAllHeadings: Command = (view) => unfoldAll(view);

function decorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      if (HEADING.test(line.text) && headingRange(state, line)) {
        builder.add(line.from, line.from, Decoration.line({ class: foldAt(state, line) ? 'cm-fold-heading is-folded' : 'cm-fold-heading' }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function foldsChanged(update: ViewUpdate): boolean {
  return update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
}

/** The chevron is the line's `::before`, in the margin left of the text: a press there toggles. */
function chevronLine(view: EditorView, event: MouseEvent | Touch): Line | null {
  const target = event.target instanceof Element ? event.target.closest('.cm-fold-heading') : null;
  if (!(target instanceof HTMLElement) || !view.contentDOM.contains(target)) return null;
  if (event.clientX >= target.getBoundingClientRect().left) return null;
  return view.state.doc.lineAt(view.posAtDOM(target));
}

const chevrons = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || foldsChanged(update) || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = decorations(update.view);
      }
    }
  },
  {
    decorations: (p) => p.decorations,
    eventHandlers: {
      mousedown(event, view) {
        if (event.button !== 0) return false;
        const line = chevronLine(view, event);
        if (!line) return false;
        event.preventDefault();
        return toggleAt(view, line);
      },
      // On a touch screen a tap on the chevron toggles without placing the caret (no keyboard).
      touchend(event, view) {
        const touch = event.changedTouches[0];
        const line = touch ? chevronLine(view, touch) : null;
        if (!line) return false;
        event.preventDefault();
        return toggleAt(view, line);
      },
    },
  },
);

export function headingFolding(): Extension {
  return [
    codeFolding({
      placeholderDOM: (_view, onclick) => {
        const el = document.createElement('span');
        el.className = 'cm-foldPlaceholder';
        el.textContent = '…';
        el.title = 'Unfold';
        el.setAttribute('aria-label', 'Folded section; click to unfold');
        el.onclick = onclick;
        return el;
      },
    }),
    chevrons,
  ];
}
