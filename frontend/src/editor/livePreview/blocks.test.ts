import { undo } from '@codemirror/commands';
import { EditorSelection, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, marked, noteEditor, press, testContext, typeText } from '../../test/noteEditor';
import { noteExtensions } from '../editorSetup';
import { editingProperties, shownBlocks } from './blocks';
import { noteTouchEnd } from './pointer';

afterEach(() => {
  destroyEditors();
  vi.restoreAllMocks();
  noteTouchEnd(-Infinity);
});

const NOTE = '---\ntags: [a]\ntitle: T\n---\nFirst line\n\nText\n%%\nhidden\n%%\nAfter';

/** The blocks shown as widgets, as `kind:text`. */
function blocks(view: EditorView): string[] {
  return shownBlocks(view.state).map((b) => `${b.kind}:${view.state.sliceDoc(b.from, b.to)}`);
}

/** Moves the cursor as the keyboard does (`select`), or as a click does (`select.pointer`). */
function moveTo(view: EditorView, pos: number, userEvent = 'select'): void {
  view.dispatch({ selection: EditorSelection.cursor(pos), userEvent });
}

describe('the properties block (ROADMAP 10b)', () => {
  it('shows the frontmatter as properties in Live Preview and locked, never in source mode', () => {
    for (const mode of ['live', 'locked'] as const) {
      const view = noteEditor(NOTE, { mode });
      expect(blocks(view)[0]).toBe('properties:---\ntags: [a]\ntitle: T\n---');
      expect(view.dom.querySelector('.cm-lp-properties .test-properties')?.textContent).toBe('tags: [a]\ntitle: T\n');
      // Only an editable note has the edit button.
      expect(!!view.dom.querySelector('.test-properties-edit')).toBe(mode === 'live');
    }
    expect(blocks(noteEditor(NOTE, { mode: 'source' }))).toEqual([]);
  });

  it('the edit button shows the YAML, the caret at its end; leaving it shows the block again', () => {
    const view = noteEditor(NOTE);
    view.dom.querySelector<HTMLButtonElement>('.test-properties-edit')!.click();
    expect(editingProperties(view.state)).toBe(true);
    expect(view.dom.querySelector('.cm-lp-properties')).toBeNull();
    expect(marked(view).startsWith('---\ntags: [a]\ntitle: T‸\n---')).toBe(true);
    typeText(view, 'x');
    expect(view.state.doc.toString().startsWith('---\ntags: [a]\ntitle: Tx\n---\nFirst')).toBe(true);
    expect(editingProperties(view.state)).toBe(true);
    moveTo(view, view.state.doc.line(5).from);
    expect(editingProperties(view.state)).toBe(false);
    expect(blocks(view)[0]).toBe('properties:---\ntags: [a]\ntitle: Tx\n---');
  });

  it('ArrowUp (or Left) from the line under the properties goes into them; a jump stops under them', () => {
    const view = noteEditor(NOTE);
    const first = view.state.doc.line(5).from;
    moveTo(view, first + 3);
    // The keyboard lands on the block (CodeMirror steps over atomic ranges to an edge).
    moveTo(view, 0);
    expect(editingProperties(view.state)).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).to);
    moveTo(view, view.state.doc.line(7).from);
    expect(editingProperties(view.state)).toBe(false);
    // Mod-Home from further down: the first line of the text.
    moveTo(view, 0);
    expect(editingProperties(view.state)).toBe(false);
    expect(view.state.selection.main.head).toBe(first);
  });

  it('a click next to the block puts the caret under it', () => {
    const view = noteEditor(NOTE);
    moveTo(view, 3, 'select.pointer');
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
    expect(editingProperties(view.state)).toBe(false);
    // A tap on the phone (a plain `select` just after a touch) too.
    noteTouchEnd();
    moveTo(view, 2);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
  });

  it('typing where the caret should not be puts the text under the properties, never in them', () => {
    const view = noteEditor(`‸${NOTE}`);
    typeText(view, 'Hi ');
    expect(view.state.doc.toString()).toBe('---\ntags: [a]\ntitle: T\n---\nHi First line\n\nText\n%%\nhidden\n%%\nAfter');
    // Enter there does not break the frontmatter either.
    const other = noteEditor(`---\na: 1\n---‸\nBody`);
    press(other, 'Enter');
    expect(other.state.doc.toString()).toBe('---\na: 1\n---\n\nBody');
  });

  it('Backspace at the start of the text under the properties does not join it to them', () => {
    const view = noteEditor('---\na: 1\n---\n‸Body');
    expect(press(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('---\na: 1\n---\nBody');
    // An empty line under them is deleted as usual.
    const empty = noteEditor('---\na: 1\n---\n‸\nBody');
    press(empty, 'Backspace');
    expect(empty.state.doc.toString()).toBe('---\na: 1\n---\nBody');
  });

  it('typing a frontmatter keeps it as text until the caret leaves it', () => {
    const view = noteEditor('‸\nBody');
    typeText(view, '---\na: 1\n---');
    expect(view.state.doc.toString()).toBe('---\na: 1\n---\nBody');
    expect(editingProperties(view.state)).toBe(true);
    expect(blocks(view)).toEqual([]);
    moveTo(view, view.state.doc.length);
    expect(blocks(view)).toEqual(['properties:---\na: 1\n---']);
  });

  it('empty properties get a line to type on, and properties that end the note a line under them', () => {
    const view = noteEditor('---\n---\nBody');
    view.dom.querySelector<HTMLButtonElement>('.test-properties-edit')!.click();
    expect(marked(view)).toBe('---\n‸\n---\nBody');
    const end = noteEditor('---\na: 1\n---');
    // A move past the end of the note.
    moveTo(end, end.state.doc.length);
    expect(marked(end)).toBe('---\na: 1\n---\n‸');
  });

  it('locking the note shows the block again, without the edit button', () => {
    const view = noteEditor(NOTE);
    view.dom.querySelector<HTMLButtonElement>('.test-properties-edit')!.click();
    expect(editingProperties(view.state)).toBe(true);
    // A mode switch reconfigures the note's state (NoteEditor keeps it in the session).
    view.dispatch({ effects: StateEffect.reconfigure.of(noteExtensions(testContext(), { onLocalChange: () => {}, onBlur: () => {}, readOnly: false, spellcheck: false, autocorrect: false, livePreview: { visibility: 'hide-all', locked: true, checkboxes: true } })) });
    expect(editingProperties(view.state)).toBe(false);
    expect(blocks(view)[0]).toBe('properties:---\ntags: [a]\ntitle: T\n---');
    expect(view.dom.querySelector('.test-properties-edit')).toBeNull();
  });
});

describe('hidden comment blocks (ROADMAP 10b)', () => {
  it('a closed comment block hides in hide-all and locked mode, and shows in reveal-at-cursor mode', () => {
    expect(blocks(noteEditor(NOTE)).slice(1)).toEqual(['comment:%%\nhidden\n%%']);
    expect(blocks(noteEditor(NOTE, { mode: 'locked' })).slice(1)).toEqual(['comment:%%\nhidden\n%%']);
    expect(blocks(noteEditor(NOTE, { config: { visibility: 'reveal-at-cursor' } })).slice(1)).toEqual([]);
    expect(noteEditor(NOTE).dom.querySelector('.cm-lp-hidden-comment')).not.toBeNull();
  });

  it('an unclosed comment shows while you write (it would hide the rest of the note), and hides when locked', () => {
    expect(blocks(noteEditor('a\n\n%%\nrest of the note'))).toEqual([]);
    expect(blocks(noteEditor('a\n\n%%\nrest of the note', { mode: 'locked' }))).toEqual(['comment:%%\nrest of the note']);
  });

  it('the caret goes past a hidden comment, the way it was heading', () => {
    const view = noteEditor(NOTE);
    const text = view.state.doc.line(7);
    const after = view.state.doc.line(11);
    moveTo(view, text.to);
    moveTo(view, text.to + 1);
    expect(view.state.selection.main.head).toBe(after.from);
    moveTo(view, after.to - 1);
    moveTo(view, after.from - 1);
    expect(view.state.selection.main.head).toBe(text.to);
    // A click: the nearer side.
    moveTo(view, text.to + 2, 'select.pointer');
    expect(view.state.selection.main.head).toBe(text.to);
  });

  it('Backspace and Delete next to a hidden comment move past it instead of joining a line to it', () => {
    let view = noteEditor('Text\n%%\nhidden\n%%\n‸After');
    expect(press(view, 'Backspace')).toBe(true);
    expect(marked(view)).toBe('Text‸\n%%\nhidden\n%%\nAfter');
    view = noteEditor('Text‸\n%%\nhidden\n%%\nAfter');
    expect(press(view, 'Delete')).toBe(true);
    expect(marked(view)).toBe('Text\n%%\nhidden\n%%\n‸After');
    // An empty line next to it is deleted as usual.
    view = noteEditor('Text\n%%\nhidden\n%%\n‸\nAfter');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('Text\n%%\nhidden\n%%\nAfter');
  });

  it('typing against a hidden comment puts the text on a line of its own', () => {
    const view = noteEditor('Text\n%%\nhidden\n%%‸');
    typeText(view, 'more');
    expect(view.state.doc.toString()).toBe('Text\n%%\nhidden\n%%\nmore');
    const before = noteEditor('‸%%\nhidden\n%%');
    typeText(before, 'top');
    expect(before.state.doc.toString()).toBe('top\n%%\nhidden\n%%');
  });

  it('a comment you close by typing stays shown until the caret leaves it', () => {
    const view = noteEditor('Text\n\n%%\nnote\n‸');
    typeText(view, '%%');
    expect(blocks(view)).toEqual([]);
    moveTo(view, 2);
    expect(blocks(view)).toEqual(['comment:%%\nnote\n%%']);
  });

  it('a search match in a hidden comment shows it', () => {
    const view = noteEditor(NOTE);
    const at = view.state.doc.toString().indexOf('hidden');
    view.dispatch({ selection: EditorSelection.range(at, at + 6), userEvent: 'select.search' });
    expect(blocks(view).slice(1)).toEqual([]);
  });

  it('deleting it with a selection and undoing it keeps it hidden', () => {
    const view = noteEditor(NOTE);
    const from = view.state.doc.line(7).from;
    const to = view.state.doc.line(11).to;
    view.dispatch({ selection: EditorSelection.range(from, to) });
    press(view, 'Backspace');
    expect(view.state.doc.toString().endsWith('First line\n\n')).toBe(true);
    undo(view);
    expect(view.state.doc.toString()).toBe(NOTE);
    expect(blocks(view).slice(1)).toEqual(['comment:%%\nhidden\n%%']);
  });
});
