// Offline copies of recently opened notes and of the tree (DESIGN §6.21). Copies are only ever a
// fallback for *opening* a note while the server is unreachable: a session that opened one keeps
// the copy's version as its base, so an edit made offline is saved with that base and the server's
// version check decides (API.md §4). A stale copy can therefore cause a conflict banner, never an
// overwrite.
import type { FileEntry, TextFile, TreeResponse } from '../api/types';
import { done, META, NOTES, openOfflineDb, request } from './db';

/** At most this many notes, and this many bytes of text; the least recently opened go first. */
export const MAX_NOTES = 100;
export const MAX_TOTAL_CHARS = 20_000_000;
/** A larger note is not kept offline. */
export const MAX_NOTE_CHARS = 2_000_000;

export interface CachedNote {
  path: string;
  file: TextFile;
  /** Last opened on this device (epoch ms). */
  at: number;
  /** When the copy was read from the server or saved (epoch ms). */
  storedAt: number;
}

export interface CachedTree {
  key: 'tree';
  tree: TreeResponse;
  at: number;
}

export interface CacheIndexEntry {
  path: string;
  version: string;
  at: number;
  chars: number;
}

export interface NoteCacheStore {
  get(path: string): Promise<CachedNote | null>;
  /** Stores a copy. `touch` marks it as opened now; without it, only an existing copy is refreshed. */
  put(file: TextFile, touch: boolean, now?: number): Promise<void>;
  remove(path: string): Promise<void>;
  rekey(from: string, to: string): Promise<void>;
  index(): Promise<CacheIndexEntry[]>;
  saveTree(tree: TreeResponse, now?: number): Promise<void>;
  loadTree(): Promise<CachedTree | null>;
  clear(): Promise<void>;
}

/** Whether a read file may be kept offline. */
export function cacheable(file: TextFile): boolean {
  return !file.lossy && file.content.length <= MAX_NOTE_CHARS;
}

/** The copies to drop so that at most MAX_NOTES and MAX_TOTAL_CHARS remain (oldest first). */
export function evictions(entries: readonly CacheIndexEntry[], maxNotes = MAX_NOTES, maxChars = MAX_TOTAL_CHARS): string[] {
  const newestFirst = [...entries].sort((a, b) => b.at - a.at);
  const out: string[] = [];
  let chars = 0;
  newestFirst.forEach((e, i) => {
    chars += e.chars;
    if (i >= maxNotes || chars > maxChars) out.push(e.path);
  });
  return out;
}

export interface MaintenancePlan {
  remove: string[];
  rekey: Array<[string, string]>;
  /** Copies older than the server's version: re-read them while online. */
  refresh: string[];
}

/**
 * Brings the copies in line with a server tree: copies of deleted notes go, copies of moved notes
 * follow (`movedTo` is the client move map), outdated copies are re-read.
 */
export function planMaintenance(
  entries: readonly CacheIndexEntry[],
  files: ReadonlyMap<string, Pick<FileEntry, 'version'>>,
  movedTo: (path: string) => string | null,
): MaintenancePlan {
  const plan: MaintenancePlan = { remove: [], rekey: [], refresh: [] };
  const cached = new Set(entries.map((e) => e.path));
  for (const e of entries) {
    const entry = files.get(e.path);
    if (entry) {
      if (entry.version !== null && entry.version !== e.version) plan.refresh.push(e.path);
      continue;
    }
    const to = movedTo(e.path);
    if (to && to !== e.path && files.has(to) && !cached.has(to)) {
      plan.rekey.push([e.path, to]);
      cached.add(to);
      if (files.get(to)!.version !== e.version) plan.refresh.push(to);
    } else {
      plan.remove.push(e.path);
    }
  }
  return plan;
}

export class IdbNoteCache implements NoteCacheStore {
  private db: Promise<IDBDatabase> | null = null;
  /**
   * What is stored, without the texts: read once per page, then kept up to date, so evictions never
   * read every copy again on a save. Another tab's writes are not seen; eviction is best effort.
   */
  private meta: Promise<Map<string, CacheIndexEntry>> | null = null;
  private readonly factory: IDBFactory;
  private readonly name: string | undefined;

  constructor(factory: IDBFactory = indexedDB, name?: string) {
    this.factory = factory;
    this.name = name;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      const reset = () => {
        this.db = null;
      };
      this.db = openOfflineDb(this.factory, this.name, reset);
      this.db.catch(reset);
    }
    return this.db;
  }

  async get(path: string): Promise<CachedNote | null> {
    const db = await this.open();
    const tx = db.transaction(NOTES, 'readonly');
    return (await request(tx.objectStore(NOTES).get(path) as IDBRequest<CachedNote | undefined>)) ?? null;
  }

  private loadMeta(): Promise<Map<string, CacheIndexEntry>> {
    if (!this.meta) {
      this.meta = (async () => {
        const db = await this.open();
        const tx = db.transaction(NOTES, 'readonly');
        const all = await request(tx.objectStore(NOTES).getAll() as IDBRequest<CachedNote[]>);
        return new Map(all.map((n) => [n.path, entryOf(n)]));
      })();
      this.meta.catch(() => {
        this.meta = null;
      });
    }
    return this.meta;
  }

  async put(file: TextFile, touch: boolean, now = Date.now()): Promise<void> {
    if (!cacheable(file)) {
      await this.remove(file.path);
      return;
    }
    const meta = await this.loadMeta();
    const db = await this.open();
    const tx = db.transaction(NOTES, 'readwrite');
    const store = tx.objectStore(NOTES);
    const existing = store.get(file.path) as IDBRequest<CachedNote | undefined>;
    let written: CachedNote | null = null;
    existing.onsuccess = () => {
      const prev = existing.result;
      if (!prev && !touch) return;
      written = { path: file.path, file, at: touch || !prev ? now : prev.at, storedAt: now };
      store.put(written);
    };
    await done(tx);
    if (written) meta.set(file.path, entryOf(written));
    if (touch) await this.prune(meta);
  }

  async remove(path: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(NOTES, 'readwrite');
    tx.objectStore(NOTES).delete(path);
    await done(tx);
    (await this.loadMeta().catch(() => null))?.delete(path);
  }

  async rekey(from: string, to: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(NOTES, 'readwrite');
    const store = tx.objectStore(NOTES);
    const get = store.get(from) as IDBRequest<CachedNote | undefined>;
    let moved: CachedNote | null = null;
    get.onsuccess = () => {
      const note = get.result;
      if (!note) return;
      moved = { ...note, path: to, file: { ...note.file, path: to } };
      store.delete(from);
      store.put(moved);
    };
    await done(tx);
    const meta = await this.loadMeta().catch(() => null);
    meta?.delete(from);
    if (moved) meta?.set(to, entryOf(moved));
  }

  async index(): Promise<CacheIndexEntry[]> {
    return [...(await this.loadMeta()).values()];
  }

  private async prune(meta: Map<string, CacheIndexEntry>): Promise<void> {
    const drop = evictions([...meta.values()]);
    if (drop.length === 0) return;
    const db = await this.open();
    const tx = db.transaction(NOTES, 'readwrite');
    for (const path of drop) tx.objectStore(NOTES).delete(path);
    await done(tx);
    for (const path of drop) meta.delete(path);
  }

  async saveTree(tree: TreeResponse, now = Date.now()): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ key: 'tree', tree, at: now } satisfies CachedTree);
    await done(tx);
  }

  async loadTree(): Promise<CachedTree | null> {
    const db = await this.open();
    const tx = db.transaction(META, 'readonly');
    return (await request(tx.objectStore(META).get('tree') as IDBRequest<CachedTree | undefined>)) ?? null;
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([NOTES, META], 'readwrite');
    tx.objectStore(NOTES).clear();
    tx.objectStore(META).clear();
    await done(tx);
    this.meta = Promise.resolve(new Map());
  }
}

function entryOf(n: CachedNote): CacheIndexEntry {
  return { path: n.path, version: n.file.version, at: n.at, chars: n.file.content.length };
}

/** IndexedDB missing (old private modes): nothing is kept, and reads find nothing. */
export class NoNoteCache implements NoteCacheStore {
  get = () => Promise.resolve(null);
  put = () => Promise.resolve();
  remove = () => Promise.resolve();
  rekey = () => Promise.resolve();
  index = () => Promise.resolve([]);
  saveTree = () => Promise.resolve();
  loadTree = () => Promise.resolve(null);
  clear = () => Promise.resolve();
}
