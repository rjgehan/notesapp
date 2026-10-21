// How each list is shown on this device: as a list, or as a board grouped by section or by
// status. A per-device convenience (like the theme), so it lives in localStorage; without
// storage every list simply opens as a list.
import { useState } from 'react';

export type ListLayout = 'list' | 'board-section' | 'board-status';

const KEY = 'notesapp:tasks:layout';
const LAYOUTS: readonly ListLayout[] = ['list', 'board-section', 'board-status'];

function read(): Record<string, ListLayout> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ListLayout>) : {};
  } catch {
    return {};
  }
}

export function listLayout(listId: string): ListLayout {
  const value = read()[listId];
  return LAYOUTS.includes(value) ? value : 'list';
}

export function setListLayout(listId: string, layout: ListLayout): void {
  try {
    const all = read();
    if (layout === 'list') delete all[listId];
    else all[listId] = layout;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode or quota: the choice holds for this page only.
  }
}

/** The layout of a list, remembered on this device. */
export function useListLayout(listId: string): [ListLayout, (layout: ListLayout) => void] {
  const [state, setState] = useState(() => ({ listId, layout: listLayout(listId) }));
  const current = state.listId === listId ? state.layout : listLayout(listId);
  if (state.listId !== listId) setState({ listId, layout: current });
  return [
    current,
    (layout) => {
      setListLayout(listId, layout);
      setState({ listId, layout });
    },
  ];
}
