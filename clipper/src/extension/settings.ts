// The extension's options (storage.sync): where NotesApp is, the folder, and the two switches.
import { cleanFolder, DEFAULT_FOLDER } from '../core/note';

export interface ClipperSettings {
  /** NotesApp's origin, for example `https://notes.example-tailnet.ts.net`; `''` until set. */
  appUrl: string;
  folder: string;
  /** Download the article's images and store them as attachments (needs access to all sites). */
  downloadImages: boolean;
  /** Save without the preview's Save button; the clip tab closes itself afterwards. */
  autoSave: boolean;
}

export const DEFAULTS: ClipperSettings = { appUrl: '', folder: DEFAULT_FOLDER, downloadImages: false, autoSave: false };

/** Host permissions for downloading images from any site. */
export const ALL_SITES = ['https://*/*', 'http://*/*'];

/**
 * The origin of a NotesApp address the user typed, or null. HTTPS only, except plain HTTP to
 * this machine (`localhost`, `127.0.0.1`) for development. A bare host gets `https://`.
 */
export function normalizeAppUrl(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}

/** The host-permission pattern for NotesApp's origin. */
export function appPattern(origin: string): string {
  const u = new URL(origin);
  // Match patterns take no port: the host pattern covers every port.
  return `${u.protocol}//${u.hostname}/*`;
}

export function readSettings(raw: Record<string, unknown>): ClipperSettings {
  const appUrl = typeof raw.appUrl === 'string' ? (normalizeAppUrl(raw.appUrl) ?? '') : '';
  const folder = typeof raw.folder === 'string' ? cleanFolder(raw.folder) : DEFAULT_FOLDER;
  return {
    appUrl,
    folder,
    downloadImages: raw.downloadImages === true,
    autoSave: raw.autoSave === true,
  };
}
