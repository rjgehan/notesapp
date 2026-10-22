// Locks unlocked encrypted notes after a quiet period, and optionally when the app is hidden
// (DESIGN §6.33). Activity is any key, pointer or wheel input in the page; the clock only runs
// while some key is unlocked.
import { usePrefs } from '../../state/prefs';
import { toast } from '../../state/toasts';
import { isUnlocked, lock, subscribeKeys } from './keyring';

const CHECK_MS = 5_000;

let lastActivity = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
let installed = false;

export function noteActivity(now = Date.now()): void {
  lastActivity = now;
}

/** Locks when the idle limit has passed; returns whether it did. Exported for tests. */
export function checkIdle(now = Date.now()): boolean {
  if (!isUnlocked()) return false;
  const limit = usePrefs.getState().encryptionLockMinutes * 60_000;
  if (now - lastActivity < limit) return false;
  lock();
  toast('Encrypted notes locked after inactivity');
  return true;
}

function sync(): void {
  if (isUnlocked() && !timer) {
    noteActivity();
    timer = setInterval(() => checkIdle(), CHECK_MS);
  } else if (!isUnlocked() && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function installAutoLock(): void {
  if (installed) return;
  installed = true;
  const active = () => noteActivity();
  for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(type, active, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (usePrefs.getState().encryptionLockOnHide && isUnlocked()) lock();
    } else {
      // A device that slept past the limit locks as soon as it is looked at again.
      checkIdle();
    }
  });
  subscribeKeys(sync);
  sync();
}
