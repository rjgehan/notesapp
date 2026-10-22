// Turns a clip into a note (DESIGN §6.27.1): a vault-safe file name from the page title, Obsidian
// Web Clipper's frontmatter properties (title, source, author, published, created, description,
// tags) and the request body of POST /api/files (API.md §8.2) that every client sends.
import type { Clip } from './types';

/** The folder clippings go to by default (ROADMAP item 19). */
export const DEFAULT_FOLDER = 'Clippings';

/** The name a clip gets when its page has no usable title. */
export const UNTITLED = 'Clipping';

/** The tag every clipping carries, as Obsidian Web Clipper's default template does. */
export const CLIP_TAG = 'clippings';

// A name leaves room for " 999.md" (the server's de-duplication, API.md §8.2) inside 240 bytes.
const MAX_BASENAME_BYTES = 200;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const encoder = new TextEncoder();

function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

function truncateBytes(s: string, max: number): string {
  if (utf8Length(s) <= max) return s;
  let out = '';
  let used = 0;
  for (const cp of s) {
    const len = utf8Length(cp);
    if (used + len > max) break;
    out += cp;
    used += len;
  }
  return out;
}

/**
 * A title made into a new note's basename under the new-name rules of API.md §1.3: slashes and
 * pipes become dashes, the other forbidden characters (`: * ? " < > # ^ [ ]`) and control
 * characters go, `%%` becomes `%`, whitespace collapses, leading dots and spaces and trailing
 * dots and spaces go, Windows device names get a `_`, and the name is cut to 200 UTF-8 bytes.
 */
export function noteBasename(title: string, fallback = UNTITLED): string {
  let name = title.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, ' ');
  name = name.replace(/[\\/|]/g, '-');
  name = name.replace(/[:*?"<>#^[\]]/g, '');
  while (name.includes('%%')) name = name.replace(/%%/g, '%');
  name = name.replace(/\s+/g, ' ');
  name = name.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  name = truncateBytes(name, MAX_BASENAME_BYTES).replace(/[. ]+$/, '');
  // A name the server's watcher ignores (DESIGN §4.5) would never show up.
  if (/~$/.test(name) || /\.(tmp|swp|swx|part|crdownload)$/i.test(name)) name = name + ' clip';
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;
  return name === '' ? fallback : name;
}

/** A folder path cleaned segment by segment the same way; `''` is the vault root. */
export function cleanFolder(folder: string): string {
  return folder
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .map((seg) => noteBasename(seg, 'Folder'))
    .join('/');
}

/** `Clippings/<basename>.md`, or `<basename>.md` for the root. */
export function notePath(folder: string, basename: string): string {
  const f = cleanFolder(folder);
  const name = noteBasename(basename) + '.md';
  return f ? `${f}/${name}` : name;
}

/** The device's local date, `YYYY-MM-DD` ("today" is decided on the device, DESIGN risk 20). */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A YAML double-quoted scalar. A JSON string is one (YAML 1.2 is a superset of JSON); line
 * separators are escaped too, which JSON leaves raw.
 */
export function yamlString(s: string): string {
  return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** A published date reduced to `YYYY-MM-DD` when it starts with one; otherwise null. */
export function publishedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (m) return m[1];
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function oneLine(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const v = s.replace(/\s+/g, ' ').trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max - 1).trimEnd() + '…' : v;
}

/** The frontmatter block, ending with a newline. */
export function frontmatter(clip: Clip, created: string): string {
  const lines = ['---'];
  const add = (key: string, value: string | null) => {
    if (value !== null) lines.push(`${key}: ${yamlString(value)}`);
  };
  add('title', oneLine(clip.title, 1000) ?? UNTITLED);
  add('source', clip.url);
  add('author', oneLine(clip.author, 300));
  add('site', oneLine(clip.siteName, 300));
  const published = publishedDate(clip.published);
  if (published) lines.push(`published: ${published}`);
  lines.push(`created: ${created}`);
  add('description', oneLine(clip.description, 500));
  lines.push('tags:', `  - ${CLIP_TAG}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

export interface NoteOptions {
  /** Default {@link DEFAULT_FOLDER}. */
  folder?: string;
  /** Default the clip's title. */
  basename?: string;
  /** `YYYY-MM-DD`, default today on this device. */
  created?: string;
}

/** The request body of POST /api/files (API.md §8.2) for a clip. */
export interface CreateClipRequest {
  path: string;
  content: string;
  onConflict: 'rename';
}

/** The whole note: frontmatter, then the body. */
export function noteContent(clip: Clip, created: string): string {
  const body = clip.markdown.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return frontmatter(clip, created) + '\n' + (body ? body + '\n' : '');
}

export function composeNote(clip: Clip, options: NoteOptions = {}): CreateClipRequest {
  const folder = options.folder ?? DEFAULT_FOLDER;
  const basename = options.basename ?? clip.title;
  return {
    path: notePath(folder, basename),
    content: noteContent(clip, options.created ?? localDate()),
    onConflict: 'rename',
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every Markdown image of `url` (`![alt](url)` or `![alt](url "title")`, as turndown
 * writes them) with `embed`, the attachment's embed from POST /api/attachments (API.md §9.3).
 */
export function replaceImage(markdown: string, url: string, embed: string): string {
  const re = new RegExp(`!\\[[^\\]\\n]*\\]\\(<?${escapeRegExp(url)}>?(?: "(?:[^"\\\\]|\\\\.)*")?\\)`, 'g');
  return markdown.replace(re, () => embed);
}
