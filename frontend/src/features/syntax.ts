// Shared inline syntax rules (API.md §15.6). The editor's Lezer extension, the reading view's
// markdown-it rules and the mock server all use these, so the three agree with the backend scanner.

/** Tag pattern: `#` at the start or after whitespace, then non-space, non-ASCII-punctuation characters (except - _ /). */
export const TAG_PATTERN = /(?<!\S)#([^\s!-,.:-@[-^`{-~]+)/gu;

/** The tag body at the start of a string (without the leading `#`). */
const TAG_BODY_AT_START = /^[^\s!-,.:-@[-^`{-~]+/u;

/** Wikilink or embed: `(!?)[[body]]`, where the body contains no brackets or newline. */
export const WIKILINK_PATTERN = /(!?)\[\[([^[\]\n]*?)\]\]/g;

/**
 * Normalizes a raw tag body: drops a trailing `/` and rejects all-digit tags.
 * Returns null when the text is not a tag.
 */
export function normalizeTag(raw: string): string | null {
  const tag = raw.replace(/\/+$/, '');
  if (tag === '' || /^\d+$/.test(tag)) return null;
  return tag;
}

/**
 * Length of the tag body starting at `text[0]` (just after the `#`), after normalization,
 * or 0 when there is no valid tag there.
 */
export function tagBodyLength(text: string): number {
  const m = TAG_BODY_AT_START.exec(text);
  if (!m) return 0;
  const tag = normalizeTag(m[0]);
  return tag === null ? 0 : tag.length;
}

export interface TagMatch {
  tag: string;
  /** Offset of the `#`. */
  from: number;
  /** End of the tag (after trailing-slash trimming). */
  to: number;
}

/** All tags in plain text (no exclusion zones are applied here). */
export function findTags(text: string): TagMatch[] {
  const out: TagMatch[] = [];
  for (const m of text.matchAll(TAG_PATTERN)) {
    const tag = normalizeTag(m[1]);
    if (tag === null) continue;
    out.push({ tag, from: m.index, to: m.index + 1 + tag.length });
  }
  return out;
}

export function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

export interface WikiBody {
  target: string;
  subpath: string | null;
  display: string | null;
}

export interface WikiBodySplit extends WikiBody {
  /** Offset of the separator in the body (`|`, or the `\` of `\|`), or -1. */
  sepFrom: number;
  /** Offset just after the separator, or -1. */
  sepTo: number;
  /** Offset of `#` in the body, or -1. */
  hashAt: number;
}

/**
 * Splits a wikilink body: at the first `|` (an escaped `\|` also separates, the backslash
 * being part of the separator), then the left part at the first `#`. The target is trimmed.
 */
export function splitWikiBody(body: string): WikiBodySplit {
  const pipe = body.indexOf('|');
  let left = body;
  let display: string | null = null;
  let sepFrom = -1;
  let sepTo = -1;
  if (pipe >= 0) {
    sepFrom = pipe > 0 && body[pipe - 1] === '\\' ? pipe - 1 : pipe;
    sepTo = pipe + 1;
    left = body.slice(0, sepFrom);
    display = body.slice(sepTo);
  }
  const hashAt = left.indexOf('#');
  const target = (hashAt >= 0 ? left.slice(0, hashAt) : left).trim();
  const subpath = hashAt >= 0 ? left.slice(hashAt + 1) : null;
  return { target, subpath, display, sepFrom, sepTo, hashAt };
}

export function parseWikiBody(body: string): WikiBody {
  const { target, subpath, display } = splitWikiBody(body);
  return { target, subpath, display };
}

export interface WikiLinkMatch extends WikiBody {
  embed: boolean;
  raw: string;
  from: number;
  to: number;
}

/** All wikilinks and embeds in plain text (no exclusion zones are applied here). */
export function findWikiLinks(text: string): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  for (const m of text.matchAll(WIKILINK_PATTERN)) {
    out.push({
      ...parseWikiBody(m[2]),
      embed: m[1] === '!',
      raw: m[0],
      from: m.index,
      to: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * Matches a wikilink or embed starting exactly at `pos` in `text`. Returns the end offset
 * (exclusive) or -1. Mirrors WIKILINK_PATTERN, including the lazy match of the first `]]`.
 */
export function matchWikiLinkAt(text: string, pos: number): number {
  let i = pos;
  if (text.charCodeAt(i) === 33 /* ! */) i++;
  if (text.charCodeAt(i) !== 91 || text.charCodeAt(i + 1) !== 91) return -1;
  for (i += 2; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 91) return -1;
    if (c === 93) return text.charCodeAt(i + 1) === 93 ? i + 2 : -1;
  }
  return -1;
}

/** Markdown link destination: percent-decoding that never turns `+` into a space; bad escapes stay verbatim. */
export function decodeLinkDestination(dest: string): string {
  return dest.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** True when a markdown link destination is internal (no URI scheme, not protocol-relative). */
export function isInternalDestination(dest: string): boolean {
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest) && !dest.startsWith('//');
}

/** Splits an internal markdown destination into its decoded target and `#subpath`. */
export function parseMarkdownDestination(rawDest: string): { target: string; subpath: string | null } {
  let dest = rawDest.trim();
  const angle = dest.startsWith('<') && dest.endsWith('>');
  dest = angle ? dest.slice(1, -1) : decodeLinkDestination(dest);
  const hash = dest.indexOf('#');
  if (hash < 0) return { target: dest.trim(), subpath: null };
  return { target: dest.slice(0, hash).trim(), subpath: dest.slice(hash + 1) };
}
