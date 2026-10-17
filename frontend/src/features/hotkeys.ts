// Global key handler for command hotkeys (DESIGN §6.13, §6.14). Mod = Cmd on Apple, Ctrl elsewhere.
// Inside the editor and text fields only the always-global hotkeys fire; the editor keymap binds
// its own (Mod-B/I/K/L/E/S/Enter).
import { availableCommands, runCommand } from './commands';
import { activePath } from './navigation';
import { isApple } from './platform';

/** Hotkeys that work even while the editor or a text field has focus. */
const ALWAYS_GLOBAL = new Set(['Mod-o', 'Mod-p', 'Mod-Shift-f', 'Mod-,', 'Mod-Alt-ArrowLeft', 'Mod-Alt-ArrowRight']);

function normalize(spec: string): string {
  const parts = spec.split('-');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const ordered = ['Mod', 'Alt', 'Shift'].filter((m) => mods.has(m));
  return [...ordered, key.length === 1 ? key.toLowerCase() : key].join('-');
}

/** The CodeMirror-style spec of a keyboard event, or null without a modifier or function key. */
export function eventSpec(e: KeyboardEvent): string | null {
  const mod = isApple ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // With Alt held, macOS produces composed characters in `key`; use the physical key instead.
  let key = e.key;
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (e.altKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (parts.length === 0 && !/^F\d+$/.test(key)) return null;
  return [...parts, key.length === 1 ? key.toLowerCase() : key].join('-');
}

function inTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('.cm-editor, input, textarea, select, [contenteditable="true"]');
}

function handle(e: KeyboardEvent, capture: boolean): void {
  if (e.defaultPrevented || e.isComposing) return;
  const spec = eventSpec(e);
  if (!spec) return;
  // The always-global hotkeys run in the capture phase, before the editor's keymap sees them
  // (CodeMirror would otherwise match Mod-Shift-f against its own Mod-f); the rest let focused
  // widgets (editor, explorer, dialogs) handle the key first.
  const global = ALWAYS_GLOBAL.has(spec);
  if (global !== capture) return;
  const editing = inTextInput(e.target);
  // A modal dialog owns the keyboard; only the always-global hotkeys pass through it.
  const inModal = e.target instanceof HTMLElement && !!e.target.closest('[aria-modal="true"]');
  if ((editing || inModal) && !global) return;
  const ctx = { activePath: activePath() };
  for (const command of availableCommands(ctx)) {
    if (!command.hotkey || normalize(command.hotkey) !== spec) continue;
    if (runCommand(command.id, ctx)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
}

export function installHotkeys(): () => void {
  const onCapture = (e: KeyboardEvent) => handle(e, true);
  const onBubble = (e: KeyboardEvent) => handle(e, false);
  window.addEventListener('keydown', onCapture, true);
  window.addEventListener('keydown', onBubble);
  return () => {
    window.removeEventListener('keydown', onCapture, true);
    window.removeEventListener('keydown', onBubble);
  };
}
