import { createContext, useContext } from 'react';

/** The workspace's single scroll container (DESIGN §6.16), for scroll mapping and restoration. */
export const WorkspaceScrollContext = createContext<{ current: HTMLDivElement | null }>({ current: null });

export function useWorkspaceScroller(): { current: HTMLDivElement | null } {
  return useContext(WorkspaceScrollContext);
}
