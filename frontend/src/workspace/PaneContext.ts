// Which pane a component renders in (DESIGN §6.38). Outside any pane (tests, embeds in sidebars)
// a component behaves as if it were in the active pane, as before tabs existed.
import { createContext, useContext } from 'react';
import { exclusiveOwner } from './model';
import { useWorkspace } from './store';

export interface PaneInfo {
  paneId: string | null;
  /** The pane the URL shows: it owns focus, the active editor, scroll requests and the page title. */
  active: boolean;
}

export const PaneContext = createContext<PaneInfo>({ paneId: null, active: true });

export function usePane(): PaneInfo {
  return useContext(PaneContext);
}

export function usePaneActive(): boolean {
  return useContext(PaneContext).active;
}

/**
 * Whether this pane shows `path` for a view that cannot share its file with another pane (one that
 * keeps its own model: spreadsheets, drawings, canvases, encrypted notes). Only one pane does: the
 * active one, else the first in layout order.
 */
export function useExclusiveOwner(path: string): boolean {
  const { paneId } = usePane();
  return useWorkspace((s) => paneId === null || (exclusiveOwner(s.ws, path) ?? paneId) === paneId);
}
