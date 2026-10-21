// The offline database (DESIGN §6.21): IndexedDB `notesapp-offline`, separate from the drafts
// database (`notesapp`, §6.9) so neither schema has to move with the other.
//
// - `notes`: copies of recently opened notes for offline reading, keyed by path.
// - `meta`: the last tree snapshot (`key: 'tree'`).
// - `captures`: quick captures waiting for the server (DESIGN §6.22), in the order they were made.

export const OFFLINE_DB = 'notesapp-offline';
export const OFFLINE_DB_VERSION = 2;
export const NOTES = 'notes';
export const META = 'meta';
export const CAPTURES = 'captures';

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Opens (and creates or upgrades) the offline database; every store is created when missing. */
export function openOfflineDb(factory: IDBFactory, name: string = OFFLINE_DB, onClosed: () => void = () => undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(CAPTURES)) db.createObjectStore(CAPTURES, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: step aside, the next open gets the new version.
      db.onversionchange = () => {
        db.close();
        onClosed();
      };
      db.onclose = onClosed;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Cannot open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
}
