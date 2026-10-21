// Customized hotkeys (ROADMAP item 29, DESIGN §6.25), per device in localStorage: a command id
// mapped to its own key (a CodeMirror-style spec such as `Mod-Shift-b`) or to null (no key).
// Commands without an entry keep their default. Other tabs follow through the `storage` event.
import { useSyncExternalStore } from 'react';
import { allCommands, type Command } from './commands';

export const HOTKEYS_KEY = 'notesapp:hotkeys';

export type HotkeyOverrides = Readonly<Record<string, string | null>>;

const listeners = new Set<() => void>();
let cache: HotkeyOverrides | null = null;
let raw: string | null = null;

function parse(text: string | null): HotkeyOverrides {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string | null> = {};
    for (const [id, spec] of Object.entries(value)) {
      if (spec === null) out[id] = null;
      else if (typeof spec === 'string' && spec !== '') out[id] = normalizeSpec(spec);
    }
    return out;
  } catch {
    return {};
  }
}

function read(): HotkeyOverrides {
  let text: string | null;
  try {
    text = localStorage.getItem(HOTKEYS_KEY);
  } catch {
    // Private mode: defaults only, or what this page set.
    return cache ?? {};
  }
  if (cache === null || text !== raw) {
    raw = text;
    cache = parse(text);
  }
  return cache;
}

function write(next: HotkeyOverrides): void {
  const text = JSON.stringify(next);
  cache = next;
  raw = text;
  try {
    localStorage.setItem(HOTKEYS_KEY, text);
  } catch {
    // Kept for this page load.
  }
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== HOTKEYS_KEY && e.key !== null) return;
    cache = null;
    for (const l of listeners) l();
  });
}

export function subscribeHotkeys(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hotkeyOverrides(): HotkeyOverrides {
  return read();
}

/** Re-renders when this device's hotkeys change. */
export function useHotkeyOverrides(): HotkeyOverrides {
  return useSyncExternalStore(subscribeHotkeys, read);
}

/** A key spec in the global handler's form: modifiers as Mod, Alt, Shift in that order; a letter in lower case. */
export function normalizeSpec(spec: string): string {
  const parts = spec.split('-');
  // `Mod--` is the minus key.
  let key = parts.pop() ?? '';
  if (key === '' && parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    key = '-';
  }
  const mods = new Set(parts.map((p) => (p === 'Cmd' || p === 'Ctrl' || p === 'Meta' ? 'Mod' : p)));
  const ordered = ['Mod', 'Alt', 'Shift'].filter((m) => mods.has(m));
  return [...ordered, key.length === 1 ? key.toLowerCase() : key].join('-');
}

/** The key a command has by default: its global hotkey, or the one the editor binds. */
export function defaultHotkey(c: Pick<Command, 'hotkey' | 'editorHotkey'>): string | null {
  const spec = c.hotkey ?? c.editorHotkey;
  return spec ? normalizeSpec(spec) : null;
}

/** The key a command has on this device. */
export function effectiveHotkey(c: Pick<Command, 'id' | 'hotkey' | 'editorHotkey'>, overrides: HotkeyOverrides = read()): string | null {
  return c.id in overrides ? overrides[c.id] : defaultHotkey(c);
}

/** True when this device changed (or removed) the command's key. */
export function isCustomized(id: string, overrides: HotkeyOverrides = read()): boolean {
  return id in overrides;
}

/** Binds a command to `spec` (null: no key). Binding it to its default clears the customization. */
export function setHotkey(c: Pick<Command, 'id' | 'hotkey' | 'editorHotkey'>, spec: string | null): void {
  const next: Record<string, string | null> = { ...read() };
  const normalized = spec === null ? null : normalizeSpec(spec);
  if (normalized === defaultHotkey(c)) delete next[c.id];
  else next[c.id] = normalized;
  write(next);
}

export function resetHotkey(id: string): void {
  const next: Record<string, string | null> = { ...read() };
  delete next[id];
  write(next);
}

export function resetAllHotkeys(): void {
  write({});
}

/** The other commands that use `spec` on this device. */
export function conflictsWith(spec: string, exceptId: string, commands: readonly Command[] = allCommands()): Command[] {
  const s = normalizeSpec(spec);
  const overrides = read();
  return commands.filter((c) => c.id !== exceptId && effectiveHotkey(c, overrides) === s);
}

/** Keys a command cannot take: the browser keeps them, or the editor needs them for editing. */
const RESERVED: Record<string, string> = {
  'Mod-n': 'the browser opens a new window with it',
  'Mod-t': 'the browser opens a new tab with it',
  'Mod-w': 'the browser closes the tab with it',
  'Mod-Shift-n': 'the browser opens a private window with it',
  'Mod-Shift-t': 'the browser reopens a closed tab with it',
  'Mod-Shift-w': 'the browser closes the window with it',
  'Mod-q': 'the browser quits with it',
  'Mod-r': 'it reloads the page',
  'Mod-z': 'it is Undo',
  'Mod-Shift-z': 'it is Redo',
  'Mod-y': 'it is Redo',
  'Mod-c': 'it is Copy',
  'Mod-v': 'it is Paste',
  'Mod-x': 'it is Cut',
  'Mod-a': 'it is Select all',
};

/** Why `spec` cannot be bound, or null. */
export function reservedReason(spec: string): string | null {
  return RESERVED[normalizeSpec(spec)] ?? null;
}

/** " (Ctrl+E)" for a command's key on this device, or "" without one: for tooltips. */
export function keyHint(id: string, label: (spec: string) => string): string {
  const c = allCommands().find((x) => x.id === id);
  const spec = c ? effectiveHotkey(c) : null;
  return spec ? ` (${label(spec)})` : '';
}
