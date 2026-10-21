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

describe('quick capture hotkey', () => {
  it('Mod-Shift-Space opens capture anywhere, the editor and text fields included', () => {
    const run = vi.fn();
    registerCommand({ id: 'capture.quick', name: 'Quick capture', hotkey: 'Mod-Shift-Space', run });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    editor.appendChild(content);
    document.body.appendChild(editor);
    const ev = press(content, { key: ' ', code: 'Space', shiftKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, { key: ' ', code: 'Space', shiftKey: true, ...mod });
    expect(run).toHaveBeenCalledTimes(2);
    // A plain space is typing, never a hotkey.
    press(input, { key: ' ', code: 'Space' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
