// UI-only state (DESIGN §6.3). Server state lives in TanStack Query; editing state in DocumentSession.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ConnectionState = 'live' | 'reconnecting' | 'offline';
export type SaveSummary = 'saved' | 'saving' | 'unsaved' | 'offline' | 'storage-error' | 'conflict';
/**
 * How a file shows (DESIGN §6.6.1, §6.8). Notes: `live` (Live Preview, rendered and editable:
 * how every note opens) and `source` (the Markdown source, a troubleshooting escape hatch that is
 * never remembered across reloads). Other views use `edit` and `read`.
 */
export type ViewMode = 'live' | 'source' | 'read' | 'edit';
/** The modes of a note. */
export type NoteMode = Exclude<ViewMode, 'edit' | 'read'>;
export type ExplorerSort = 'name' | 'mtime';
/** The topmost modal overlay; later work packages add their own ids. */
export type OverlayId = string;

export interface UiState {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  leftTab: string;
  rightTab: string;
  /** Desktop search panel query: never part of the route (DESIGN §6.4). */
  searchQuery: string;
  /** Bumped to focus the search field (Mod-Shift-F with the panel already open). */
  searchFocus: number;
  /** The entry the Move dialog is open for. */
  moveTarget: { path: string; type: 'file' | 'folder' } | null;
  overlay: OverlayId | null;
  drawerOpen: boolean;
  sheetOpen: boolean;
  connection: ConnectionState;
  caughtUp: boolean;
  saveSummary: SaveSummary;
  newBuildAvailable: boolean;
  draftsFailing: boolean;
  /**
   * The notes shown as Markdown source in this page load (never saved, so a reload shows every
   * note in Live Preview again); they follow renames and moves. Any other note shows `live`.
   */
  noteModes: Record<string, 'source'>;
  explorerSort: ExplorerSort;
  expanded: Record<string, boolean>;
  /** Path to reveal (scroll into view and select) in the explorer. */
  revealPath: string | null;

  setLeftOpen(open: boolean): void;
  setRightOpen(open: boolean): void;
  toggleLeft(): void;
  toggleRight(): void;
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
  setLeftTab(id: string): void;
  setRightTab(id: string): void;
  setSearchQuery(q: string): void;
  requestSearchFocus(): void;
  setMoveTarget(target: { path: string; type: 'file' | 'folder' } | null): void;
  setOverlay(id: OverlayId | null): void;
  setDrawerOpen(open: boolean): void;
  setSheetOpen(open: boolean): void;
  setConnection(state: ConnectionState): void;
  setCaughtUp(caughtUp: boolean): void;
  setSaveSummary(summary: SaveSummary): void;
  setNewBuildAvailable(v: boolean): void;
  setDraftsFailing(v: boolean): void;
  /** Shows `path` as Markdown source (`source`), or in Live Preview again (anything else). */
  setNoteMode(path: string, mode: ViewMode | null): void;
  setExplorerSort(sort: ExplorerSort): void;
  setExpanded(path: string, expanded: boolean): void;
  setRevealPath(path: string | null): void;
  /** Expands the ancestors of `path` in the explorer and selects it. */
  revealInExplorer(path: string): void;
  /** Keeps expanded folders expanded after a folder move. */
  rekeyExpanded(from: string, to: string): void;
  /** Keeps the modes chosen for a moved file, or for a moved folder's files. */
  rekeyNoteModes(from: string, to: string): void;
}

/** `path` after moving `from` to `to` (a file, or a folder and everything under it). */
function rebased(path: string, from: string, to: string): string {
  return path === from ? to : path.startsWith(from + '/') ? to + path.slice(from.length) : path;
}

/** A stored UI state without the keys that once held note modes (`noteModes`, `editingNew`). */
export function stripNoteModes(persisted: unknown): Record<string, unknown> {
  if (!persisted || typeof persisted !== 'object') return {};
  const rest: Record<string, unknown> = { ...(persisted as Record<string, unknown>) };
  delete rest.noteModes;
  delete rest.editingNew;
  return rest;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const LEFT_WIDTH = { min: 200, max: 480, default: 280 };
export const RIGHT_WIDTH = { min: 220, max: 520, default: 300 };

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      leftOpen: true,
      rightOpen: true,
      leftWidth: LEFT_WIDTH.default,
      rightWidth: RIGHT_WIDTH.default,
      leftTab: 'files',
      rightTab: 'outline',
      searchQuery: '',
      searchFocus: 0,
      moveTarget: null,
      overlay: null,
      drawerOpen: false,
      sheetOpen: false,
      connection: 'live',
      caughtUp: true,
      saveSummary: 'saved',
      newBuildAvailable: false,
      draftsFailing: false,
      noteModes: {},
      explorerSort: 'name',
      expanded: {},
      revealPath: null,

      setLeftOpen: (leftOpen) => set({ leftOpen }),
      setRightOpen: (rightOpen) => set({ rightOpen }),
      toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
      toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
      setLeftWidth: (px) => set({ leftWidth: clamp(px, LEFT_WIDTH.min, LEFT_WIDTH.max) }),
      setRightWidth: (px) => set({ rightWidth: clamp(px, RIGHT_WIDTH.min, RIGHT_WIDTH.max) }),
      setLeftTab: (leftTab) => set({ leftTab }),
      setRightTab: (rightTab) => set({ rightTab }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      requestSearchFocus: () => set((s) => ({ searchFocus: s.searchFocus + 1 })),
      setMoveTarget: (moveTarget) => set({ moveTarget }),
      setOverlay: (overlay) => set({ overlay }),
      setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
      setSheetOpen: (sheetOpen) => set({ sheetOpen }),
      setConnection: (connection) => set({ connection }),
      setCaughtUp: (caughtUp) => set({ caughtUp }),
      setSaveSummary: (saveSummary) => set({ saveSummary }),
      setNewBuildAvailable: (newBuildAvailable) => set({ newBuildAvailable }),
      setDraftsFailing: (draftsFailing) => set({ draftsFailing }),
      setNoteMode: (path, mode) =>
        set((s) => {
          const next = mode === 'source' ? 'source' : null;
          if ((s.noteModes[path] ?? null) === next) return {};
          const noteModes = { ...s.noteModes };
          if (next === null) delete noteModes[path];
          else noteModes[path] = next;
          return { noteModes };
        }),
      setExplorerSort: (explorerSort) => set({ explorerSort }),
      setExpanded: (path, expanded) =>
        set((s) => {
          const next = { ...s.expanded };
          if (expanded) next[path] = true;
          else delete next[path];
          return { expanded: next };
        }),
      setRevealPath: (revealPath) => set({ revealPath }),
      revealInExplorer: (path) =>
        set((s) => {
          const expanded = { ...s.expanded };
          for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) expanded[path.slice(0, i)] = true;
          return { expanded, revealPath: path };
        }),
      rekeyExpanded: (from, to) =>
        set((s) => {
          let changed = false;
          const expanded: Record<string, boolean> = {};
          for (const [path, open] of Object.entries(s.expanded)) {
            const next = rebased(path, from, to);
            if (next !== path) changed = true;
            expanded[next] = open;
          }
          return changed ? { expanded } : {};
        }),
      rekeyNoteModes: (from, to) =>
        set((s) => {
          let changed = false;
          const noteModes: Record<string, 'source'> = {};
          for (const [path, mode] of Object.entries(s.noteModes)) {
            const next = rebased(path, from, to);
            if (next !== path) changed = true;
            noteModes[next] = mode;
          }
          return changed ? { noteModes } : {};
        }),
    }),
    {
      name: 'notesapp:ui',
      storage: createJSONStorage(() => localStorage),
      // Version 1 ("every note opens in Live Preview", DESIGN §6.6.1): note modes are never
      // stored. Whatever an older build left (a mode per note, a note opened for editing) is
      // dropped, so no note comes back locked or in source mode.
      version: 1,
      migrate: (persisted) => stripNoteModes(persisted) as unknown as UiState,
      merge: (persisted, current) => ({ ...current, ...(stripNoteModes(persisted) as Partial<UiState>) }),
      partialize: (s) => ({
        leftOpen: s.leftOpen,
        rightOpen: s.rightOpen,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        leftTab: s.leftTab,
        rightTab: s.rightTab,
        explorerSort: s.explorerSort,
        expanded: s.expanded,
      }),
    },
  ),
);
