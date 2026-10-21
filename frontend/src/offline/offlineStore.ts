// Offline reading (DESIGN §6.21): the device's copies of recently opened notes and of the tree,
// and the UI state that says when the app is showing them. Kept free of the sync layer so the
// document registry can use it (sync/instance.ts); offlineSync.ts does the upkeep.
import { create } from 'zustand';
import { isTransient } from '../api/client';
import { api } from '../api/endpoints';
import type { TextFile, TreeResponse, WriteResult } from '../api/types';
import { usePrefs } from '../state/prefs';
import { IdbNoteCache, NoNoteCache, type CachedTree, type NoteCacheStore } from './noteCache';

export interface OfflineState {
  /** Notes this page opened from the device's copy (path → when the copy was stored). */
  servedOffline: Record<string, number>;
  /** The tree is the device's snapshot from this time: the server was unreachable at startup. */
  treeSnapshotAt: number | null;
  /** Notes whose edits made offline wait for the conflict banner (DESIGN §6.21). */
  review: string[];
  markServed(path: string, storedAt: number): void;
  clearServed(): void;
  setTreeSnapshotAt(at: number | null): void;
  setReview(paths: string[]): void;
  dismissReview(path: string): void;
}

export const useOffline = create<OfflineState>()((set) => ({
  servedOffline: {},
  treeSnapshotAt: null,
  review: [],
  markServed: (path, storedAt) => set((s) => ({ servedOffline: { ...s.servedOffline, [path]: storedAt } })),
  clearServed: () => set({ servedOffline: {} }),
  setTreeSnapshotAt: (treeSnapshotAt) => set({ treeSnapshotAt }),
  setReview: (review) => set({ review }),
  dismissReview: (path) => set((s) => ({ review: s.review.filter((p) => p !== path) })),
}));

export const noteCache: NoteCacheStore = typeof indexedDB === 'undefined' ? new NoNoteCache() : new IdbNoteCache();

/** The device keeps copies for offline reading (Settings › This device; on by default). */
export function offlineCopiesEnabled(): boolean {
  return usePrefs.getState().offlineNotes;
}

function keep(file: TextFile, touch: boolean): void {
  if (!offlineCopiesEnabled()) return;
  void noteCache.put(file, touch).catch(() => undefined);
}

/**
 * Opens a note for a session: from the server, keeping a copy; when the server is unreachable,
 * from the device's copy (its version stays the session's base, API.md §4).
 */
export async function openNote(path: string): Promise<TextFile> {
  try {
    const file = await api.readFile(path);
    keep(file, true);
    return file;
  } catch (e) {
    if (!isTransient(e) || !offlineCopiesEnabled()) throw e;
    const copy = await noteCache.get(path).catch(() => null);
    if (!copy) throw e;
    useOffline.getState().markServed(path, copy.storedAt);
    return copy.file;
  }
}

/** Reads a note again for its copy (upkeep while online); never touches the open order. */
export async function refreshCopy(path: string): Promise<void> {
  keep(await api.readFile(path), false);
}

/** An own save (DESIGN §6.3): the copy follows, so reopening the note offline shows this text. */
export function noteWritten(result: WriteResult, content: string): void {
  const f = result.file;
  if (f.version === null || (f.kind !== 'note' && f.kind !== 'text')) return;
  keep({ path: f.path, kind: f.kind, content, version: f.version, size: f.size, mtime: f.mtime, lossy: false }, true);
}

/** The tree snapshot kept for an offline start; null when there is none or copies are off. */
export async function cachedTree(): Promise<CachedTree | null> {
  if (!offlineCopiesEnabled()) return null;
  return noteCache.loadTree().catch(() => null);
}

export function saveTreeSnapshot(tree: TreeResponse): void {
  if (!offlineCopiesEnabled()) return;
  void noteCache.saveTree(tree).catch(() => undefined);
}

/** Settings › This device: removes every offline copy (drafts and queued captures are kept). */
export async function clearOfflineCopies(): Promise<void> {
  await noteCache.clear();
}
