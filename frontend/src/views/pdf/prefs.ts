// Per-device PDF state (DESIGN §6.8.3): the last page of recently read PDFs, so reopening one continues
// where it was left, and whether pages are dimmed in the dark theme. Kept in localStorage like the
// other per-device preferences; never in the vault.

const POSITIONS_KEY = 'notesapp:pdf-positions';
const DARK_PAGES_KEY = 'notesapp:pdf-dark-pages';
/** How many PDFs remember their page; the least recently read is forgotten first. */
export const MAX_POSITIONS = 100;

type Positions = Record<string, number>;

function readPositions(): Positions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Positions = {};
    for (const [path, page] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof page === 'number' && Number.isSafeInteger(page) && page > 0) out[path] = page;
    }
    return out;
  } catch {
    return {};
  }
}

/** The page `path` was last read at on this device, or null. */
export function lastPage(path: string): number | null {
  return readPositions()[path] ?? null;
}

/** Remembers `page` for `path`, as the most recently read PDF. */
export function rememberPage(path: string, page: number): void {
  const positions = readPositions();
  delete positions[path];
  positions[path] = page;
  const paths = Object.keys(positions);
  for (const old of paths.slice(0, Math.max(0, paths.length - MAX_POSITIONS))) delete positions[old];
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // Private mode or quota: the page is simply not remembered.
  }
}

/** True unless the user turned dark pages off: in the dark theme, pages are inverted to match it. */
export function darkPagesEnabled(): boolean {
  try {
    return localStorage.getItem(DARK_PAGES_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setDarkPages(on: boolean): void {
  try {
    if (on) localStorage.removeItem(DARK_PAGES_KEY);
    else localStorage.setItem(DARK_PAGES_KEY, 'off');
  } catch {
    // The choice applies to this page load only.
  }
}
