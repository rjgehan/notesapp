import { describe, expect, it, vi } from 'vitest';
import { PREFS_KEY } from './prefs';

async function loadWith(stored: unknown) {
  vi.resetModules();
  localStorage.setItem(PREFS_KEY, JSON.stringify(stored));
  return (await import('./prefs')).usePrefs.getState();
}

describe('per-device preferences', () => {
  it('reads vim mode from this device, off unless it is exactly true', async () => {
    expect((await loadWith({ vimMode: true })).vimMode).toBe(true);
    expect((await loadWith({ vimMode: 'yes' })).vimMode).toBe(false);
    expect((await loadWith({ theme: 'light' })).vimMode).toBe(false);
  });
});
