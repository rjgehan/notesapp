// Cache patches shared by own mutations (HTTP responses) and SSE events (DESIGN §6.3).
// Every patch is idempotent: applying the same entry twice changes nothing.
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, FolderEntry, TextFile, TreeResponse, WriteResult } from '../api/types';
import { kindOfPath } from '../features/fileKinds';
import { basenameOf, extensionOf, folderOf, lastSegment, rebasePath } from '../features/paths';

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const byLowerPath = (a: { path: string }, b: { path: string }) => {
  const la = a.path.toLowerCase();
  const lb = b.path.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : byPath(a, b);
};

let patches = 0;

/**
 * Counts the patches applied to ['tree']. A tree fetch that overlaps a patch (an own mutation
 * answered while a resync's GET /api/tree was running) fetches again, since its snapshot may
 * predate the mutation and would silently undo it (hooks.refetchTree).
 */
export function treePatchCount(): number {
  return patches;
}

function patchTree(qc: QueryClient, fn: (tree: TreeResponse) => TreeResponse | null): void {
  const tree = qc.getQueryData<TreeResponse>(queryKeys.tree());
  if (!tree) return;
  const next = fn(tree);
  if (next && next !== tree) {
    patches++;
    qc.setQueryData(queryKeys.tree(), next);
  }
}

/** All folders implied by `paths` (each path's ancestors included), outermost first. */
function withAncestors(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    let f = p;
    while (f !== '') {
      out.add(f);
      f = folderOf(f);
    }
  }
  return [...out];
}

export function addFolders(qc: QueryClient, paths: string[]): void {
  if (paths.length === 0) return;
  patchTree(qc, (tree) => {
    const have = new Set(tree.folders.map((f) => f.path));
    const added: FolderEntry[] = [];
    for (const p of withAncestors(paths)) {
      if (!have.has(p)) {
        have.add(p);
        added.push({ path: p, name: lastSegment(p) });
      }
    }
    if (added.length === 0) return tree;
    return { ...tree, folders: [...tree.folders, ...added].sort(byLowerPath) };
  });
}

export function upsertFiles(qc: QueryClient, entries: FileEntry[]): void {
  if (entries.length === 0) return;
  patchTree(qc, (tree) => {
    const map = new Map(tree.files.map((f) => [f.path, f]));
    let changed = false;
    for (const e of entries) {
      const old = map.get(e.path);
      if (!old || !sameEntry(old, e)) {
        map.set(e.path, e);
        changed = true;
      }
    }
    if (!changed) return tree;
    return { ...tree, files: [...map.values()].sort(byPath) };
  });
  addFolders(
    qc,
    entries.map((e) => folderOf(e.path)).filter((f) => f !== ''),
  );
}

function sameEntry(a: FileEntry, b: FileEntry): boolean {
  return (
    a.version === b.version &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.kind === b.kind &&
    a.aliases.length === b.aliases.length &&
    a.aliases.every((x, i) => x === b.aliases[i])
  );
}

export function removeFile(qc: QueryClient, path: string): void {
  patchTree(qc, (tree) => {
    if (!tree.files.some((f) => f.path === path)) return tree;
    return { ...tree, files: tree.files.filter((f) => f.path !== path) };
  });
  qc.removeQueries({ queryKey: queryKeys.file(path), exact: true });
}

/** Removes a folder and everything below it; returns the removed file paths. */
export function removeFolder(qc: QueryClient, path: string): string[] {
  const removed: string[] = [];
  patchTree(qc, (tree) => {
    const prefix = path + '/';
    const files = tree.files.filter((f) => {
      const inside = f.path.startsWith(prefix);
      if (inside) removed.push(f.path);
      return !inside;
    });
    const folders = tree.folders.filter((f) => f.path !== path && !f.path.startsWith(prefix));
    if (files.length === tree.files.length && folders.length === tree.folders.length) return tree;
    return { ...tree, files, folders };
  });
  for (const p of removed) qc.removeQueries({ queryKey: queryKeys.file(p), exact: true });
  return removed;
}

/** Re-keys a moved file or folder (and its descendants). Returns the moved file paths as [from, to]. */
export function moveEntry(qc: QueryClient, from: string, to: string, type: 'file' | 'folder'): Array<[string, string]> {
  const moved: Array<[string, string]> = [];
  patchTree(qc, (tree) => {
    let changed = false;
    const files = tree.files.map((f) => {
      const next = type === 'file' ? (f.path === from ? to : null) : rebasePath(f.path, from, to);
      if (next === null || next === f.path) return f;
      changed = true;
      moved.push([f.path, next]);
      return entryAtPath(f, next);
    });
    let folders = tree.folders;
    if (type === 'folder') {
      folders = tree.folders.map((d) => {
        const next = rebasePath(d.path, from, to);
        if (next === null || next === d.path) return d;
        changed = true;
        return { path: next, name: lastSegment(next) };
      });
    }
    if (!changed) return tree;
    return { ...tree, files: files.sort(byPath), folders: folders.sort(byLowerPath) };
  });
  const parent = folderOf(to);
  if (parent) addFolders(qc, [parent]);
  for (const [oldPath] of moved) qc.removeQueries({ queryKey: queryKeys.file(oldPath), exact: true });
  return moved;
}

export function setFileVersion(qc: QueryClient, path: string, version: string): void {
  patchTree(qc, (tree) => {
    const i = tree.files.findIndex((f) => f.path === path);
    if (i < 0 || tree.files[i].version === version) return tree;
    const files = tree.files.slice();
    files[i] = { ...files[i], version };
    return { ...tree, files };
  });
}

/**
 * The content of `path` changed on the server: its `['file', path]` copy (embeds, previews) must
 * not stay stale, whether or not the note has a session in this tab (sessions live for the
 * page's lifetime). An observed copy refetches now; an unobserved one is dropped.
 */
export function refreshFileQuery(qc: QueryClient, path: string): void {
  const queryKey = queryKeys.file(path);
  const query = qc.getQueryCache().find({ queryKey, exact: true });
  if (!query) return;
  if (query.getObserversCount() > 0) void qc.invalidateQueries({ queryKey, exact: true });
  else qc.removeQueries({ queryKey, exact: true });
}

/** The invalidations that follow any content change of `path` (own or remote). */
export function invalidateContentQueries(qc: QueryClient, path: string): void {
  void qc.invalidateQueries({ queryKey: queryKeys.meta(path) });
  void qc.invalidateQueries({ queryKey: queryKeys.tags() });
  void qc.invalidateQueries({ queryKey: queryKeys.backlinksAll() });
  void qc.invalidateQueries({ queryKey: queryKeys.searchAll() });
}

let onCreated: ((path: string) => void) | null = null;

/** Told about every file this tab created (the client move map forgets moves away from it). */
export function setCreatedListener(fn: ((path: string) => void) | null): void {
  onCreated = fn;
}

/** A file was created at `path` (own create, restore, or another device's `file.created`). */
export function fileCreated(path: string): void {
  onCreated?.(path);
}

/** Own `WriteResult` (create or save): DESIGN §6.3 "Own mutations". */
export function applyWriteResult(qc: QueryClient, result: WriteResult, content?: string): void {
  if (result.created) fileCreated(result.file.path);
  addFolders(qc, result.createdFolders);
  upsertFiles(qc, [result.file]);
  const f = result.file;
  if (content !== undefined && f.version !== null && (f.kind === 'note' || f.kind === 'text')) {
    const file: TextFile = { path: f.path, kind: f.kind, content, version: f.version, size: f.size, mtime: f.mtime, lossy: false };
    qc.setQueryData(queryKeys.file(f.path), file);
  }
  invalidateContentQueries(qc, f.path);
}

/** A moved file's entry: name, basename and extension follow the new path (the kind, if it changed). */
export function entryAtPath(f: FileEntry, path: string): FileEntry {
  const extension = extensionOf(path);
  return {
    ...f,
    path,
    name: lastSegment(path),
    basename: basenameOf(path),
    extension,
    kind: extension === f.extension ? f.kind : kindOfPath(path),
  };
}
