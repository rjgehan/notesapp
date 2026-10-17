import { search, searchPanelOpen } from '@codemirror/search';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../extensions/builtins';
import { runCommand } from '../features/commands';
import { clearActiveEditor, setActiveEditor } from './activeEditor';
import { toggleCheckbox } from './editorCommands';

const views: EditorView[] = [];

function editor(doc: string, cursor: number, extensions: Extension[] = []) {
  const view = new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions }), parent: document.body });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const v of views.splice(0)) {
    clearActiveEditor(v);
    v.destroy();
  }
});

describe('toggleCheckbox (Mod-L, the toolbar checkbox) (FE-8)', () => {
  function toggleThenType(doc: string, cursor: number, typed: string): string {
    const view = editor(doc, cursor);
    toggleCheckbox(view);
    view.dispatch(view.state.replaceSelection(typed));
    return view.state.doc.toString();
  }

  it('leaves the caret after the inserted task prefix', () => {
    expect(toggleThenType('', 0, 'abc')).toBe('- [ ] abc');
    expect(toggleThenType('- ', 2, 'xyz')).toBe('- [ ] xyz');
    expect(toggleThenType('text', 4, '!')).toBe('- [ ] text!');
  });

  it('keeps the caret in place when toggling an existing task', () => {
    const view = editor('- [ ] task', 10);
    toggleCheckbox(view);
    expect(view.state.doc.toString()).toBe('- [x] task');
    expect(view.state.selection.main.head).toBe(10);
  });
});

describe('editor commands from the palette (FE-4)', () => {
  it('Find/replace leaves the focus in the search field, so the query is not typed into the note', () => {
    registerBuiltins();
    // Browsers focus an input on select(), which the search panel uses to focus its field.
    const select = HTMLInputElement.prototype.select;
    HTMLInputElement.prototype.select = function (this: HTMLInputElement) {
      this.focus();
      select.call(this);
    };
    try {
      const palette = document.createElement('input');
      document.body.appendChild(palette);
      const view = editor('Plan text', 0, [search({ top: true })]);
      setActiveEditor(view);
      palette.focus();
      expect(runCommand('editor.find', { activePath: 'Plan.md' })).toBe(true);
      expect(searchPanelOpen(view.state)).toBe(true);
      const active = document.activeElement as HTMLInputElement | null;
      expect(active?.getAttribute('name')).toBe('search');
      expect(view.contentDOM.contains(active)).toBe(false);
      palette.remove();
    } finally {
      HTMLInputElement.prototype.select = select;
    }
  });

  it('other editing commands return the focus to the text', () => {
    registerBuiltins();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    const view = editor('', 0);
    setActiveEditor(view);
    outside.focus();
    runCommand('editor.toggleCheckbox', { activePath: 'Plan.md' });
    expect(view.hasFocus).toBe(true);
    outside.remove();
  });
});
