// Phone < 768 px, tablet 768–1199 px, desktop ≥ 1200 px (DESIGN §6.16).
import { useSyncExternalStore } from 'react';

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

const PHONE = '(max-width: 767px)';
const DESKTOP = '(min-width: 1200px)';

function current(): Breakpoint {
  if (typeof window.matchMedia !== 'function') return 'desktop';
  if (window.matchMedia(PHONE).matches) return 'phone';
  if (window.matchMedia(DESKTOP).matches) return 'desktop';
  return 'tablet';
}

function subscribe(fn: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const queries = [window.matchMedia(PHONE), window.matchMedia(DESKTOP)];
  for (const q of queries) q.addEventListener('change', fn);
  return () => {
    for (const q of queries) q.removeEventListener('change', fn);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current);
}

export function currentBreakpoint(): Breakpoint {
  return current();
}
