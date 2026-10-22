// The Obsidian Meld Encrypt formats (ROADMAP item 27, DESIGN §6.33), verified against the plugin's
// source (meld-cp/obsidian-encrypt, src/services/CryptoHelper2304.ts, FileDataHelper.ts and
// features/feature-inplace-encrypt/FeatureInplaceConstants.ts):
//
// - Whole notes: `<name>.mdenc`, JSON `{"version":"2.0","hint":"…","encodedData":"<base64>"}`
//   written with JSON.stringify(data, null, 2).
// - Inline sections in a Markdown note: `%%🔐β 💡hint💡<base64> 🔐%%` (hidden in Obsidian's reading
//   view) or `🔐β 💡hint💡<base64> 🔐` (shown there as a lock). The hint part is optional.
// - The payload (v2, `β`): base64( iv[16] | salt[16] | AES-256-GCM ciphertext+tag ), the key derived
//   with PBKDF2-HMAC-SHA-512, 210,000 iterations (OWASP's figure for SHA-512, equivalent to the
//   600,000 SHA-256 iterations ROADMAP item 27 names).
// - v1 (`α` sections, file version "1.0"): iv[16] | ciphertext, PBKDF2-SHA-256 with 1,000
//   iterations and a fixed salt. Read only: saving writes v2.
// The unmarked `%%🔐 ` sections of the plugin's first release use another scheme and are reported
// as unsupported.

export const LOCK = '🔐';
export const HINT_MARK = '💡';

export type PayloadVersion = 1 | 2;

/** A decoded `encodedData` or inline payload. */
export interface Payload {
  version: PayloadVersion;
  iv: Uint8Array;
  /** 16 random bytes (v2) or the plugin's fixed v1 salt. */
  salt: Uint8Array;
  data: Uint8Array;
}

// ---------- whole notes (.mdenc) ----------

export const MDENC_EXTENSION = 'mdenc';

export interface EncryptedFile {
  version: '1.0' | '2.0';
  hint: string;
  /** Empty for a note that was never given any text (the plugin reads it as empty). */
  encodedData: string;
}

export class FormatError extends Error {}

export function isEncryptedNotePath(path: string): boolean {
  return path.toLowerCase().endsWith('.' + MDENC_EXTENSION);
}

export function parseEncryptedFile(text: string): EncryptedFile {
  if (text.trim() === '') return { version: '2.0', hint: '', encodedData: '' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FormatError('This file is not a Meld Encrypt note (it is not JSON).');
  }
  if (!raw || typeof raw !== 'object') throw new FormatError('This file is not a Meld Encrypt note.');
  const o = raw as Record<string, unknown>;
  const version = o.version;
  if (version !== '1.0' && version !== '2.0') {
    throw new FormatError(`This note uses Meld Encrypt format ${typeof version === 'string' ? version : '(unknown)'}, which this app cannot read.`);
  }
  const encodedData = typeof o.encodedData === 'string' ? o.encodedData : '';
  return { version, hint: typeof o.hint === 'string' ? o.hint : '', encodedData };
}

/** The plugin's own serialization, byte for byte (keys in this order, two-space indent). */
export function serializeEncryptedFile(file: EncryptedFile): string {
  return JSON.stringify({ version: file.version, hint: file.hint, encodedData: file.encodedData }, null, 2);
}

// ---------- inline sections ----------

const PREFIX_B = `%%${LOCK}β `;
const PREFIX_B_VISIBLE = `${LOCK}β `;
const SUFFIX = ` ${LOCK}%%`;
const SUFFIX_VISIBLE = ` ${LOCK}`;

/**
 * Every section on one line: the commented form with its own suffix, else the visible one (which
 * needs its α or β mark, so words between two lock emoji are never taken for one). The payload
 * is base64 of 16 characters or more; the optional hint is anything up to the next 💡. The same
 * pattern is used by the server (EncryptedSections.java), so what search skips is exactly what
 * this finds.
 */
const SECTION = new RegExp(
  `%%${LOCK}([αβ]?) (?:${HINT_MARK}([^\\n]*?)${HINT_MARK})?([A-Za-z0-9+/=]{16,}) ${LOCK}%%|${LOCK}([αβ]) (?:${HINT_MARK}([^\\n]*?)${HINT_MARK})?([A-Za-z0-9+/=]{16,}) ${LOCK}`,
  'gu',
);

export interface InlineSection {
  from: number;
  to: number;
  /** The section's text as it stands in the note. */
  text: string;
  /** 2 for `β`, 1 for `α`, 0 for the plugin's first, unsupported format. */
  version: 0 | 1 | 2;
  hint: string;
  base64: string;
  /** `🔐β …🔐` without the `%%` comment: Obsidian shows a marker for it in reading view. */
  visible: boolean;
}

export function findSections(text: string): InlineSection[] {
  if (!text.includes(LOCK)) return [];
  const out: InlineSection[] = [];
  SECTION.lastIndex = 0;
  for (let m = SECTION.exec(text); m; m = SECTION.exec(text)) {
    const visible = m[3] === undefined;
    const mark = visible ? m[4] : m[1];
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      text: m[0],
      version: mark === 'β' ? 2 : mark === 'α' ? 1 : 0,
      hint: (visible ? m[5] : m[2]) ?? '',
      base64: (visible ? m[6] : m[3]) ?? '',
      visible,
    });
  }
  return out;
}

/** The section at `pos` (inside it or touching its edges). */
export function sectionAt(text: string, pos: number): InlineSection | null {
  return findSections(text).find((s) => pos >= s.from && pos <= s.to) ?? null;
}

/** A new section (always v2). The hint must not contain 💡 or a line break. */
export function formatSection(base64: string, hint: string, visible = false): string {
  const h = hint ? `${HINT_MARK}${hint}${HINT_MARK}` : '';
  return visible ? `${PREFIX_B_VISIBLE}${h}${base64}${SUFFIX_VISIBLE}` : `${PREFIX_B}${h}${base64}${SUFFIX}`;
}

/** Text with every section replaced by `[encrypted]` (what leaves the device for Ask your vault). */
export function stripSections(text: string): string {
  if (!text.includes(LOCK)) return text;
  return text.replace(SECTION, '[encrypted]');
}

export function validHint(hint: string): string | null {
  if (hint.includes(HINT_MARK)) return `The hint cannot contain ${HINT_MARK}.`;
  if (/[\r\n]/.test(hint)) return 'The hint must be one line.';
  if (hint.includes(LOCK)) return `The hint cannot contain ${LOCK}.`;
  return null;
}


// ---------- payload bytes ----------

/** The plugin's v1 salt (CryptoHelper.ts): fixed, so every v1 key from one passphrase is the same. */
export const V1_SALT = new TextEncoder().encode('XHWnDAT6ehMVY2zD');
export const IV_BYTES = 16;
export const SALT_BYTES = 16;
/** AES-GCM's 16-byte tag: the smallest valid ciphertext. */
const TAG_BYTES = 16;

export function decodePayload(base64: string, version: PayloadVersion): Payload {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    throw new FormatError('The encrypted text is damaged (not base64).');
  }
  if (version === 2) {
    if (bytes.length < IV_BYTES + SALT_BYTES + TAG_BYTES) throw new FormatError('The encrypted text is damaged (too short).');
    return { version, iv: bytes.slice(0, IV_BYTES), salt: bytes.slice(IV_BYTES, IV_BYTES + SALT_BYTES), data: bytes.slice(IV_BYTES + SALT_BYTES) };
  }
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new FormatError('The encrypted text is damaged (too short).');
  return { version, iv: bytes.slice(0, IV_BYTES), salt: V1_SALT, data: bytes.slice(IV_BYTES) };
}

export function encodePayload(iv: Uint8Array, salt: Uint8Array, data: Uint8Array): string {
  const out = new Uint8Array(iv.length + salt.length + data.length);
  out.set(iv, 0);
  out.set(salt, iv.length);
  out.set(data, iv.length + salt.length);
  return bytesToBase64(out);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function base64ToBytes(base64: string): Uint8Array {
  const s = atob(base64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function saltId(salt: Uint8Array): string {
  let s = '';
  for (const b of salt) s += b.toString(16).padStart(2, '0');
  return s;
}

const STICKY = new RegExp(SECTION.source, 'uy');

/** The section starting exactly at `pos`, or null (the reading view's inline rule). */
export function sectionStartingAt(text: string, pos: number): InlineSection | null {
  const c = text.charCodeAt(pos);
  // '%' or the high surrogate of 🔐.
  if (c !== 0x25 && c !== 0xd83d) return null;
  STICKY.lastIndex = pos;
  const m = STICKY.exec(text);
  if (!m) return null;
  const visible = m[3] === undefined;
  const mark = visible ? m[4] : m[1];
  return {
    from: pos,
    to: pos + m[0].length,
    text: m[0],
    version: mark === 'β' ? 2 : mark === 'α' ? 1 : 0,
    hint: (visible ? m[5] : m[2]) ?? '',
    base64: (visible ? m[6] : m[3]) ?? '',
    visible,
  };
}
