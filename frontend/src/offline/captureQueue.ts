// The quick-capture queue (DESIGN §6.22). A capture is stored on the device first and sent from
// there, so one made offline (or whose tab is killed mid-request) is added when the connection
// returns. Each keeps the Idempotency-Key it was made with: a retry after a lost response is
// answered with the first result instead of appending twice (API.md §2; the server remembers
// keys for an hour within one run). A capture only appends, so it can never conflict.
import { errorMessage, isStorageProblem, isTransient } from '../api/client';
import type { CaptureRequest, CaptureResult } from '../api/types';
import { CAPTURES, done, openOfflineDb, request } from './db';

export interface QueuedFile {
  name: string;
  type: string;
  blob: Blob;
}

export interface QueuedCapture {
  id?: number;
  /** The Idempotency-Key, the same for every attempt. */
  key: string;
  /** Date, time and zone fixed when the capture was made. */
  request: CaptureRequest;
  /** POST /api/capture/file when set (the request's text is the caption). */
  file?: QueuedFile | null;
  at: number;
  /** The server refused it for good (kept for Settings › Quick capture). */
  error?: string | null;
}

export interface CaptureQueueStore {
  add(items: QueuedCapture[]): Promise<number[]>;
  /** Oldest first. */
  list(): Promise<QueuedCapture[]>;
  remove(id: number): Promise<void>;
  put(item: QueuedCapture): Promise<void>;
}

export interface FlushDeps {
  store: CaptureQueueStore;
  send(item: QueuedCapture): Promise<CaptureResult>;
  onSent(result: CaptureResult, item: QueuedCapture): void;
}

export interface FlushReport {
  sent: Array<{ item: QueuedCapture; result: CaptureResult }>;
  /** Refused for good this time. */
  failed: QueuedCapture[];
  /** Still waiting for the server (offline, or a storage problem). */
  waiting: number;
}

/** Sends the waiting captures in order, until the server cannot be reached. */
export async function flushQueue(deps: FlushDeps): Promise<FlushReport> {
  const report: FlushReport = { sent: [], failed: [], waiting: 0 };
  const items = (await deps.store.list()).filter((i) => !i.error);
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    try {
      const result = await deps.send(item);
      await deps.store.remove(item.id!);
      report.sent.push({ item, result });
      deps.onSent(result, item);
    } catch (e) {
      if (isTransient(e) || isStorageProblem(e)) {
        report.waiting = items.length - n;
        return report;
      }
      const failed = { ...item, error: errorMessage(e) };
      await deps.store.put(failed);
      report.failed.push(failed);
    }
  }
  return report;
}

export class IdbCaptureQueue implements CaptureQueueStore {
  private db: Promise<IDBDatabase> | null = null;
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

  async add(items: QueuedCapture[]): Promise<number[]> {
    const db = await this.open();
    const tx = db.transaction(CAPTURES, 'readwrite');
    const store = tx.objectStore(CAPTURES);
    // The store assigns the ids (an own `id: undefined` would not be a valid key).
    const ids = items.map(({ id: _id, ...item }) => request(store.add(item) as IDBRequest<number>));
    await done(tx);
    return Promise.all(ids);
  }

  async list(): Promise<QueuedCapture[]> {
    const db = await this.open();
    const tx = db.transaction(CAPTURES, 'readonly');
    return request(tx.objectStore(CAPTURES).getAll() as IDBRequest<QueuedCapture[]>);
  }

  async remove(id: number): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(CAPTURES, 'readwrite');
    tx.objectStore(CAPTURES).delete(id);
    await done(tx);
  }

  async put(item: QueuedCapture): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(CAPTURES, 'readwrite');
    tx.objectStore(CAPTURES).put(item);
    await done(tx);
  }
}

/** Without IndexedDB, captures wait in memory: they survive going offline, not a reload. */
export class MemoryCaptureQueue implements CaptureQueueStore {
  private readonly items = new Map<number, QueuedCapture>();
  private next = 1;

  async add(items: QueuedCapture[]): Promise<number[]> {
    return items.map((item) => {
      const id = this.next++;
      this.items.set(id, structuredClone({ ...item, id }));
      return id;
    });
  }

  async list(): Promise<QueuedCapture[]> {
    return [...this.items.values()].map((i) => structuredClone(i));
  }

  async remove(id: number): Promise<void> {
    this.items.delete(id);
  }

  async put(item: QueuedCapture): Promise<void> {
    if (item.id !== undefined) this.items.set(item.id, structuredClone(item));
  }
}
