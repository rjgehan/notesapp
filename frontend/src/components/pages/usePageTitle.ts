import { useEffect } from 'react';
import { appTitle } from '../../state/vault';

/** Sets the browser tab title for an app page. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = appTitle(title);
  }, [title]);
}
