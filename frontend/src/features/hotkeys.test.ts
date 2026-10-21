import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCommand } from './commands';
import { installHotkeys } from './hotkeys';
import { isApple } from './platform';

const mod = isApple ? { metaKey: true } : { ctrlKey: true };
let uninstall: () => void;

function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  uninstall = installHotkeys();
});

afterEach(() => {
  uninstall();
  document.body.innerHTML = '';
});

describe('global hotkeys', () => {
  it('runs a command for its hotkey outside text fields', () => {
    const run = vi.fn();
    registerCommand({ id: 'test.newNote', name: 'New', hotkey: 'Mod-Alt-n', run });
    const ev = press(document.body, { key: 'n', code: 'KeyN', altKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('leaves ordinary hotkeys to a focused editor, but always-global ones win before its keymap', () => {
    const local = vi.fn();
    const search = vi.fn();
    registerCommand({ id: 'test.local', name: 'Local', hotkey: 'Mod-Alt-n', run: local });
    registerCommand({ id: 'search.open', name: 'Search', hotkey: 'Mod-Shift-f', run: search });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    editor.appendChild(content);
    document.body.appendChild(editor);
    // The editor's keymap would claim Mod-Shift-f as its own Mod-f; capture runs first.
    let editorSawIt = false;
    content.addEventListener('keydown', (e) => {
      editorSawIt = true;
      e.preventDefault();
    });
    press(content, { key: 'F', code: 'KeyF', shiftKey: true, ...mod });
    expect(search).toHaveBeenCalledTimes(1);
    expect(editorSawIt).toBe(false);
    press(content, { key: 'n', code: 'KeyN', altKey: true, ...mod });
    expect(local).not.toHaveBeenCalled();
  });

  it('runs a command that asks for it (globalHotkey) inside text fields and the editor too', () => {
    const add = vi.fn();
    registerCommand({ id: 'test.quickAdd', name: 'Add task', hotkey: 'Mod-Alt-t', globalHotkey: true, run: add });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    editor.appendChild(content);
    const input = document.createElement('input');
    document.body.append(editor, input);
    press(content, { key: 't', code: 'KeyT', altKey: true, ...mod });
    press(input, { key: 't', code: 'KeyT', altKey: true, ...mod });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it.skipIf(isApple)('lets AltGr (Ctrl+Alt) type its character in text fields instead of running a hotkey', () => {
    const add = vi.fn();
    registerCommand({ id: 'test.quickAdd', name: 'Add task', hotkey: 'Mod-Alt-t', globalHotkey: true, run: add });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.contentEditable = 'true';
    editor.appendChild(content);
    const input = document.createElement('input');
    document.body.append(editor, input);
    // Romanian (Programmers): AltGr+T types ț; Turkish Q: ₺.
    const typed = press(content, { key: 'ț', code: 'KeyT', ctrlKey: true, altKey: true });
    const lira = press(input, { key: '₺', code: 'KeyT', ctrlKey: true, altKey: true });
    expect(add).not.toHaveBeenCalled();
    expect(typed.defaultPrevented).toBe(false);
    expect(lira.defaultPrevented).toBe(false);
    // Ctrl+Alt+T on a layout without an AltGr character there is still the hotkey, and so is any
    // Ctrl+Alt+T outside text fields.
    press(content, { key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
    press(document.body, { key: 'ț', code: 'KeyT', ctrlKey: true, altKey: true });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it('runs F2 without modifiers and ignores plain keys', () => {
    const rename = vi.fn();
    registerCommand({ id: 'file.rename', name: 'Rename', hotkey: 'F2', run: rename });
    press(document.body, { key: 'F2' });
    press(document.body, { key: 'a' });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('skips commands whose `when` is false', () => {
    const run = vi.fn();
    registerCommand({ id: 'test.inactive', name: 'Inactive', hotkey: 'Mod-Alt-k', when: () => false, run });
    const ev = press(document.body, { key: 'k', code: 'KeyK', altKey: true, ...mod });
    expect(run).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('customized hotkeys (DESIGN §6.25)', () => {
  it('runs a command on the key this device chose, even in the editor, and not on its old key', async () => {
    const { setHotkey } = await import('./hotkeyPrefs');
    const run = vi.fn();
    const command = { id: 'test.custom', name: 'Custom', hotkey: 'Mod-Alt-j', run };
    registerCommand(command);
    setHotkey(command, 'Mod-Shift-u');
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    document.body.appendChild(editor);
    press(editor, { key: 'U', code: 'KeyU', shiftKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(1);
    press(document.body, { key: 'j', code: 'KeyJ', altKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(1);
    setHotkey(command, null);
    press(document.body, { key: 'U', code: 'KeyU', shiftKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives an editor-bound command a global key only once it is customized', async () => {
    const { setHotkey } = await import('./hotkeyPrefs');
    const run = vi.fn();
    const command = { id: 'test.editorOnly', name: 'Editor only', editorHotkey: 'Mod-Alt-y', run };
    registerCommand(command);
    press(document.body, { key: 'y', code: 'KeyY', altKey: true, ...mod });
    expect(run).not.toHaveBeenCalled();
    setHotkey(command, 'Mod-Alt-y');
    // Its default: still the editor's job.
    press(document.body, { key: 'y', code: 'KeyY', altKey: true, ...mod });
    expect(run).not.toHaveBeenCalled();
    setHotkey(command, 'Mod-Alt-h');
    press(document.body, { key: 'h', code: 'KeyH', altKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves keys alone while Settings records one', () => {
    const run = vi.fn();
    registerCommand({ id: 'test.recorded', name: 'Recorded', hotkey: 'Mod-Alt-m', run });
    const recorder = document.createElement('button');
    recorder.setAttribute('data-hotkey-recorder', '');
    document.body.appendChild(recorder);
    press(recorder, { key: 'm', code: 'KeyM', altKey: true, ...mod });
    expect(run).not.toHaveBeenCalled();
  });
});
