// UI state of the tasks feature: the quick-add dialog and the task detail sheet, which open from
// pages, the note panel, the palette and the hotkey, and render in the shell's overlay host.
import { create } from 'zustand';
import { navigateTo } from '../../features/navigation';
import { noteRoute } from '../../features/paths';
import type { TaskDate } from '../../api/types';

/** Where a task added by quick add goes, and what it starts with. */
export interface QuickAddContext {
  listId?: string;
  sectionId?: string | null;
  /** A subtask of this task (its list is the parent's). */
  parentId?: string;
  /** Shown as a chip that can be dismissed (the Today page adds today). */
  due?: TaskDate;
  /** Related notes (the note panel links the open note). */
  links?: string[];
  /** Text to start with (a failed save gives it back). */
  text?: string;
}

interface TaskUiState {
  quickAdd: QuickAddContext | null;
  /** Counts openings, so a dialog opened again (with other text) starts afresh. */
  quickAddSeq: number;
  detailId: string | null;
  /** The list whose color is being chosen. */
  colorListId: string | null;
  openQuickAdd(context?: QuickAddContext): void;
  closeQuickAdd(): void;
  openDetail(id: string): void;
  closeDetail(): void;
  openListColor(listId: string): void;
  closeListColor(): void;
}

export const useTaskUi = create<TaskUiState>()((set) => ({
  quickAdd: null,
  quickAddSeq: 0,
  detailId: null,
  colorListId: null,
  openQuickAdd: (context = {}) => set((s) => ({ quickAdd: context, quickAddSeq: s.quickAddSeq + 1, detailId: null })),
  closeQuickAdd: () => set({ quickAdd: null }),
  openDetail: (detailId) => set({ detailId, quickAdd: null }),
  closeDetail: () => set({ detailId: null }),
  openListColor: (colorListId) => set({ colorListId }),
  closeListColor: () => set({ colorListId: null }),
}));

export function openQuickAdd(context?: QuickAddContext): void {
  useTaskUi.getState().openQuickAdd(context);
}

export function openTaskDetail(id: string): void {
  useTaskUi.getState().openDetail(id);
}

export function openListColor(listId: string): void {
  useTaskUi.getState().openListColor(listId);
}

/** The route of a list's page. */
export function listRoute(listId: string): string {
  return `/x/tasks/list/${encodeURIComponent(listId)}`;
}

/** Opens a list's file as its source (the JSON), rather than as the list. */
export function openListSource(path: string): void {
  navigateTo(noteRoute(path) + '?view=source');
}
