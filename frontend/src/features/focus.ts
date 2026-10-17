// Focus after navigation (DESIGN §6.19): a keyboard-initiated navigation moves focus into the
// note (editor or reading view); a pointer navigation announces the note's name and moves focus
// to the workspace, so it never stays stranded on the control that opened a closed overlay.
import { create } from 'zustand';
import { displayName } from './paths';

/** A request expires, so a view that mounts much later (a slow lazy chunk) does not steal focus. */
const REQUEST_TTL_MS = 5000;
let focusUntil = 0;
let clearScheduled = false;

/** The next note view to mount takes the keyboard focus. */
export function requestNoteFocus(): void {
  focusUntil = Date.now() + REQUEST_TTL_MS;
}

/** Withdraws a pending request (the navigation it was made for did not happen). */
export function cancelNoteFocus(): void {
  focusUntil = 0;
}

/**
 * True when a note view mounting now should take the focus. The request stays valid until the
 * current task ends, so a StrictMode remount (which recreates the editor) focuses too.
 */
export function wantsNoteFocus(): boolean {
  if (Date.now() >= focusUntil) return false;
  if (!clearScheduled) {
    clearScheduled = true;
    setTimeout(() => {
      focusUntil = 0;
      clearScheduled = false;
    }, 0);
  }
  return true;
}

interface FocusState {
  /** Live-region message, and a counter so repeating the same message is announced again. */
  message: string;
  seq: number;
  /** Bumped to move focus to the workspace (a pointer navigation). */
  workspace: number;
}

export const useFocusRequests = create<FocusState>()(() => ({ message: '', seq: 0, workspace: 0 }));

/** Speaks `message` through the app's polite live region. */
export function announce(message: string): void {
  useFocusRequests.setState((s) => ({ message, seq: s.seq + 1 }));
}

/** After opening `path`: focus for keyboard users, an announcement for pointer users. */
export function afterOpen(path: string, viaKeyboard: boolean): void {
  if (viaKeyboard) {
    requestNoteFocus();
    return;
  }
  announce(`Opened ${displayName(path)}`);
  useFocusRequests.setState((s) => ({ workspace: s.workspace + 1 }));
}

/** A click produced by Enter or Space on a button has no pointer details (`detail` is 0). */
export function isKeyboardClick(e: { detail: number }): boolean {
  return e.detail === 0;
}

/**
 * Returns focus to `previous` when an overlay closes, unless something outside `container` has
 * deliberately taken the focus meanwhile (a command that focused the inline title, a note view
 * that focused its editor).
 */
export function returnFocus(previous: HTMLElement | null, container: HTMLElement | null): void {
  if (!previous || !previous.isConnected || previous === document.body) return;
  const active = document.activeElement;
  if (active && active !== document.body && !(container?.contains(active) ?? false)) return;
  previous.focus({ preventScroll: true });
}

// ---------- input modality ----------

let lastInput: 'keyboard' | 'pointer' = 'pointer';

/** Tracks whether the last interaction was a key press or a pointer (for keyboard-only hints). */
export function installInputModality(): () => void {
  const onKey = () => {
    lastInput = 'keyboard';
  };
  const onPointer = () => {
    lastInput = 'pointer';
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointer, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onPointer, true);
  };
}

export function lastInputWasKeyboard(): boolean {
  return lastInput === 'keyboard';
}
