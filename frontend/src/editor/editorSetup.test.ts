import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setHotkey } from '../features/hotkeyPrefs';
import { isApple } from '../features/platform';
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
