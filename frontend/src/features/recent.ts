// Most-recently-opened files (localStorage), for the quick switcher and `[[` completion.

const KEY = 'notesapp:recent';
const LAST_PATH_KEY = 'notesapp:lastPath';
const MAX = 50;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Private mode: recents are a convenience only.
  }
}

export function recentPaths(): string[] {
  return read();
}

export function recordOpened(path: string): void {
  write([path, ...read().filter((p) => p !== path)]);
  try {
    localStorage.setItem(LAST_PATH_KEY, path);
  } catch {
    // ignore
  }
}

export function lastOpenedPath(): string | null {
  try {
    return localStorage.getItem(LAST_PATH_KEY);
  } catch {
    return null;
  }
}

/** Keeps recents pointing at moved files. */
export function renameRecent(from: string, to: string): void {
  const list = read();
  const next = list.map((p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p));
  write(next);
  if (lastOpenedPath() === from) {
    try {
      localStorage.setItem(LAST_PATH_KEY, to);
    } catch {
      // ignore
    }
  }
}

export function forgetRecent(path: string): void {
  write(read().filter((p) => p !== path && !p.startsWith(path + '/')));
}
