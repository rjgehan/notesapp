// Client implementation of the shared link algorithms: resolution (DESIGN §5.5.6, API.md §15.1)
// and link text generation (DESIGN §5.5.7, API.md §15.3). Vectors in links.test.ts.
import type { FilesSettings, LinkStyle } from '../api/types';
import { kindOfPath } from './fileKinds';
import { extensionOf, folderOf, joinPath, lastSegment, newPathError, normalizeDots, relativePath, segmentCount, stripMd } from './paths';

/** Lookup structures over the vault's file paths (built from the tree). */
export interface LinkIndex {
  /** lower(path) → paths (usually one). */
  byLowerPath: Map<string, string[]>;
  /** lower(last segment) → paths, for suffix resolution. */
  byLowerName: Map<string, string[]>;
}

export function buildLinkIndex(paths: Iterable<string>): LinkIndex {
  const byLowerPath = new Map<string, string[]>();
  const byLowerName = new Map<string, string[]>();
  for (const p of paths) {
    push(byLowerPath, p.toLowerCase(), p);
    push(byLowerName, lastSegment(p).toLowerCase(), p);
  }
  return { byLowerPath, byLowerName };
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lookupLower(index: LinkIndex, candidate: string): string | null {
  const hits = index.byLowerPath.get(candidate.toLowerCase());
  if (!hits || hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  return hits.includes(candidate) ? candidate : [...hits].sort(compareStrings)[0];
}

function endsWithMd(s: string): boolean {
  return s.toLowerCase().endsWith('.md');
}

/** Resolves a link target as written in `source` to a vault path, or null when unresolved. */
export function resolve(rawTarget: string, source: string, index: LinkIndex): string | null {
  let t = rawTarget.normalize('NFC').trim();
  if (t === '') return source;
  const forcedAbs = t.startsWith('/');
  const forcedRel = t.startsWith('./') || t.startsWith('../');
  if (forcedAbs) t = t.slice(1);
  const candidates = endsWithMd(t) ? [t] : [t + '.md', t];

  if (!forcedRel) {
    for (const c of candidates) {
      const hit = lookupLower(index, c);
      if (hit) return hit;
    }
  }
  if (!forcedAbs) {
    const folder = folderOf(source);
    for (const c of candidates) {
      const p = normalizeDots(joinPath(folder, c));
      if (p === null) continue;
      const hit = lookupLower(index, p);
      if (hit) return hit;
    }
  }
  if (forcedAbs || forcedRel) return null;

  const sourceFolder = folderOf(source);
  for (const c of candidates) {
    const lower = c.toLowerCase();
    const named = index.byLowerName.get(lastSegment(lower));
    if (!named) continue;
    const matches = named.filter((f) => {
      const lf = f.toLowerCase();
      return lf === lower || lf.endsWith('/' + lower);
    });
    if (matches.length === 0) continue;
    matches.sort((a, b) => {
      const sa = folderOf(a) === sourceFolder ? 0 : 1;
      const sb = folderOf(b) === sourceFolder ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const da = segmentCount(a) - segmentCount(b);
      if (da !== 0) return da;
      const la = compareStrings(a.toLowerCase(), b.toLowerCase());
      if (la !== 0) return la;
      return compareStrings(a, b);
    });
    return matches[0];
  }
  return null;
}

/**
 * Whether a target names a note to create: it ends in `.md`, or its final dot part is not the
 * extension of a known file kind (DESIGN §4.2), exactly as the server decides. So `missing.pdf`
 * creates nothing, while `v1.2 notes`, `v1.3` and `Report.final` create `<target>.md`.
 */
function isNoteLikeTarget(t: string): boolean {
  return endsWithMd(t) || kindOfPath(t) === 'other';
}

export type NewNoteSettings = Pick<FilesSettings, 'newNoteLocation' | 'newNoteFolder'>;

/** The note to create for an unresolved target, or null when none should be created. */
export function createPath(rawTarget: string, source: string, settings: NewNoteSettings): string | null {
  let t = rawTarget.normalize('NFC').trim();
  if (t === '' || !isNoteLikeTarget(t)) return null;
  let path: string | null;
  if (t.startsWith('./') || t.startsWith('../')) {
    path = normalizeDots(joinPath(folderOf(source), t));
  } else if (t.startsWith('/')) {
    t = t.slice(1);
    path = t;
  } else if (t.includes('/')) {
    path = t;
  } else {
    const folder =
      settings.newNoteLocation === 'current'
        ? folderOf(source)
        : settings.newNoteLocation === 'folder'
          ? settings.newNoteFolder
          : '';
    path = joinPath(folder, t);
  }
  if (path === null || path === '') return null;
  if (!endsWithMd(path)) path += '.md';
  return newPathError(path) === null ? path : null;
}

export type LinkFormat = FilesSettings['newLinkFormat'];

// eslint-disable-next-line no-control-regex
const MD_ENCODE = /[\u0000-\u001f ()<>[\]#^|%]/gu;
const utf8 = new TextEncoder();

/** Percent-encodes exactly space ( ) < > [ ] # ^ | % and C0 controls, as UTF-8 bytes. */
export function encodeMdPath(s: string): string {
  return s.replace(MD_ENCODE, (ch) =>
    Array.from(utf8.encode(ch), (b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''),
  );
}

/** Unencoded link text for `target` as written in `source` (DESIGN §5.5.7). */
export function linkTextRaw(target: string, source: string, format: LinkFormat, style: LinkStyle, index: LinkIndex): string {
  const name = style === 'wiki' ? stripMd(target) : target;
  let text: string;
  if (format === 'shortest') {
    const sameName = index.byLowerName.get(lastSegment(target).toLowerCase());
    text = sameName && sameName.length === 1 ? lastSegment(name) : name;
  } else if (format === 'relative') {
    const rel = relativePath(folderOf(source), name);
    text = rel.startsWith('../') ? rel : './' + rel;
  } else {
    text = name;
  }
  if (resolve(text, source, index) !== target) text = name;
  return text;
}

/** Link text as it appears in the link: markdown style is percent-encoded. */
export function linkText(target: string, source: string, format: LinkFormat, style: LinkStyle, index: LinkIndex): string {
  const raw = linkTextRaw(target, source, format, style, index);
  return style === 'markdown' ? encodeMdPath(raw) : raw;
}

export interface BuildLinkOptions {
  embed?: boolean;
  display?: string | null;
  subpath?: string | null;
}

/**
 * Assembles a complete link (API.md §15.3 "Assembling a full link"). `text` is the output of
 * `linkText` for the chosen style.
 */
export function assembleLink(text: string, style: LinkStyle, target: string, opts: BuildLinkOptions = {}): string {
  const sub = opts.subpath ? '#' + (style === 'markdown' ? encodeMdPath(opts.subpath) : opts.subpath) : '';
  if (style === 'wiki') {
    const display = opts.display ? '|' + opts.display : '';
    return `${opts.embed ? '!' : ''}[[${text}${sub}${display}]]`;
  }
  if (opts.embed) return `![](${text}${sub})`;
  const display = opts.display ?? stripMd(lastSegment(target));
  return `[${display}](${text}${sub})`;
}

/** True when the path's extension makes it an embeddable image. */
export function isImagePath(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(extensionOf(path));
}
