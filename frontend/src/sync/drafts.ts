// Local drafts (DESIGN §6.9): IndexedDB database `notesapp`, store `drafts` keyed by
// [path, clientId], plus `discarded` for local text the user threw away (kept 7 days).
// localStorage is not used: it is synchronous and its quota would silently disable drafts.
import type { Eol } from '../features/eol';
import { vaultKey } from '../state/vault';

export interface DraftRecord {
  path: string;
  clientId: string;
  baseVersion: string | null;
  /** Content at baseVersion, kept when the draft stays under 1 MB in total (3-way merges). */
  baseText?: string;
  /** LF-only text. */
  text: string;
  eol: Eol;
  at: number;
  /**
   * Written while a conflict was unresolved, or while a Keep mine (or Recreate) save was pending:
   * the server copy must not be overwritten without the conflict banner, so restoring the draft
   * re-enters conflict even when its base equals the server version (DESIGN §6.9).
   */
  conflict?: boolean;
}

export interface DiscardedRecord {
  id: number;
  path: string;
  text: string;
  eol: Eol;
  at: number;
  reason: 'take-theirs' | 'discard' | 'superseded-draft' | 'orphaned-draft';
}

export interface DraftStore {
  put(draft: DraftRecord): Promise<void>;
  remove(path: string, clientId: string): Promise<void>;
  listForPath(path: string): Promise<DraftRecord[]>;
  /** Every draft of every tab (orphan recovery, DESIGN §6.9). */
  listAll(): Promise<DraftRecord[]>;
  /**
   * Re-keys every draft at `from` (or below it, for folders) to `to`. A draft already stored
   * under a destination key (another note's) is moved to `discarded` first, never overwritten.
   */
  rekey(from: string, to: string): Promise<void>;
  discard(record: Omit<DiscardedRecord, 'id'>): Promise<number>;
  takeDiscarded(id: number): Promise<DiscardedRecord | null>;
  listDiscarded(): Promise<DiscardedRecord[]>;
  /** Drops drafts older than 30 days and discarded edits older than 7 days. */
  prune(now?: number): Promise<void>;
}

const DB_NAME = 'notesapp';
const DB_VERSION = 1;
const DRAFTS = 'drafts';
const DISCARDED = 'discarded';
export const DRAFT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const DISCARDED_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function rebase(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + '/')) return to + path.slice(from.length);
  return null;
}

const draftKey = (path: string, clientId: string) => JSON.stringify([path, clientId]);

/**
 * What re-keying `from` to `to` does to `drafts`: the moves, and the drafts already stored under a
 * destination key that are not moving away themselves (another note's text at that path), which
 * are kept as discarded records instead of being overwritten.
 */
export function rekeyPlan(drafts: readonly DraftRecord[], from: string, to: string): { moves: Array<[DraftRecord, DraftRecord]>; displaced: DraftRecord[] } {
  const moves: Array<[DraftRecord, DraftRecord]> = [];
  const moving = new Set<string>();
  for (const d of drafts) {
    const next = rebase(d.path, from, to);
    if (next === null || next === d.path) continue;
    moves.push([d, { ...d, path: next }]);
    moving.add(draftKey(d.path, d.clientId));
  }
  const targets = new Set(moves.map(([, n]) => draftKey(n.path, n.clientId)));
  const displaced = drafts.filter((d) => targets.has(draftKey(d.path, d.clientId)) && !moving.has(draftKey(d.path, d.clientId)));
  return { moves, displaced };
}

/** A draft that can no longer live under its key, as a recoverable discarded record. */
export function orphanRecord(d: Pick<DraftRecord, 'path' | 'text' | 'eol' | 'at'>): Omit<DiscardedRecord, 'id'> {
  return { path: d.path, text: d.text, eol: d.eol, at: d.at, reason: 'orphaned-draft' };
}

export class IdbDraftStore implements DraftStore {
  private db: Promise<IDBDatabase> | null = null;
  private readonly factory: IDBFactory;
  private readonly name: string;

  constructor(factory: IDBFactory = indexedDB, name = DB_NAME) {
    this.factory = factory;
    this.name = name;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = this.factory.open(this.name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DRAFTS)) {
            const drafts = db.createObjectStore(DRAFTS, { keyPath: ['path', 'clientId'] });
            drafts.createIndex('path', 'path');
          }
          if (!db.objectStoreNames.contains(DISCARDED)) {
            db.createObjectStore(DISCARDED, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Cannot open IndexedDB'));
        req.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
      });
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  async put(draft: DraftRecord): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(DRAFTS, 'readwrite');
    tx.objectStore(DRAFTS).put(draft);
    await done(tx);
  }

  async remove(path: string, clientId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(DRAFTS, 'readwrite');
    tx.objectStore(DRAFTS).delete([path, clientId]);
    await done(tx);
  }

  async listForPath(path: string): Promise<DraftRecord[]> {
    const db = await this.open();
    const tx = db.transaction(DRAFTS, 'readonly');
    return request(tx.objectStore(DRAFTS).index('path').getAll(path) as IDBRequest<DraftRecord[]>);
  }

  async listAll(): Promise<DraftRecord[]> {
    const db = await this.open();
    const tx = db.transaction(DRAFTS, 'readonly');
    return request(tx.objectStore(DRAFTS).getAll() as IDBRequest<DraftRecord[]>);
  }

  async rekey(from: string, to: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([DRAFTS, DISCARDED], 'readwrite');
    const store = tx.objectStore(DRAFTS);
    const discarded = tx.objectStore(DISCARDED);
    // Writes are issued from the success callback so the transaction is still active.
    const all = store.getAll() as IDBRequest<DraftRecord[]>;
    all.onsuccess = () => {
      const plan = rekeyPlan(all.result, from, to);
      for (const d of plan.displaced) discarded.add(orphanRecord(d));
      for (const [old] of plan.moves) store.delete([old.path, old.clientId]);
      for (const [, next] of plan.moves) store.put(next);
    };
    await done(tx);
  }

  async discard(record: Omit<DiscardedRecord, 'id'>): Promise<number> {
    const db = await this.open();
    const tx = db.transaction(DISCARDED, 'readwrite');
    const id = await request(tx.objectStore(DISCARDED).add(record));
    await done(tx);
    return id as number;
  }

  async takeDiscarded(id: number): Promise<DiscardedRecord | null> {
    const db = await this.open();
    const tx = db.transaction(DISCARDED, 'readwrite');
    const store = tx.objectStore(DISCARDED);
    let rec: DiscardedRecord | null = null;
    const get = store.get(id) as IDBRequest<DiscardedRecord | undefined>;
    get.onsuccess = () => {
      rec = get.result ?? null;
      if (rec) store.delete(id);
    };
    await done(tx);
    return rec;
  }

  async listDiscarded(): Promise<DiscardedRecord[]> {
    const db = await this.open();
    const tx = db.transaction(DISCARDED, 'readonly');
    const all = await request(tx.objectStore(DISCARDED).getAll() as IDBRequest<DiscardedRecord[]>);
    return all.sort((a, b) => b.at - a.at);
  }

  async prune(now = Date.now()): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([DRAFTS, DISCARDED], 'readwrite');
    const drafts = tx.objectStore(DRAFTS);
    const allDrafts = drafts.getAll() as IDBRequest<DraftRecord[]>;
    allDrafts.onsuccess = () => {
      for (const d of allDrafts.result) if (now - d.at > DRAFT_MAX_AGE_MS) drafts.delete([d.path, d.clientId]);
    };
    const discarded = tx.objectStore(DISCARDED);
    const allDiscarded = discarded.getAll() as IDBRequest<DiscardedRecord[]>;
    allDiscarded.onsuccess = () => {
      for (const d of allDiscarded.result) if (now - d.at > DISCARDED_MAX_AGE_MS) discarded.delete(d.id);
    };
    await done(tx);
  }
}

// ---------- tab coordination (BroadcastChannel 'notesapp') ----------

type TabMessage = { type: 'who-owns'; path: string; reqId: string } | { type: 'owns'; reqId: string; clientId: string };

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}

/**
 * Asks the other live tabs which of them own drafts for a path, so one tab never deletes or
 * restores a draft that another (dirty) tab still depends on.
 */
export class TabCoordinator {
  private readonly channel: ChannelLike | null;
  private readonly pending = new Map<string, Set<string>>();
  private readonly clientId: string;
  private readonly ownsPath: (path: string) => boolean;

  constructor(clientId: string, ownsPath: (path: string) => boolean, channel?: ChannelLike | null) {
    this.clientId = clientId;
    this.ownsPath = ownsPath;
    this.channel = channel !== undefined ? channel : typeof BroadcastChannel === 'function' ? new BroadcastChannel(vaultKey('notesapp')) : null;
    this.channel?.addEventListener('message', (ev) => this.onMessage(ev.data as TabMessage));
  }

  private onMessage(msg: TabMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'who-owns' && this.ownsPath(msg.path)) {
      this.channel?.postMessage({ type: 'owns', reqId: msg.reqId, clientId: this.clientId } satisfies TabMessage);
    } else if (msg.type === 'owns') {
      this.pending.get(msg.reqId)?.add(msg.clientId);
    }
  }

  /** Client ids of live tabs that own drafts for `path` (answers collected for `timeoutMs`). */
  liveOwners(path: string, timeoutMs = 150): Promise<Set<string>> {
    if (!this.channel) return Promise.resolve(new Set());
    const reqId = `${this.clientId}:${Math.random().toString(36).slice(2)}`;
    const owners = new Set<string>();
    this.pending.set(reqId, owners);
    this.channel.postMessage({ type: 'who-owns', path, reqId } satisfies TabMessage);
    return new Promise((resolve) =>
      setTimeout(() => {
        this.pending.delete(reqId);
        resolve(owners);
      }, timeoutMs),
    );
  }

  close(): void {
    this.channel?.close();
  }
}
