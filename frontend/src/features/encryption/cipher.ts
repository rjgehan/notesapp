// WebCrypto for the Meld Encrypt payloads (ROADMAP item 27, DESIGN §6.33). Keys are AES-256-GCM
// CryptoKeys derived with PBKDF2 and created non-extractable: script on the page can use them
// while they are held, but can never read their bytes. Nothing here logs, stores or copies a
// passphrase, a key or a plaintext.
import { decodePayload, encodePayload, IV_BYTES, SALT_BYTES, type Payload, type PayloadVersion } from './meld';

/** PBKDF2 iterations of the plugin's v2 format (SHA-512) and of its v1 format (SHA-256). */
export const V2_ITERATIONS = 210_000;
export const V1_ITERATIONS = 1_000;

/** A key that encrypts: always v2, with the salt that is written next to every ciphertext it makes. */
export interface WriteKey {
  key: CryptoKey;
  salt: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  // WebCrypto exists only in secure contexts (https, or localhost in development).
  if (!s) throw new Error('Encryption needs a secure (https) connection; this page has no WebCrypto.');
  return s;
}

/** Copies into a fresh ArrayBuffer-backed array (WebCrypto's BufferSource typing). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export async function deriveKey(passphrase: string, salt: Uint8Array, version: PayloadVersion): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: version === 2 ? 'SHA-512' : 'SHA-256', salt: buf(salt), iterations: version === 2 ? V2_ITERATIONS : V1_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A new v2 key with a fresh random salt. */
export async function newWriteKey(passphrase: string): Promise<WriteKey> {
  const salt = randomBytes(SALT_BYTES);
  return { key: await deriveKey(passphrase, salt, 2), salt };
}

/**
 * Encrypts to the plugin's v2 payload. Every call draws a fresh random 16-byte IV, so one key
 * never sees the same IV twice in practice (2^-128 per pair; NIST's random-IV limit of 2^32
 * messages per key is far beyond any number of saves).
 */
export async function encryptText(plaintext: string, write: WriteKey): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, write.key, encoder.encode(plaintext)));
  return encodePayload(iv, write.salt, data);
}

/** The plaintext, or null when this key does not open it (wrong passphrase, or tampered text). */
export async function decryptPayload(payload: Payload, key: CryptoKey): Promise<string | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await subtle().decrypt({ name: 'AES-GCM', iv: buf(payload.iv) }, key, buf(payload.data));
  } catch {
    return null;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export { decodePayload };
