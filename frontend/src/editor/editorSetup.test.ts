import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setHotkey } from '../features/hotkeyPrefs';
import { isApple } from '../features/platform';
import { destroyEditors, noteEditor, testContext } from '../test/noteEditor';
import { decryptedNoteExtensions, plainTextExtensions } from './editorSetup';

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
  function note(readOnly = false): EditorView {
    return noteEditor('«word»', { readOnly, ctx: testContext() });
  }
  const modE = (view: EditorView) =>
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true, cancelable: true, ...(isApple ? { metaKey: true } : { ctrlKey: true }) }));

  afterEach(() => destroyEditors());

  it('is inline code, never a mode switch; a read-only note does nothing', () => {
    const editing = note();
    modE(editing);
    expect(editing.state.doc.toString()).toBe('`word`');
    const readOnly = note(true);
    modE(readOnly);
    expect(readOnly.state.doc.toString()).toBe('word');
  });

  it('follows the inline code command’s key', () => {
    setHotkey({ id: 'editor.inlineCode', editorHotkey: 'Mod-e' }, 'Mod-Shift-c');
    const editing = note();
    modE(editing);
    expect(editing.state.doc.toString()).toBe('word');
  });
});

describe('the decrypted text of an encrypted note (DESIGN §6.33)', () => {
  function decrypted(doc: string, locked = false): EditorView {
    const hooks = { onLocalChange: () => {}, onBlur: () => {}, readOnly: locked, spellcheck: false, autocorrect: false, save: () => {} };
    const extensions = decryptedNoteExtensions(hooks, { visibility: 'hide-all', locked, checkboxes: !locked, remoteImages: false, scripts: 'off' });
    const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions }), parent: document.body });
    views.push(view);
    return view;
  }

  it('shows in Live Preview like every note: markup hides, links show as text, spellcheck stays off', () => {
    const view = decrypted('# Plan\n\n**PIN** and [[Welcome|home]]\n');
    expect(view.dom.classList.contains('cm-live-preview')).toBe(true);
    const shown = view.contentDOM.textContent ?? '';
    expect(shown).toContain('PIN and home');
    expect(shown).not.toContain('**');
    expect(shown).not.toContain('[[');
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false');
  });

  it('read-only, it renders locked', () => {
    const view = decrypted('**b**', true);
    expect(view.state.readOnly).toBe(true);
    expect(view.dom.classList.contains('cm-lp-locked')).toBe(true);
  });
});
