// Drawing files (ROADMAP item 5, DESIGN §6.8.1): `.excalidraw` is plain Excalidraw JSON, as
// excalidraw.com saves it; `.excalidraw.md` is Obsidian Excalidraw's Markdown file, whose
// `%%`-wrapped `## Drawing` section holds the scene as a json or compressed-json (LZ-String
// base64) block, next to a `## Text Elements` section and an optional `## Embedded Files` one.
//
// Pure functions without the Excalidraw package: parsing, writing and merging run in the main
// chunk (the session's merge hook), while the editor itself is a lazy chunk. Writing a Markdown
// drawing replaces only the drawing block, the text-elements and element-links sections and, for
// images added here, appends to the embedded-files section; every other byte of the file stays as
// it was.
import { compressToBase64 } from 'lz-string';
import { parseWikiBody } from '../../features/syntax';
import { decompressFromBase64 } from './lzString';
import { EXCALIDRAW_SOURCE } from './newDrawing';
import { firstLink, shownFor } from './textLinks';

export type DrawingFormat = 'excalidraw' | 'markdown';

/** How an `.excalidraw.md` drawing block holds the scene. */
export type DrawingEncoding = 'json' | 'compressed-json';

/** An element as stored in the file. Unknown properties are kept as they are. */
export interface SceneElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  [key: string]: unknown;
}

/**
 * A `files` entry. Embedded images carry a `dataURL`; images stored as vault attachments carry
 * the attachment's vault `path` instead (DESIGN §6.8.1).
 */
export interface StoredFile {
  id: string;
  mimeType: string;
  created?: number;
  dataURL?: string;
  path?: string;
  [key: string]: unknown;
}

export interface Scene {
  type: string;
  version: number;
  source?: string;
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, StoredFile>;
  [key: string]: unknown;
}

export interface TextRange {
  from: number;
  to: number;
}

/** One `text ^id` entry of the Text Elements section. */
export interface TextEntry {
  id: string;
  raw: string;
}

/** One `id: link` entry of the Element Links section. */
export interface LinkEntry {
  id: string;
  link: string;
}

export type EmbeddedRef =
  | { kind: 'link'; target: string; subpath?: string }
  | { kind: 'url'; url: string }
  | { kind: 'latex'; latex: string }
  | { kind: 'other' };

/** One `fileId: value` entry of the Embedded Files section. */
export interface EmbeddedEntry {
  id: string;
  value: string;
  ref: EmbeddedRef;
}

/** Where the managed parts of an `.excalidraw.md` file are; everything else is left alone. */
export interface MarkdownParts {
  text: string;
  /**
   * The drawing block's lines between the fences (with the last line's `\n`) and its opening fence
   * line (without it), or null when there is none yet.
   */
  drawing: { range: TextRange; fence: TextRange; encoding: DrawingEncoding } | null;
  /** The Text Elements section's body (after its heading line). */
  textSection: TextRange | null;
  texts: TextEntry[];
  /** The Element Links section's body (after its heading line). */
  linkSection: TextRange | null;
  links: LinkEntry[];
  /** The Embedded Files section's body (after its heading line). */
  embeddedSection: TextRange | null;
  embedded: EmbeddedEntry[];
  /** Where new sections go: the `%%` line before the drawing heading, or the heading itself. */
  insertAt: number;
}

export interface Drawing {
  format: DrawingFormat;
  scene: Scene;
  markdown: MarkdownParts | null;
}

export type ParseResult =
  | { ok: true; drawing: Drawing }
  | { ok: false; reason: 'not-a-drawing' | 'malformed'; message: string };

export { EXCALIDRAW_SOURCE, newDrawingContent } from './newDrawing';

/** Excalidraw's export appState keys (`cleanAppStateForExport`): the ones a file carries. */
export const EXPORTED_APP_STATE = ['gridSize', 'gridStep', 'gridModeEnabled', 'viewBackgroundColor'] as const;

export function drawingFormat(path: string): DrawingFormat {
  return path.toLowerCase().endsWith('.md') ? 'markdown' : 'excalidraw';
}

/** The names the drawing view claims (register.ts): `.excalidraw` and `.excalidraw.md`. */
export function isDrawingPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.excalidraw') || lower.endsWith('.excalidraw.md');
}

// ---------- the scene JSON ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Checks the shape the app relies on; unknown properties are kept. */
function toScene(value: unknown): Scene | string {
  if (!isObject(value)) return 'The drawing is not a JSON object.';
  if (value.type !== undefined && value.type !== 'excalidraw') return `This is not an Excalidraw drawing (type “${String(value.type)}”).`;
  const elements = value.elements ?? [];
  if (!Array.isArray(elements)) return 'The drawing has no element list.';
  const valid: SceneElement[] = [];
  for (const e of elements) {
    if (!isObject(e) || typeof e.id !== 'string' || typeof e.type !== 'string') return 'The drawing has an element without an id or type.';
    valid.push({ ...e, version: typeof e.version === 'number' ? e.version : 1, versionNonce: typeof e.versionNonce === 'number' ? e.versionNonce : 0 } as SceneElement);
  }
  const files: Record<string, StoredFile> = {};
  if (isObject(value.files)) {
    for (const [id, f] of Object.entries(value.files)) {
      if (isObject(f)) files[id] = { ...f, id: typeof f.id === 'string' ? f.id : id, mimeType: typeof f.mimeType === 'string' ? f.mimeType : 'application/octet-stream' };
    }
  }
  return {
    ...value,
    type: 'excalidraw',
    version: typeof value.version === 'number' ? value.version : 2,
    elements: valid,
    appState: isObject(value.appState) ? value.appState : {},
    files,
  };
}

function parseSceneJson(json: string): Scene | string {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return `The drawing is not valid JSON (${(e as Error).message}).`;
  }
  return toScene(value);
}

function emptyScene(): Scene {
  return { type: 'excalidraw', version: 2, source: EXCALIDRAW_SOURCE, elements: [], appState: {}, files: {} };
}

// ---------- LZ-String blocks (Obsidian Excalidraw's compressed-json) ----------

/** Compresses like the Obsidian plugin: LZ-String base64 in 256-character chunks separated by blank lines. */
export function compressDrawing(json: string): string {
  const data = compressToBase64(json);
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 256) chunks.push(data.slice(i, i + 256));
  return chunks.join('\n\n');
}

/**
 * Larger blocks are not decompressed: crafted input can expand quadratically, and a real drawing
 * this size would be far past the text size limit as plain JSON (the server has the same bound).
 */
export const MAX_DRAWING_JSON = 16 * 1024 * 1024;

/**
 * The JSON of a compressed-json block (line breaks ignored), or null when it does not decompress
 * or would be longer than MAX_DRAWING_JSON characters.
 */
export function decompressDrawing(data: string): string | null {
  try {
    return decompressFromBase64(data, MAX_DRAWING_JSON) || null;
  } catch {
    // Out of memory or past the engine's longest string: unreadable, like any broken block.
    return null;
  }
}

// ---------- `.excalidraw.md` structure ----------

interface Line {
  from: number;
  /** End of the line's text (before `\n`). */
  to: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from <= text.length) {
    const nl = text.indexOf('\n', from);
    const to = nl < 0 ? text.length : nl;
    lines.push({ from, to, text: text.slice(from, to) });
    if (nl < 0) break;
    from = nl + 1;
  }
  return lines;
}

const DRAWING_HEADING = /^#{1,2} Drawing[ \t]*$/;
const FENCE_OPEN = /^```(json|compressed-json)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const TEXT_HEADING = /^#{1,2} Text Elements[ \t]*$/;
const EMBEDDED_HEADING = /^#{1,2} Embedded [Ff]iles[ \t]*$/;
const LINKS_HEADING = /^#{1,2} Element Links[ \t]*$/;
/** An Element Links line: the plugin reads `^(.{8}):\s*(.*)$`. */
const LINK_LINE = /^([^\s:]{8}):/;
const TEXT_SECTION_END = /^#{1,2} (Element Links|Embedded [Ff]iles|Drawing)[ \t]*$/;
const COMMENT_LINE = /^%%[ \t]*$/;
const ANY_HEADING = /^#{1,6} /;
/** ` ^id` closing a text entry (the plugin's ids are 8 characters). */
const TEXT_ID = /[ \t\n]\^([A-Za-z0-9_-]{8})[ \t]*(?:\n+|$)/g;
const PLUGIN_FRONTMATTER = /^---\n(?:[^\n]*\n)*?excalidraw-plugin[ \t]*:/;
/** The plugin's raw mode shows each text's Markdown source as it is (the default, parsed, shows links as their text). */
const RAW_MODE_FRONTMATTER = /^---\n(?:[^\n]*\n)*?excalidraw-plugin[ \t]*:[ \t]*raw[ \t]*\n/;

function lineEnd(text: string, line: Line): number {
  return line.to < text.length ? line.to + 1 : line.to;
}

/** Splits a Text Elements body into its `text ^id` entries. */
export function parseTextEntries(body: string): TextEntry[] {
  const entries: TextEntry[] = [];
  let pos = 0;
  for (const m of body.matchAll(TEXT_ID)) {
    entries.push({ id: m[1], raw: body.slice(pos, m.index) });
    pos = m.index + m[0].length;
  }
  return entries;
}

export function parseEmbeddedValue(value: string): EmbeddedRef {
  const v = value.trim();
  const link = /^!?\[\[([^\]\n]+)\]\]/.exec(v);
  if (link) {
    const { target, subpath } = parseWikiBody(link[1]);
    return subpath ? { kind: 'link', target, subpath } : { kind: 'link', target };
  }
  const latex = /^\$\$([\s\S]*)\$\$$/.exec(v);
  if (latex) return { kind: 'latex', latex: latex[1] };
  if (/^https?:\/\//i.test(v)) return { kind: 'url', url: v.split(/\s/)[0] };
  return { kind: 'other' };
}

function parseLinkEntries(body: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  for (const line of body.split('\n')) {
    const m = LINK_LINE.exec(line);
    if (!m) continue;
    // The value without the spaces and tabs around it, trimmed by hand (a pattern for it backtracks).
    let from = m[0].length;
    let to = line.length;
    while (from < to && (line[from] === ' ' || line[from] === '\t')) from++;
    while (to > from && (line[to - 1] === ' ' || line[to - 1] === '\t')) to--;
    if (to > from) entries.push({ id: m[1], link: line.slice(from, to) });
  }
  return entries;
}

function parseEmbeddedEntries(body: string): EmbeddedEntry[] {
  const entries: EmbeddedEntry[] = [];
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z0-9_-]+): (.+)$/.exec(line);
    if (m) entries.push({ id: m[1], value: m[2], ref: parseEmbeddedValue(m[2]) });
  }
  return entries;
}

/** Finds the managed parts of an `.excalidraw.md` text (LF). */
export function markdownParts(text: string): MarkdownParts {
  const lines = linesOf(text);
  let drawingLine = -1;
  let drawing: MarkdownParts['drawing'] = null;
  // The last `## Drawing` heading followed by a json block: the plugin writes it at the end. The
  // walk back remembers the nearest closing fence, so crafted input stays linear.
  let close = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (i + 2 < lines.length && FENCE_CLOSE.test(lines[i + 2].text)) close = i + 2;
    if (close < 0 || !DRAWING_HEADING.test(lines[i].text)) continue;
    const fence = FENCE_OPEN.exec(lines[i + 1].text);
    if (!fence) continue;
    drawingLine = i;
    drawing = {
      range: { from: lines[i + 2].from, to: lines[close].from },
      fence: { from: lines[i + 1].from, to: lines[i + 1].to },
      encoding: fence[1] as 'json' | 'compressed-json',
    };
    break;
  }
  const limit = drawingLine >= 0 ? drawingLine : lines.length;

  let textSection: TextRange | null = null;
  let linkSection: TextRange | null = null;
  let embeddedSection: TextRange | null = null;
  /** A section's body: from after line `i` to the next heading or `%%` line. */
  const sectionAfter = (i: number): TextRange => {
    const from = lineEnd(text, lines[i]);
    let end = limit < lines.length ? lines[limit].from : text.length;
    for (let j = i + 1; j < limit; j++) {
      const t = lines[j].text;
      if (ANY_HEADING.test(t) || COMMENT_LINE.test(t)) {
        end = lines[j].from;
        break;
      }
    }
    return { from, to: Math.max(from, end) };
  };
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!linkSection && LINKS_HEADING.test(line.text)) {
      linkSection = sectionAfter(i);
      continue;
    }
    if (!textSection && TEXT_HEADING.test(line.text)) {
      const from = lineEnd(text, line);
      let end = limit < lines.length ? lines[limit].from : text.length;
      for (let j = i + 1; j < limit; j++) {
        const t = lines[j].text;
        if (TEXT_SECTION_END.test(t) || (COMMENT_LINE.test(t) && j + 1 === drawingLine)) {
          end = lines[j].from;
          break;
        }
      }
      textSection = { from, to: Math.max(from, end) };
    } else if (!embeddedSection && EMBEDDED_HEADING.test(line.text) && (!textSection || line.from >= textSection.to)) {
      embeddedSection = sectionAfter(i);
    }
  }

  let insertAt = text.length;
  if (drawingLine >= 0) {
    insertAt = lines[drawingLine].from;
    if (drawingLine > 0 && COMMENT_LINE.test(lines[drawingLine - 1].text)) insertAt = lines[drawingLine - 1].from;
  }
  return {
    text,
    drawing,
    textSection,
    texts: textSection ? parseTextEntries(text.slice(textSection.from, textSection.to)) : [],
    linkSection,
    links: linkSection ? parseLinkEntries(text.slice(linkSection.from, linkSection.to)) : [],
    embeddedSection,
    embedded: embeddedSection ? parseEmbeddedEntries(text.slice(embeddedSection.from, embeddedSection.to)) : [],
    insertAt,
  };
}

/**
 * The text of an `.excalidraw.md` file with its managed parts blanked out: two versions with the
 * same rest differ only in the drawing (merging, DESIGN §6.8.1).
 */
export function markdownRest(parts: MarkdownParts): string {
  // The fence line names the block's encoding, which a draft may change.
  const ranges = [parts.drawing?.fence, parts.drawing?.range, parts.textSection, parts.linkSection, parts.embeddedSection]
    .filter((r): r is TextRange => !!r)
    .sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    out += parts.text.slice(pos, r.from) + '\u0000';
    pos = r.to;
  }
  return out + parts.text.slice(pos);
}

// ---------- parsing ----------

/** Parses a drawing file's text (LF). */
export function parseDrawing(format: DrawingFormat, text: string): ParseResult {
  if (format === 'excalidraw') {
    if (text.trim() === '') return { ok: true, drawing: { format, scene: emptyScene(), markdown: null } };
    const scene = parseSceneJson(text);
    if (typeof scene === 'string') return { ok: false, reason: 'malformed', message: scene };
    return { ok: true, drawing: { format, scene, markdown: null } };
  }
  const parts = markdownParts(text);
  if (!parts.drawing) {
    // A file the plugin made but never drew in is an empty drawing; anything else is a note.
    if (PLUGIN_FRONTMATTER.test(text)) return { ok: true, drawing: { format, scene: emptyScene(), markdown: parts } };
    return { ok: false, reason: 'not-a-drawing', message: 'This file has no Excalidraw drawing section.' };
  }
  const block = text.slice(parts.drawing.range.from, parts.drawing.range.to);
  let json: string | null = block;
  if (parts.drawing.encoding === 'compressed-json') {
    json = decompressDrawing(block);
    if (json === null) return { ok: false, reason: 'malformed', message: 'The compressed drawing could not be decompressed.' };
  }
  if (json.trim() === '') return { ok: true, drawing: { format, scene: emptyScene(), markdown: parts } };
  const scene = parseSceneJson(json);
  if (typeof scene === 'string') return { ok: false, reason: 'malformed', message: scene };
  return { ok: true, drawing: { format, scene: withSectionLinks(withSectionTexts(scene, parts), parts), markdown: parts } };
}

/**
 * The Text Elements section takes priority over the JSON too: a text whose entry differs from its
 * `rawText` (a rename rewrote a link in the section, §5.6) takes the entry as its source, as the
 * plugin does when it loads the file. The element link that came from the old source follows it,
 * and so does the shown text when it can be derived (by the rules the old source was shown with).
 */
function withSectionTexts(scene: Scene, parts: MarkdownParts): Scene {
  if (parts.texts.length === 0) return scene;
  const entries = new Map(parts.texts.map((t) => [t.id, t.raw]));
  const mode = RAW_MODE_FRONTMATTER.test(parts.text) ? 'raw' : 'parsed';
  let changed = false;
  const elements = scene.elements.map((e) => {
    const raw = entries.get(e.id);
    if (!isLiveText(e) || raw === undefined || typeof e.rawText !== 'string' || e.rawText === raw) return e;
    changed = true;
    const next: SceneElement = { ...e, rawText: raw };
    const link = firstLink(raw);
    if (link !== null && (!e.link || e.link === firstLink(e.rawText))) next.link = link;
    const shown = typeof e.originalText === 'string' ? e.originalText : typeof e.text === 'string' ? e.text : null;
    const derived = shown === null ? null : shownFor(raw, e.rawText, shown, mode);
    if (derived !== null && derived !== shown) {
      next.originalText = derived;
      // A wrapped text (in a container) keeps its lines until it is next edited.
      if (e.text === shown) next.text = derived;
    }
    return next;
  });
  return changed ? { ...scene, elements } : scene;
}

/**
 * The Element Links section takes priority over the JSON, as in the plugin: a link that a rename
 * rewrote there (the server updates the links of notes) is the one the drawing shows and saves.
 */
function withSectionLinks(scene: Scene, parts: MarkdownParts): Scene {
  if (parts.links.length === 0) return scene;
  const links = new Map(parts.links.map((e) => [e.id, e.link]));
  let changed = false;
  const elements = scene.elements.map((e) => {
    const link = links.get(e.id);
    if (link === undefined || e.link === link) return e;
    changed = true;
    return { ...e, link };
  });
  return changed ? { ...scene, elements } : scene;
}

// ---------- writing ----------

export interface WriteOptions {
  /** The Text Elements entry of a text element; defaults to its original (unwrapped) text. */
  rawText?(element: SceneElement): string | undefined;
  /** Embedded Files entries to add (Markdown drawings): `fileId: value`. */
  addEmbedded?: Array<{ id: string; value: string }>;
  /** The drawing block's encoding, when not the one it had (a draft skips the compression). */
  encoding?: DrawingEncoding;
}

export function isLiveText(e: SceneElement): boolean {
  return e.type === 'text' && !e.isDeleted;
}

function defaultRaw(e: SceneElement): string {
  return typeof e.originalText === 'string' ? e.originalText : typeof e.text === 'string' ? e.text : '';
}

/**
 * The Text Elements entries for `elements`: existing entries keep their order, new ones follow in
 * scene order. Returns null when they equal the existing entries (the body stays byte-identical).
 */
function textEntriesFor(parts: MarkdownParts, elements: readonly SceneElement[], rawText: (e: SceneElement) => string): TextEntry[] | null {
  const live = new Map<string, string>();
  for (const e of elements) if (isLiveText(e)) live.set(e.id, rawText(e));
  const out: TextEntry[] = [];
  for (const entry of parts.texts) {
    const raw = live.get(entry.id);
    if (raw === undefined) continue;
    out.push({ id: entry.id, raw });
    live.delete(entry.id);
  }
  for (const [id, raw] of live) out.push({ id, raw });
  const same = out.length === parts.texts.length && out.every((e, i) => e.id === parts.texts[i].id && e.raw === parts.texts[i].raw);
  return same && parts.textSection ? null : out;
}

function liveLink(e: SceneElement): string | null {
  return !e.isDeleted && typeof e.link === 'string' && e.link.trim() !== '' ? e.link : null;
}

/**
 * The Element Links entries for `elements`: listed elements keep their place with their current
 * link, or lose their entry with it; an element with an 8-character id (the plugin's ids, which
 * its section requires) whose link changed since `loaded` gets a new entry. Other links stay in
 * the JSON only, as the plugin keeps the link it derives from a text's [[link]], and as it adopts
 * links of longer ids when it next saves. Returns null when nothing changed (the body stays
 * byte-identical).
 */
function linkEntriesFor(parts: MarkdownParts, loaded: readonly SceneElement[], elements: readonly SceneElement[]): LinkEntry[] | null {
  const live = new Map<string, string>();
  for (const e of elements) {
    const link = liveLink(e);
    if (link !== null) live.set(e.id, link);
  }
  const before = new Map(loaded.map((e) => [e.id, liveLink(e)]));
  const out: LinkEntry[] = [];
  const listed = new Set<string>();
  for (const entry of parts.links) {
    listed.add(entry.id);
    const link = live.get(entry.id);
    if (link !== undefined) out.push({ id: entry.id, link });
  }
  for (const [id, link] of live) {
    if (!listed.has(id) && isMarkdownTextId(id) && before.get(id) !== link) out.push({ id, link });
  }
  const same = out.length === parts.links.length && out.every((e, i) => e.id === parts.links[i].id && e.link === parts.links[i].link);
  return same ? null : out;
}

function linkBody(entries: readonly LinkEntry[]): string {
  return entries.map((e) => `${e.id}: ${e.link}\n\n`).join('');
}

function textBody(entries: readonly TextEntry[]): string {
  return entries.map((e) => `${e.raw} ^${e.id}\n\n`).join('');
}

function embeddedBody(entries: ReadonlyArray<{ id: string; value: string }>): string {
  return entries.map((e) => `${e.id}: ${e.value}\n\n`).join('');
}

interface Replacement {
  from: number;
  to: number;
  insert: string;
}

function applyReplacements(text: string, replacements: Replacement[]): string {
  let out = text;
  for (const r of [...replacements].sort((a, b) => b.from - a.from || b.to - a.to)) out = out.slice(0, r.from) + r.insert + out.slice(r.to);
  return out;
}

/** The scene as the drawing block or `.excalidraw` file holds it. */
export function sceneJson(format: DrawingFormat, scene: Scene): string {
  // excalidraw.com indents with two spaces; the Obsidian plugin with tabs.
  return JSON.stringify(scene, null, format === 'markdown' ? '\t' : 2);
}

/**
 * The file text for `scene`, written into `drawing` (the parsed file it replaces). A Markdown
 * drawing keeps every byte outside its drawing block, its Text Elements and Element Links
 * sections and (when images were added) its Embedded Files section.
 */
export function writeDrawing(drawing: Drawing, scene: Scene, opts: WriteOptions = {}): string {
  if (drawing.format === 'excalidraw' || !drawing.markdown) return sceneJson('excalidraw', scene);
  const parts = drawing.markdown;
  const rawText = (e: SceneElement) => opts.rawText?.(e) ?? defaultRaw(e);
  // The plugin keeps each text element's Markdown source in `rawText` too.
  const elements = scene.elements.map((e) => (isLiveText(e) ? { ...e, rawText: rawText(e) } : e));
  const json = sceneJson('markdown', { ...scene, elements });
  const encoding = opts.encoding ?? parts.drawing?.encoding ?? 'json';
  const block = (encoding === 'compressed-json' ? compressDrawing(json) : json) + '\n';
  const entries = textEntriesFor(parts, elements, rawText);
  const links = linkEntriesFor(parts, drawing.scene.elements, elements);
  const newLinkSection = links && links.length > 0 && !parts.linkSection ? '## Element Links\n' + linkBody(links) : '';
  const known = new Set(parts.embedded.map((e) => e.id));
  const added: Array<{ id: string; value: string }> = [];
  for (const e of opts.addEmbedded ?? []) {
    if (known.has(e.id)) continue;
    known.add(e.id);
    added.push(e);
  }

  if (!parts.drawing) {
    // A plugin file without a drawing yet: the data part goes at the end.
    const base = parts.text === '' || parts.text.endsWith('\n') ? parts.text : parts.text + '\n';
    return (
      base +
      '\n# Excalidraw Data\n\n## Text Elements\n' +
      textBody(entries ?? []) +
      newLinkSection +
      (added.length > 0 ? '## Embedded Files\n' + embeddedBody(added) : '') +
      '%%\n## Drawing\n```' +
      encoding +
      '\n' +
      block +
      '```\n%%\n'
    );
  }

  const replacements: Replacement[] = [{ ...parts.drawing.range, insert: block }];
  if (encoding !== parts.drawing.encoding) replacements.push({ ...parts.drawing.fence, insert: '```' + encoding });
  let inserted = '';
  if (links && parts.linkSection) replacements.push({ ...parts.linkSection, insert: linkBody(links) });
  if (parts.textSection) {
    // A new Element Links section follows the text elements, where the plugin writes it.
    if (entries || newLinkSection) {
      const body = entries ? textBody(entries) : parts.text.slice(parts.textSection.from, parts.textSection.to);
      const gap = !newLinkSection || body === '' || body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
      replacements.push({ ...parts.textSection, insert: body + gap + newLinkSection });
    }
  } else {
    if (entries && entries.length > 0) inserted += '## Text Elements\n' + textBody(entries);
    inserted += newLinkSection;
  }
  if (added.length > 0) {
    if (parts.embeddedSection) {
      const end = parts.embeddedSection.to;
      const before = parts.text.slice(parts.embeddedSection.from, end);
      replacements.push({ from: end, to: end, insert: (before === '' || before.endsWith('\n') ? '' : '\n') + embeddedBody(added) });
    } else {
      inserted += '## Embedded Files\n' + embeddedBody(added);
    }
  }
  if (inserted) {
    const before = parts.text.slice(0, parts.insertAt);
    const gap = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    replacements.push({ from: parts.insertAt, to: parts.insertAt, insert: gap + inserted });
  }
  return applyReplacements(parts.text, replacements);
}

// ---------- text element ids in Markdown drawings ----------

/** The plugin's block ids: 8 characters that Obsidian block references accept. */
export function isMarkdownTextId(id: string): boolean {
  return /^[A-Za-z0-9_-]{8}$/.test(id);
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A deterministic 8-character id for `id` (FNV-1a based), avoiding `taken`. */
export function shortId(id: string, taken: ReadonlySet<string>): string {
  for (let salt = 0; ; salt++) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193 ^ salt;
    const input = salt === 0 ? id : `${id}#${salt}`;
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
      const word = i < 4 ? h1 : h2;
      out += ID_ALPHABET[(word >>> ((i % 4) * 8)) % ID_ALPHABET.length];
    }
    if (!taken.has(out)) return out;
  }
}

/** Replaces element ids, and every reference to them, by `map`. Elements without a match are kept as they are. */
export function renameElementIds<T extends SceneElement>(elements: readonly T[], map: ReadonlyMap<string, string>): T[] {
  if (map.size === 0) return [...elements];
  const re = (id: unknown) => (typeof id === 'string' ? (map.get(id) ?? id) : id);
  return elements.map((e) => {
    const next: Record<string, unknown> = { ...e };
    let changed = false;
    const set = (key: string, value: unknown) => {
      if (next[key] !== value) {
        next[key] = value;
        changed = true;
      }
    };
    set('id', re(e.id));
    if (typeof e.containerId === 'string') set('containerId', re(e.containerId));
    if (typeof e.frameId === 'string') set('frameId', re(e.frameId));
    if (Array.isArray(e.boundElements) && e.boundElements.some((b) => isObject(b) && map.has(b.id as string))) {
      set('boundElements', e.boundElements.map((b) => (isObject(b) && map.has(b.id as string) ? { ...b, id: re(b.id) } : b)));
    }
    for (const key of ['startBinding', 'endBinding']) {
      const binding = e[key];
      if (isObject(binding) && typeof binding.elementId === 'string' && map.has(binding.elementId)) set(key, { ...binding, elementId: re(binding.elementId) });
    }
    return changed ? (next as T) : e;
  });
}
