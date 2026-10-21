import { describe, expect, it, vi } from 'vitest';
import { registerCommand } from './commands';
import {
  conflictsWith,
  defaultHotkey,
  effectiveHotkey,
  HOTKEYS_KEY,
  hotkeyOverrides,
  isCustomized,
  keyHint,
  normalizeSpec,
  reservedReason,
  resetAllHotkeys,
  resetHotkey,
  setHotkey,
  subscribeHotkeys,
} from './hotkeyPrefs';

const bold = { id: 'hk.bold', name: 'Bold', editorHotkey: 'Mod-b', run: () => {} };
const open = { id: 'hk.open', name: 'Open', hotkey: 'Mod-Alt-o', run: () => {} };
const plain = { id: 'hk.plain', name: 'Plain', run: () => {} };

describe('hotkey preferences', () => {
  it('normalizes key specs to the handler’s form', () => {
    expect(normalizeSpec('Shift-Mod-B')).toBe('Mod-Shift-b');
    expect(normalizeSpec('Ctrl-Alt-ArrowLeft')).toBe('Mod-Alt-ArrowLeft');
    expect(normalizeSpec('Mod--')).toBe('Mod--');
    expect(normalizeSpec('F2')).toBe('F2');
  });

  it('gives each command its default until this device changes it', () => {
    expect(defaultHotkey(bold)).toBe('Mod-b');
    expect(effectiveHotkey(open)).toBe('Mod-Alt-o');
    expect(effectiveHotkey(plain)).toBeNull();
    setHotkey(bold, 'Mod-Shift-B');
    setHotkey(open, null);
    setHotkey(plain, 'F7');
    expect(effectiveHotkey(bold)).toBe('Mod-Shift-b');
    expect(effectiveHotkey(open)).toBeNull();
    expect(effectiveHotkey(plain)).toBe('F7');
    expect(isCustomized('hk.open')).toBe(true);
    expect(JSON.parse(localStorage.getItem(HOTKEYS_KEY)!)).toEqual({ 'hk.bold': 'Mod-Shift-b', 'hk.open': null, 'hk.plain': 'F7' });
    resetHotkey('hk.open');
    expect(effectiveHotkey(open)).toBe('Mod-Alt-o');
    // Binding a command to its default is no customization.
    setHotkey(bold, 'Mod-b');
    expect(isCustomized('hk.bold')).toBe(false);
    resetAllHotkeys();
    expect(hotkeyOverrides()).toEqual({});
  });

  it('ignores invalid stored data', () => {
    localStorage.setItem(HOTKEYS_KEY, JSON.stringify({ a: 5, b: '', c: null, d: 'Alt-Mod-x' }));
    expect(hotkeyOverrides()).toEqual({ c: null, d: 'Mod-Alt-x' });
    localStorage.setItem(HOTKEYS_KEY, '{ nope');
    expect(hotkeyOverrides()).toEqual({});
  });

  it('finds the other commands that use a key', () => {
    registerCommand(bold);
    registerCommand(open);
    registerCommand(plain);
    expect(conflictsWith('Mod-b', 'hk.plain').map((c) => c.id)).toEqual(['hk.bold']);
    expect(conflictsWith('Mod-b', 'hk.bold')).toEqual([]);
    setHotkey(bold, 'Mod-Alt-o');
    expect(conflictsWith('Mod-Alt-o', 'hk.plain').map((c) => c.id).sort()).toEqual(['hk.bold', 'hk.open']);
    expect(keyHint('hk.open', (s) => s)).toBe(' (Mod-Alt-o)');
    expect(keyHint('hk.plain', (s) => s)).toBe('');
  });

  it('refuses keys the browser or the editor needs', () => {
    expect(reservedReason('Mod-t')).toMatch(/browser/);
    expect(reservedReason('Mod-z')).toMatch(/Undo/);
    expect(reservedReason('Mod-Shift-b')).toBeNull();
  });

  it('tells subscribers about changes', () => {
    const fn = vi.fn();
    const off = subscribeHotkeys(fn);
    setHotkey(plain, 'F8');
    expect(fn).toHaveBeenCalled();
    off();
  });
});
