import { useEffect } from 'react';

/** Sets the browser tab title for an app page. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Notes`;
  }, [title]);
}
