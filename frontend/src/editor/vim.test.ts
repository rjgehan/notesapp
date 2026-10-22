import { searchPanelOpen } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCM, Vim } from '@replit/codemirror-vim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommand } from '../features/commands';
import { setHotkey } from '../features/hotkeyPrefs';
import { installHotkeys } from '../features/hotkeys';
import { isApple } from '../features/platform';
import { DEFAULT_PREFS, PREFS_KEY, usePrefs } from '../state/prefs';
import { noteExtensions, plainTextExtensions } from './editorSetup';
import { testContext } from '../test/noteEditor';
import { attachVim, currentVimMode, loadedVim, loadVim, vimAvailable, vimWanted } from './vimMode';

const mod = isApple ? { metaKey: true } : { ctrlKey: true };
const views: EditorView[] = [];
let uninstall: (() => void) | null = null;

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  uninstall?.();
  uninstall = null;
  vi.unstubAllGlobals();
});

function editor(opts: { vim: boolean; save?: () => void; doc?: string }): EditorView {
  const hooks = { onLocalChange: () => {}, onBlur: () => {}, readOnly: false, spellcheck: false, autocorrect: false, vim: opts.vim, save: opts.save ?? (() => {}) };
  const view = new EditorView({ state: EditorState.create({ doc: opts.doc ?? 'one two\nthree', extensions: plainTextExtensions(hooks, null) }), parent: document.body });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(ev);
  return ev;
}

function type(view: EditorView, keys: string): void {
  for (const k of keys) press(view, k);
}

describe('vim preference (Settings, This device)', () => {
  it('is off by default and kept per device', () => {
    expect(DEFAULT_PREFS.vimMode).toBe(false);
    expect(usePrefs.getState().vimMode).toBe(false);
    usePrefs.getState().update({ vimMode: true });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ vimMode: true });
    usePrefs.getState().update({ vimMode: false });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ vimMode: false });
  });

  it('only applies with a mouse or trackpad, not on a touch screen', () => {
    expect(vimWanted(false)).toBe(false);
    expect(vimWanted(true)).toBe(true);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} }));
    expect(vimAvailable()).toBe(false);
    expect(vimWanted(true)).toBe(false);
  });
});

describe('lazy loading', () => {
  it('loads nothing for an editor without vim, then switches a vim editor on once the chunk arrives', async () => {
    const plain = editor({ vim: false });
    attachVim(plain, false);
    expect(loadedVim()).toBeNull();
    expect(getCM(plain)).toBeNull();

    const view = editor({ vim: true });
    // The chunk is not there yet: the editor starts as a plain editor.
    expect(getCM(view)).toBeNull();
    attachVim(view, true);
    await loadVim();
    await Promise.resolve();
    expect(getCM(view)).not.toBeNull();
    expect(view.scrollDOM.classList.contains('cm-vimMode')).toBe(true);
    // A later vim editor gets it at creation.
    expect(getCM(editor({ vim: true }))).not.toBeNull();
    expect(getCM(plain)).toBeNull();
  });
});

describe('vim keys', () => {
  beforeEach(async () => {
    await loadVim();
  });

  it('edits in normal mode and types in insert mode, with the mode in the status bar', () => {
    const view = editor({ vim: true, doc: 'abc' });
    view.focus();
    expect(currentVimMode()).toBe('NORMAL');
    type(view, 'x');
    expect(view.state.doc.toString()).toBe('bc');
    type(view, 'j');
    expect(view.state.doc.toString()).toBe('bc');
    type(view, 'i');
    expect(currentVimMode()).toBe('INSERT');
    press(view, 'Escape');
    expect(currentVimMode()).toBe('NORMAL');
    type(view, 'v');
    expect(currentVimMode()).toBe('VISUAL');
    press(view, 'Escape');
    type(view, 'V');
    expect(currentVimMode()).toBe('VISUAL LINE');
    view.destroy();
    expect(currentVimMode()).toBeNull();
  });

  it(':w saves now; :q, :wq and :x leave the editor', async () => {
    const save = vi.fn();
    const view = editor({ vim: true, save });
    // A vim editor's adapter (its vim state is set once vim is on).
    const cm = getCM(view) as Parameters<typeof Vim.handleEx>[0];
    Vim.handleEx(cm, 'w');
    expect(save).toHaveBeenCalledTimes(1);
    view.focus();
    expect(view.hasFocus).toBe(true);
    Vim.handleEx(cm, 'wq');
    expect(save).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.hasFocus).toBe(false);
    view.focus();
    Vim.handleEx(cm, 'q');
    await new Promise((r) => setTimeout(r, 0));
    expect(view.hasFocus).toBe(false);
    Vim.handleEx(cm, 'x');
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('runs the app’s editor keys before vim’s, and leaves a re-bound one to vim', () => {
    const view = editor({ vim: true });
    view.focus();
    // Mod-f is find (on Windows and Linux vim would page down with Ctrl-F).
    press(view, 'f', { code: 'KeyF', ...mod });
    expect(searchPanelOpen(view.state)).toBe(true);

    const other = editor({ vim: true });
    other.focus();
    setHotkey({ id: 'editor.find', editorHotkey: 'Mod-f' }, 'Mod-Alt-f');
    press(other, 'f', { code: 'KeyF', ...mod });
    expect(searchPanelOpen(other.state)).toBe(false);
  });

  it('Mod-s saves in every mode', () => {
    const save = vi.fn();
    const view = editor({ vim: true, save });
    view.focus();
    press(view, 's', { code: 'KeyS', ...mod });
    type(view, 'i');
    press(view, 's', { code: 'KeyS', ...mod });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('never runs app hotkeys for normal-mode keys, while the app’s global keys still work', () => {
    uninstall = installHotkeys();
    const switcher = vi.fn();
    const plainKey = vi.fn();
    registerCommand({ id: 'app.quickSwitcher', name: 'Switcher', hotkey: 'Mod-o', run: switcher });
    registerCommand({ id: 'test.vimF2', name: 'F2 thing', hotkey: 'F2', run: plainKey });
    const view = editor({ vim: true, doc: 'one\ntwo\nthree' });
    view.focus();
    type(view, 'jj:/ggGdd');
    expect(switcher).not.toHaveBeenCalled();
    expect(plainKey).not.toHaveBeenCalled();
    // Mod-O (vim's jump back on Windows) opens the quick switcher, before vim sees it.
    const before = view.state.selection.main.head;
    const ev = press(view, 'o', { code: 'KeyO', ...mod });
    expect(switcher).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(view.state.selection.main.head).toBe(before);
  });
});

describe('vim in the note editor (Live Preview and source mode)', () => {
  beforeEach(async () => {
    await loadVim();
  });

  function noteVim(mode: 'live' | 'source', doc: string): EditorView {
    const hooks = {
      onLocalChange: () => {},
      onBlur: () => {},
      readOnly: false,
      spellcheck: false,
      autocorrect: false,
      vim: true,
      livePreview: mode === 'live' ? { visibility: 'hide-all' as const, locked: false, checkboxes: true } : null,
    };
    const view = new EditorView({ state: EditorState.create({ doc, extensions: noteExtensions(testContext(), hooks) }), parent: document.body });
    views.push(view);
    return view;
  }

  for (const mode of ['live', 'source'] as const) {
    it(`edits with vim keys and keeps the app's formatting keys (${mode})`, () => {
      const view = noteVim(mode, 'word here');
      view.focus();
      expect(getCM(view)).not.toBeNull();
      expect(currentVimMode()).toBe('NORMAL');
      type(view, 'x');
      expect(view.state.doc.toString()).toBe('ord here');
      // Mod-B (bold) runs before vim's own keys, in normal mode too.
      type(view, 'viw');
      press(view, 'b', { code: 'KeyB', ...mod });
      expect(view.state.doc.toString()).toBe('**ord** here');
      press(view, 'Escape');
      type(view, 'A');
      expect(currentVimMode()).toBe('INSERT');
    });
  }

  it('Mod-E is inline code in Live Preview text', () => {
    const view = noteVim('live', 'word');
    view.focus();
    type(view, 'viw');
    press(view, 'e', { code: 'KeyE', ...mod });
    expect(view.state.doc.toString()).toBe('`word`');
  });
});
