import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFS_KEY } from './prefs';

async function freshPrefs() {
  vi.resetModules();
  return (await import('./prefs')).usePrefs;
}

afterEach(() => {
  localStorage.clear();
});

describe('Live Preview syntax visibility (per device, ROADMAP 10a)', () => {
  it('hides all markup by default', async () => {
    expect((await freshPrefs()).getState().syntaxVisibility).toBe('hide-all');
  });

  it('is stored with the other preferences of this device', async () => {
    const prefs = await freshPrefs();
    prefs.getState().update({ syntaxVisibility: 'reveal-at-cursor' });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ syntaxVisibility: 'reveal-at-cursor', theme: 'dark' });
    expect((await freshPrefs()).getState().syntaxVisibility).toBe('reveal-at-cursor');
  });

  it('falls back to hide-all for an unknown stored value', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ syntaxVisibility: 'sometimes' }));
    expect((await freshPrefs()).getState().syntaxVisibility).toBe('hide-all');
  });
});
