// The session's unlocked keys (ROADMAP item 27, DESIGN §6.33). Keys live only in this module's
// memory as non-extractable CryptoKeys: never in storage, IndexedDB, the service worker or a
// URL, and a reload forgets them. Passphrases are not kept at all: a passphrase is turned into
// keys the moment it is entered. `lock()` forgets every key; views holding a key finish their
// pending encryption with it (onLock) and then drop it with their plaintext.
import { decryptPayload, deriveKey, newWriteKey, type WriteKey } from './cipher';
import { decodePayload, FormatError, saltId, type Payload, type PayloadVersion } from './meld';

interface Held {
  version: PayloadVersion;
  /** saltId of v2 keys; v1 keys share the plugin's fixed salt and are told apart by trying them. */
  id: string;
  key: CryptoKey;
  salt: Uint8Array;
}

/** What opening a payload gives: its text, and the key that saves it again (always v2). */
export interface Opened {
  text: string;
  write: WriteKey;
}

let held: Held[] = [];
/** v1 payloads are saved as v2: the v2 key made from the same passphrase, per v1 key. */
const upgrades = new Map<CryptoKey, WriteKey>();
const lockListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
let generation = 0;

function changed(): void {
  generation++;
  for (const fn of [...changeListeners]) fn();
}

function remember(entry: Held): void {
  if (entry.version === 2 && held.some((h) => h.version === 2 && h.id === entry.id)) return;
  held = [...held, entry];
  changed();
}

/** Forgets every key. Listeners run first, synchronously, so they can capture the key they hold. */
export function lock(): void {
  if (held.length === 0 && lockListeners.size === 0) return;
  for (const fn of [...lockListeners]) {
    try {
      fn();
    } catch {
      // A view failing to finish must not keep the keys alive.
    }
  }
  held = [];
  upgrades.clear();
  changed();
}

export function isUnlocked(): boolean {
  return held.length > 0;
}

/** Called on every lock (manual, idle timeout, hidden page). */
export function onLock(fn: () => void): () => void {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

export function subscribeKeys(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

export function keysGeneration(): number {
  return generation;
}

async function openWith(payload: Payload, entry: Held): Promise<Opened | null> {
  const text = await decryptPayload(payload, entry.key);
  if (text === null) return null;
  if (entry.version === 2) return { text, write: { key: entry.key, salt: entry.salt } };
  const upgrade = upgrades.get(entry.key);
  return upgrade ? { text, write: upgrade } : null;
}

/** Opens a payload with a key already unlocked this session, or null. */
export async function openCached(payload: Payload): Promise<Opened | null> {
  if (payload.version === 2) {
    const id = saltId(payload.salt);
    const entry = held.find((h) => h.version === 2 && h.id === id);
    return entry ? openWith(payload, entry) : null;
  }
  for (const entry of held.filter((h) => h.version === 1)) {
    const opened = await openWith(payload, entry);
    if (opened) return opened;
  }
  return null;
}

/**
 * Tries a passphrase on `payload`; null when it is wrong. On success the key is kept for the
 * session, and the passphrase is also tried on `others` (other sections of the same note, at
 * most a few distinct salts), so one passphrase opens them all.
 */
export async function unlock(passphrase: string, payload: Payload, others: Payload[] = []): Promise<Opened | null> {
  const opened = await tryPassphrase(passphrase, payload);
  if (!opened) return null;
  const seen = new Set<string>([payload.version === 2 ? saltId(payload.salt) : 'v1']);
  for (const other of others) {
    const id = other.version === 2 ? saltId(other.salt) : 'v1';
    if (seen.has(id) || seen.size >= 8) continue;
    seen.add(id);
    if (await openCached(other)) continue;
    await tryPassphrase(passphrase, other);
  }
  return opened;
}

async function tryPassphrase(passphrase: string, payload: Payload): Promise<Opened | null> {
  const key = await deriveKey(passphrase, payload.salt, payload.version);
  const text = await decryptPayload(payload, key);
  if (text === null) return null;
  if (payload.version === 2) {
    const entry: Held = { version: 2, id: saltId(payload.salt), key, salt: payload.salt };
    remember(entry);
    return { text, write: { key, salt: payload.salt } };
  }
  const write = await newWriteKey(passphrase);
  upgrades.set(key, write);
  remember({ version: 1, id: 'v1', key, salt: payload.salt });
  remember({ version: 2, id: saltId(write.salt), key: write.key, salt: write.salt });
  return { text, write };
}

/** A new key for new ciphertext (a new note, a new section, a changed passphrase), kept for the session. */
export async function createKey(passphrase: string): Promise<WriteKey> {
  const write = await newWriteKey(passphrase);
  remember({ version: 2, id: saltId(write.salt), key: write.key, salt: write.salt });
  return write;
}

/** Decodes a payload, turning format problems into a message for the reader. */
export function readPayload(base64: string, version: PayloadVersion): Payload | string {
  try {
    return decodePayload(base64, version);
  } catch (e) {
    return e instanceof FormatError ? e.message : 'The encrypted text is damaged.';
  }
}

/** For tests: forget everything without notifying. */
export function resetKeyringForTests(): void {
  held = [];
  upgrades.clear();
  lockListeners.clear();
  changeListeners.clear();
  generation = 0;
}
