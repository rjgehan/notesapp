import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setHotkey } from '../features/hotkeyPrefs';
import { isApple } from '../features/platform';
import { destroyEditors, noteEditor, testContext } from '../test/noteEditor';
import { plainTextExtensions } from './editorSetup';

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function editor(save: () => void): EditorView {
  const hooks = { onLocalChange: () => {}, onBlur: () => {}, readOnly: false, spellcheck: false, autocorrect: false, save };
  const view = new EditorView({ state: EditorState.create({ doc: 'text', extensions: plainTextExtensions(hooks, null) }), parent: document.body });
  views.push(view);
  return view;
}

function pressModS(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true, cancelable: true, ...(isApple ? { metaKey: true } : { ctrlKey: true }) }));
}

describe('editor default keys (DESIGN §6.25)', () => {
  it('step aside once this device gives their command another key', () => {
    const save = vi.fn();
    const view = editor(save);
    pressModS(view);
    expect(save).toHaveBeenCalledTimes(1);
    setHotkey({ id: 'editor.save', hotkey: 'Mod-s' }, 'Mod-Shift-s');
    pressModS(view);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('Mod-E in a note (DESIGN §6.6.1, §6.25)', () => {
  function note(mode: 'live' | 'locked', toggleMode: () => void): EditorView {
    const view = noteEditor('«word»', { mode, ctx: testContext({ toggleMode }) });
    return view;
  }
  const modE = (view: EditorView) =>
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true, cancelable: true, ...(isApple ? { metaKey: true } : { ctrlKey: true }) }));

  afterEach(() => destroyEditors());

  it('is inline code while editing and unlocks a locked note', () => {
    const toggle = vi.fn();
    const editing = note('live', toggle);
    modE(editing);
    expect(editing.state.doc.toString()).toBe('`word`');
    expect(toggle).not.toHaveBeenCalled();
    const locked = note('locked', toggle);
    modE(locked);
    expect(locked.state.doc.toString()).toBe('word');
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('each half follows its own command’s key', () => {
    const toggle = vi.fn();
    setHotkey({ id: 'editor.inlineCode', editorHotkey: 'Mod-e' }, 'Mod-Shift-c');
    setHotkey({ id: 'editor.toggleMode', hotkey: 'Mod-e' }, 'Mod-Shift-l');
    const editing = note('live', toggle);
    modE(editing);
    expect(editing.state.doc.toString()).toBe('word');
    modE(note('locked', toggle));
    expect(toggle).not.toHaveBeenCalled();
  });
});
