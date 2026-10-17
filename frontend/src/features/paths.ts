// Vault path helpers (API.md §1.3) and the route encoding of DESIGN §6.4.

/** `joinPath('', x) === x`, so the vault root works as a folder. */
export function joinPath(folder: string, name: string): string {
  if (!folder) return name;
  if (!name) return folder;
  return `${folder}/${name}`;
}

/** The folder of a path, `''` for root entries. */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** FileEntry.basename semantics: the name without its final extension; dot-files are their own basename. */
export function basenameOf(name: string): string {
  const seg = lastSegment(name);
  const dot = seg.lastIndexOf('.');
  return dot <= 0 ? seg : seg.slice(0, dot);
}

/** FileEntry.extension semantics: lower-case, without the dot, `''` if none. */
export function extensionOf(name: string): string {
  const seg = lastSegment(name);
  const dot = seg.lastIndexOf('.');
  return dot <= 0 ? '' : seg.slice(dot + 1).toLowerCase();
}

export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/** A path without a trailing `.md` (any case). */
export function stripMd(path: string): string {
  return isNotePath(path) ? path.slice(0, -3) : path;
}

/** Display name used in the explorer, tabs and titles: notes without `.md`. */
export function displayName(path: string): string {
  const seg = lastSegment(path);
  return isNotePath(seg) ? seg.slice(0, -3) : seg;
}

export function segmentCount(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

/** True when `path` equals `folder` or lies below it (case-sensitive). */
export function isWithin(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(folder + '/');
}

/** Replace the `from` prefix of `path` with `to` (for folder moves). Returns null when `path` is not under `from`. */
export function rebasePath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + '/')) return to + path.slice(from.length);
  return null;
}

/**
 * Resolves `.` and `..` segments. Returns null when the path escapes the vault root.
 * A leading `/` is ignored, so `normalizeDots('/a/../b')` is `'b'`.
 */
export function normalizeDots(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/** Relative path from a folder to a target path, without any `./` prefix. */
export function relativePath(fromFolder: string, to: string): string {
  const from = fromFolder === '' ? [] : fromFolder.split('/');
  const target = to.split('/');
  let i = 0;
  while (i < from.length && i < target.length - 1 && from[i] === target[i]) i++;
  const ups = from.length - i;
  return [...Array<string>(ups).fill('..'), ...target.slice(i)].join('/');
}

// ---------- routes (DESIGN §6.4) ----------

export function encodeRoutePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Decodes a percent-encoded route tail segment by segment; malformed escapes are kept verbatim. */
export function decodeRoutePath(encoded: string): string {
  return encoded
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

export function noteRoute(path: string, subpath?: string | null): string {
  return '/n/' + encodeRoutePath(path) + (subpath ? '#' + encodeURIComponent(subpath) : '');
}

/** The vault path addressed by a `/n/<path>` location pathname, or null for other routes. */
export function pathFromLocation(pathname: string): string | null {
  if (!pathname.startsWith('/n/')) return null;
  const path = decodeRoutePath(pathname.slice(3));
  return path === '' ? null : path;
}

// ---------- name rules (API.md §1.3, DESIGN §4.4) ----------

const encoder = new TextEncoder();

export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FORBIDDEN_CHARS = /[:*?"<>|#^[\]]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Names the server's watcher and index ignore (DESIGN §4.5); the new-name rules reject them. */
export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith('.') ||
    lower.endsWith('.swp') ||
    lower.endsWith('.swx') ||
    name.endsWith('~') ||
    name === '4913' ||
    lower === '.ds_store' ||
    lower === 'thumbs.db' ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.crdownload') ||
    lower.endsWith('.part') ||
    name.startsWith('.#') ||
    (name.startsWith('.~lock.') && name.endsWith('#'))
  );
}

/** Safety rules for one existing segment; returns a message or null. */
function segmentSafetyError(seg: string): string | null {
  if (seg === '') return 'Empty path segment';
  if (seg === '.' || seg === '..') return 'Relative segments are not allowed';
  if (seg.includes('\\')) return 'Names cannot contain \\';
  if (CONTROL_CHARS.test(seg)) return 'Names cannot contain control characters';
  if (seg.startsWith('.')) return 'Names cannot start with a dot';
  if (utf8Length(seg) > 255) return 'Name is too long';
  return null;
}

/** New-name rules for one segment (on top of the safety rules); returns a user-facing message or null. */
export function newNameError(seg: string): string | null {
  const safety = segmentSafetyError(seg);
  if (safety) return safety;
  if (seg.trim() !== seg) return 'Names cannot start or end with spaces';
  if (seg.endsWith('.')) return 'Names cannot end with a dot';
  if (FORBIDDEN_CHARS.test(seg) || seg.includes('%%')) return "Names can't contain # ^ [ ] | : * ? \" < > or %%";
  if (WINDOWS_RESERVED.test(seg)) return 'This name is reserved on Windows';
  if (utf8Length(seg) > 240) return 'Name is too long';
  if (isIgnoredName(seg)) return 'The server ignores files with this name';
  return null;
}

/** Validates a whole new path; returns a message or null. */
export function newPathError(path: string): string | null {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) return 'Invalid path';
  if (path.length > 1024) return 'Path is too long';
  for (const seg of path.split('/')) {
    const err = newNameError(seg);
    if (err) return err;
  }
  return null;
}

/** Safety rules for an existing path; returns a message or null. */
export function pathSafetyError(path: string): string | null {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) return 'Invalid path';
  if (path.length > 1024) return 'Path is too long';
  for (const seg of path.split('/')) {
    const err = segmentSafetyError(seg);
    if (err) return err;
  }
  return null;
}
