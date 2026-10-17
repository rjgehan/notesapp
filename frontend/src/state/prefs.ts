// Per-device preferences (DESIGN §5.12): not vault settings, because the phone and the PC differ.
import { create } from 'zustand';

export type ThemePref = 'dark' | 'light' | 'system';
/** Markdown markup in Live Preview (DESIGN §6.6.1): always hidden, or shown for the element at the cursor. */
export type SyntaxVisibility = 'hide-all' | 'reveal-at-cursor';

export interface Prefs {
  theme: ThemePref;
  spellcheck: boolean;
  autocorrect: boolean;
  loadRemoteImages: boolean;
  syntaxVisibility: SyntaxVisibility;
}

export const PREFS_KEY = 'notesapp:prefs';

export const DEFAULT_PREFS: Prefs = { theme: 'dark', spellcheck: true, autocorrect: true, loadRemoteImages: true, syntaxVisibility: 'hide-all' };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'system' || parsed.theme === 'dark' ? parsed.theme : 'dark',
      spellcheck: typeof parsed.spellcheck === 'boolean' ? parsed.spellcheck : true,
      autocorrect: typeof parsed.autocorrect === 'boolean' ? parsed.autocorrect : true,
      loadRemoteImages: typeof parsed.loadRemoteImages === 'boolean' ? parsed.loadRemoteImages : true,
      syntaxVisibility: parsed.syntaxVisibility === 'reveal-at-cursor' ? 'reveal-at-cursor' : 'hide-all',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

interface PrefsState extends Prefs {
  update(patch: Partial<Prefs>): void;
}

export const usePrefs = create<PrefsState>()((set, get) => ({
  ...load(),
  update(patch) {
    set(patch);
    const { theme, spellcheck, autocorrect, loadRemoteImages, syntaxVisibility } = get();
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme, spellcheck, autocorrect, loadRemoteImages, syntaxVisibility }));
    } catch {
      // Private mode or quota: the preference still applies to this page load.
    }
    if (patch.theme) applyTheme();
  },
}));

export function resolvedTheme(pref: ThemePref = usePrefs.getState().theme): 'dark' | 'light' {
  if (pref === 'system') {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return pref;
}

/** Same three updates as public/theme-boot.js, at runtime. */
export function applyTheme(): void {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#1e1e1e');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'light' ? 'light dark' : 'dark light');
}

/** Follows the OS theme while the preference is `system`. */
export function installThemeListener(): void {
  if (typeof window.matchMedia !== 'function') return;
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (usePrefs.getState().theme === 'system') applyTheme();
  });
}

export function toggleTheme(): void {
  usePrefs.getState().update({ theme: resolvedTheme() === 'dark' ? 'light' : 'dark' });
}
