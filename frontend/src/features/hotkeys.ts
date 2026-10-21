// Global key handler for command hotkeys (DESIGN §6.13, §6.14, §6.25). Mod = Cmd on Apple, Ctrl
// elsewhere. Keys are each command's key on this device (its default, or the one chosen under
// Settings, Hotkeys). Inside the editor and text fields only the always-global commands, commands
// that ask for it with `globalHotkey` (quick add) and keys this device chose fire; the editor's
// keymap binds its own defaults (Mod-B/I/K/L/E/S/Enter).
import { availableCommands, runCommand } from './commands';
import { effectiveHotkey, hotkeyOverrides } from './hotkeyPrefs';
import { activePath } from './navigation';
import { isApple } from './platform';

/** Commands whose key works even while the editor or a text field has focus. */
export const ALWAYS_GLOBAL = new Set(['app.quickSwitcher', 'app.commandPalette', 'search.open', 'settings.open', 'nav.back', 'nav.forward']);

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
  // A modifier on its own is not a key yet.
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') return null;
  return [...parts, key.length === 1 ? key.toLowerCase() : key].join('-');
}

/**
 * AltGr typing a character: Windows and Linux report AltGr as Ctrl+Alt, so AltGr+T (ț in
 * Romanian, ₺ in Turkish Q) would match a Mod-Alt-t hotkey. A key that produces a character
 * other than a plain letter or digit with Ctrl+Alt held is that character, not a hotkey.
 */
function isAltGrCharacter(e: KeyboardEvent): boolean {
  return !isApple && e.ctrlKey && e.altKey && !e.metaKey && e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key);
}

function inTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('.cm-editor, input, textarea, select, [contenteditable="true"]');
}

function handle(e: KeyboardEvent, capture: boolean): void {
  if (e.defaultPrevented || e.isComposing) return;
  // Settings, Hotkeys is recording a key: it is not a command.
  if (e.target instanceof HTMLElement && e.target.closest('[data-hotkey-recorder]')) return;
  const spec = eventSpec(e);
  if (!spec) return;
  const ctx = { activePath: activePath() };
  const overrides = hotkeyOverrides();
  // A default key the editor binds itself (editorHotkey) is left to the editor's keymap.
  const command = availableCommands(ctx).find((c) => effectiveHotkey(c, overrides) === spec && (c.id in overrides || !!c.hotkey));
  if (!command) return;
  // Always-global commands (and those that ask for it, such as quick add) pass through dialogs.
  const global = ALWAYS_GLOBAL.has(command.id) || command.globalHotkey === true;
  // Those and the keys this device chose run in the capture phase, before the focused widget's own
  // keys (CodeMirror would match Mod-Shift-f against its own Mod-f); the rest let focused widgets
  // (editor, explorer, dialogs) handle the key first.
  const early = global || command.id in overrides;
  if (early !== capture) return;
  // A modal dialog owns the keyboard; only the always-global hotkeys pass through it.
  const inModal = e.target instanceof HTMLElement && !!e.target.closest('[aria-modal="true"]');
  if (inModal && !global) return;
  const editing = inTextInput(e.target);
  if (!early && editing) return;
  // Where text is typed, a character typed with AltGr goes to the field.
  if (editing && isAltGrCharacter(e)) return;
  if (runCommand(command.id, ctx)) {
    e.preventDefault();
    e.stopPropagation();
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
