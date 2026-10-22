// Editor niceties of ROADMAP item 31 (DESIGN §6.6.2): list renumbering, wrapping a selection in
// markup, heading folds.
import { indentLess, indentMore } from '@codemirror/commands';
import { foldedRanges } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyEditors, marked, noteEditor, parsed, press, typeText } from '../test/noteEditor';
import { foldAllHeadings, foldHeading, unfoldAllHeadings, unfoldHeading } from './headingFold';
import { listRun, renumberList } from './listRenumber';

afterEach(destroyEditors);

function folds(view: EditorView): string[] {
  const out: string[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    out.push(view.state.sliceDoc(from, to));
  });
  return out;
}

describe('numbered lists', () => {
  it('finds a list with nested items and loose blank lines', () => {
    const view = noteEditor('Intro\n1. a\n   - child\n\n2. b\n3. c\nAfter', { mode: 'source' });
    expect(listRun(view.state.doc, 5)?.map((i) => i.value)).toEqual([1, 2, 3]);
    expect(listRun(view.state.doc, 1)).toBeNull();
  });

  it('renumbers after a moved line, keeping where the list starts', () => {
    const view = noteEditor('1. a‸\n2. b\n3. c', { mode: 'source' });
    press(view, 'ArrowDown', { altKey: true });
    expect(view.state.doc.toString()).toBe('1. b\n2. a\n3. c');
    press(view, 'ArrowDown', { altKey: true });
    expect(view.state.doc.toString()).toBe('1. b\n2. c\n3. a');
  });

  it('renumbers after a deleted item, in the same undo step', () => {
    const view = noteEditor('1. a\n2. b\n3. c\n4. d', { mode: 'source' });
    const line = view.state.doc.line(2);
    view.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: 'delete.cut' });
    expect(view.state.doc.toString()).toBe('1. a\n2. c\n3. d');
  });

  it('keeps the start number when the first item goes', () => {
    const view = noteEditor('5. a\n6. b\n7. c', { mode: 'source' });
    view.dispatch({ changes: { from: 0, to: 5 }, userEvent: 'delete.cut' });
    expect(view.state.doc.toString()).toBe('5. b\n6. c');
  });

  it('starts a list indented out of another at 1, and closes the gap', () => {
    const view = noteEditor('1. a\n2. b\n3. ‸c\n4. d', { mode: 'source' });
    indentMore(view);
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n  1. c\n3. d');
    indentLess(view);
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. c\n4. d');
  });

  it('leaves numbers being typed alone', () => {
    const view = noteEditor('1. a\n2. b\n‸', { mode: 'source' });
    typeText(view, '7. c');
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n7. c');
  });

  it('leaves code blocks alone', () => {
    const view = noteEditor('```\n1. a\n2. b\n3. c\n```', { mode: 'source' });
    const line = view.state.doc.line(2);
    view.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: 'delete.cut' });
    expect(view.state.doc.toString()).toBe('```\n2. b\n3. c\n```');
  });

  it('"Renumber list" fixes the list at the cursor', () => {
    const view = noteEditor('3. a\n9. b‸\n1. c\n\nText', { mode: 'source' });
    renumberList(view);
    expect(view.state.doc.toString()).toBe('3. a\n4. b\n5. c\n\nText');
  });
});

describe('typing markup over a selection', () => {
  it('wraps the selection and keeps it selected, so a second key makes bold', () => {
    const view = noteEditor('a «word» b', { mode: 'source' });
    typeText(view, '*');
    expect(marked(view)).toBe('a *«word»* b');
    typeText(view, '*');
    expect(marked(view)).toBe('a **«word»** b');
  });

  it('wraps with each formatting character, in Live Preview too', () => {
    for (const ch of ['_', '~', '=', '`', '$']) {
      const view = noteEditor('«x»');
      typeText(view, ch);
      expect(view.state.doc.toString()).toBe(`${ch}x${ch}`);
    }
  });

  it('types the character without a selection, across lines and in code', () => {
    let view = noteEditor('a‸', { mode: 'source' });
    typeText(view, '*');
    expect(view.state.doc.toString()).toBe('a*');
    view = noteEditor('«a\nb»', { mode: 'source' });
    typeText(view, '*');
    expect(view.state.doc.toString()).toBe('*');
    view = noteEditor('```\n«code»\n```', { mode: 'source' });
    typeText(view, '*');
    expect(view.state.doc.toString()).toBe('```\n*\n```');
  });
});

describe('heading folds', () => {
  const doc = '# One\ntext\n## Two‸\nmore\n# Three\nend';

  it('folds and unfolds the section of the heading at the cursor', () => {
    const view = noteEditor(doc, { mode: 'source' });
    expect(foldHeading(view)).toBe(true);
    expect(folds(view)).toEqual(['\nmore']);
    expect(unfoldHeading(view)).toBe(true);
    expect(folds(view)).toEqual([]);
  });

  it('folds the section a cursor in its text belongs to, moving the cursor to the heading', () => {
    const view = noteEditor('# One\ntext‸\n# Two', { mode: 'source' });
    foldHeading(view);
    expect(folds(view)).toEqual(['\ntext']);
    expect(view.state.selection.main.head).toBe(5);
  });

  it('folds all headings and unfolds them all', () => {
    const view = noteEditor(doc, { mode: 'source' });
    parsed(view);
    foldAllHeadings(view);
    // Nested sections fold too, so they stay folded when the outer one opens.
    expect(folds(view).sort()).toEqual(['\nend', '\nmore', '\ntext\n## Two\nmore']);
    unfoldAllHeadings(view);
    expect(folds(view)).toEqual([]);
  });

  it('marks foldable headings for their chevron, also in a locked note', () => {
    const view = noteEditor(doc, { mode: 'locked' });
    expect(view.contentDOM.querySelectorAll('.cm-fold-heading').length).toBe(3);
    view.dispatch({ selection: EditorSelection.cursor(0) });
    foldHeading(view);
    expect(view.contentDOM.querySelectorAll('.cm-fold-heading.is-folded').length).toBe(1);
  });
});
