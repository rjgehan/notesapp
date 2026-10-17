import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { addNestedEditor, isComposing, removeNestedEditor, waitForComposition } from './remote';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function editor(): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc: 'x' }), parent: document.body });
  views.push(view);
  return view;
}

function composing(view: EditorView, value: boolean): void {
  Object.defineProperty(view, 'composing', { configurable: true, get: () => value });
}

describe('compositions in nested editors (a table cell, DESIGN §6.6.1)', () => {
  it('counts a nested editor’s composition as the note’s', () => {
    const note = editor();
    const cell = editor();
    expect(isComposing(note)).toBe(false);
    addNestedEditor(note, cell);
    composing(cell, true);
    expect(isComposing(note)).toBe(true);
    removeNestedEditor(note, cell);
    expect(isComposing(note)).toBe(false);
  });

  it('waits for the nested editor’s compositionend', async () => {
    const note = editor();
    const cell = editor();
    addNestedEditor(note, cell);
    composing(cell, true);
    let done = false;
    const wait = waitForComposition(note).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    composing(cell, false);
    cell.contentDOM.dispatchEvent(new Event('compositionend'));
    await wait;
    expect(done).toBe(true);
  });
});
