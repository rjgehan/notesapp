// PDF link and embed subpaths (DESIGN §6.8.3): `[[file.pdf#page=3]]`, `![[file.pdf#page=3&height=400]]`,
// as in Obsidian. Pure, so the eager registration and the route can use it without loading PDF.js.

export interface PdfTarget {
  /** 1-based page, or null for none (or one that is not a positive integer). */
  page: number | null;
  /** Embed height in CSS pixels, or null for the default. */
  height: number | null;
}

function positiveInt(value: string | null): number | null {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Parses a subpath (`page=3&height=400`, with or without the leading `#`); unknown keys are ignored. */
export function parsePdfSubpath(subpath: string | null | undefined): PdfTarget {
  if (!subpath) return { page: null, height: null };
  let text = subpath.startsWith('#') ? subpath.slice(1) : subpath;
  try {
    // A route hash arrives percent-encoded (`page%3D3`), a link's subpath does not.
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text);
  } catch {
    // A literal % that is not an escape.
  }
  const params = new URLSearchParams(text.replace(/^#/, ''));
  return { page: positiveInt(params.get('page')), height: positiveInt(params.get('height')) };
}

/** The subpath of a link to `page`. */
export function pageSubpath(page: number): string {
  return `page=${page}`;
}
