// The app theme as drawings see it: `data-theme` on <html>, which also follows the OS in "system".
import { useSyncExternalStore } from 'react';

function subscribeTheme(fn: () => void): () => void {
  const observer = new MutationObserver(fn);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function useAppTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeTheme, currentTheme);
}
