// Drawing files (ROADMAP item 5, DESIGN §6.8.1): `.excalidraw` is plain Excalidraw JSON, as
// excalidraw.com saves it; `.excalidraw.md` is Obsidian Excalidraw's Markdown file, whose
// `%%`-wrapped `## Drawing` section holds the scene as a json or compressed-json (LZ-String
// base64) block, next to a `## Text Elements` section and an optional `## Embedded Files` one.
//
// Pure functions without the Excalidraw package: parsing, writing and merging run in the main
// chunk (the session's merge hook), while the editor itself is a lazy chunk. Writing a Markdown
// drawing replaces only the drawing block, the text-elements section and, for images added here,
// appends to the embedded-files section; every other byte of the file stays as it was.
import { compressToBase64, decompressFromBase64 } from 'lz-string';
import { parseWikiBody } from '../../features/syntax';

export type DrawingFormat = 'excalidraw' | 'markdown';

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

export type EmbeddedRef =
  | { kind: 'link'; target: string }
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
  /** The drawing block's lines between the fences (with the last line's `\n`), or null when there is none yet. */
  drawing: { range: TextRange; encoding: 'json' | 'compressed-json' } | null;
  /** The Text Elements section's body (after its heading line). */
  textSection: TextRange | null;
  texts: TextEntry[];
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

export const EXCALIDRAW_SOURCE = 'https://github.com/rjgehan/notesapp';

/** Excalidraw's export appState keys (`cleanAppStateForExport`): the ones a file carries. */
export const EXPORTED_APP_STATE = ['gridSize', 'gridStep', 'gridModeEnabled', 'viewBackgroundColor'] as const;

export function drawingFormat(path: string): DrawingFormat {
  return path.toLowerCase().endsWith('.md') ? 'markdown' : 'excalidraw';
}

/** The content of a new `.excalidraw` file. */
export function newDrawingContent(): string {
  const scene: Scene = {
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_SOURCE,
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: '#ffffff' },
    files: {},
  };
  return JSON.stringify(scene, null, 2);
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

/** The JSON of a compressed-json block (line breaks ignored), or null when it does not decompress. */
export function decompressDrawing(data: string): string | null {
  const json = decompressFromBase64(data.replace(/\s+/g, ''));
  return json ? json : null;
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
const TEXT_SECTION_END = /^#{1,2} (Element Links|Embedded [Ff]iles|Drawing)[ \t]*$/;
const COMMENT_LINE = /^%%[ \t]*$/;
const ANY_HEADING = /^#{1,6} /;
/** ` ^id` closing a text entry (the plugin's ids are 8 characters). */
const TEXT_ID = /[ \t\n]\^([A-Za-z0-9_-]{8})[ \t]*(?:\n+|$)/g;
const PLUGIN_FRONTMATTER = /^---\n(?:[^\n]*\n)*?excalidraw-plugin[ \t]*:/;

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
  if (link) return { kind: 'link', target: parseWikiBody(link[1]).target };
  const latex = /^\$\$([\s\S]*)\$\$$/.exec(v);
  if (latex) return { kind: 'latex', latex: latex[1] };
  if (/^https?:\/\//i.test(v)) return { kind: 'url', url: v.split(/\s/)[0] };
  return { kind: 'other' };
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
  // The last `## Drawing` heading followed by a json block: the plugin writes it at the end.
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!DRAWING_HEADING.test(lines[i].text)) continue;
    const fence = FENCE_OPEN.exec(lines[i + 1].text);
    if (!fence) continue;
    let close = -1;
    for (let j = i + 2; j < lines.length; j++) {
      if (FENCE_CLOSE.test(lines[j].text)) {
        close = j;
        break;
      }
    }
    if (close < 0) continue;
    drawingLine = i;
    drawing = { range: { from: lines[i + 2].from, to: lines[close].from }, encoding: fence[1] as 'json' | 'compressed-json' };
    break;
  }
  const limit = drawingLine >= 0 ? drawingLine : lines.length;

  let textSection: TextRange | null = null;
  let embeddedSection: TextRange | null = null;
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
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
      const from = lineEnd(text, line);
      let end = limit < lines.length ? lines[limit].from : text.length;
      for (let j = i + 1; j < limit; j++) {
        const t = lines[j].text;
        if (ANY_HEADING.test(t) || COMMENT_LINE.test(t)) {
          end = lines[j].from;
          break;
        }
      }
      embeddedSection = { from, to: Math.max(from, end) };
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
  const ranges = [parts.drawing?.range, parts.textSection, parts.embeddedSection].filter((r): r is TextRange => !!r).sort((a, b) => a.from - b.from);
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
  return { ok: true, drawing: { format, scene, markdown: parts } };
}

// ---------- writing ----------

export interface WriteOptions {
  /** The Text Elements entry of a text element; defaults to its original (unwrapped) text. */
  rawText?(element: SceneElement): string | undefined;
  /** Embedded Files entries to add (Markdown drawings): `fileId: value`. */
  addEmbedded?: Array<{ id: string; value: string }>;
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
 * drawing keeps every byte outside its drawing block, Text Elements section and (when images
 * were added) Embedded Files section.
 */
export function writeDrawing(drawing: Drawing, scene: Scene, opts: WriteOptions = {}): string {
  if (drawing.format === 'excalidraw' || !drawing.markdown) return sceneJson('excalidraw', scene);
  const parts = drawing.markdown;
  const rawText = (e: SceneElement) => opts.rawText?.(e) ?? defaultRaw(e);
  // The plugin keeps each text element's Markdown source in `rawText` too.
  const elements = scene.elements.map((e) => (isLiveText(e) ? { ...e, rawText: rawText(e) } : e));
  const json = sceneJson('markdown', { ...scene, elements });
  const encoding = parts.drawing?.encoding ?? 'json';
  const block = (encoding === 'compressed-json' ? compressDrawing(json) : json) + '\n';
  const entries = textEntriesFor(parts, elements, rawText);
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
      (added.length > 0 ? '## Embedded Files\n' + embeddedBody(added) : '') +
      '%%\n## Drawing\n```json\n' +
      block +
      '```\n%%\n'
    );
  }

  const replacements: Replacement[] = [{ ...parts.drawing.range, insert: block }];
  let inserted = '';
  if (entries) {
    if (parts.textSection) replacements.push({ ...parts.textSection, insert: textBody(entries) });
    else if (entries.length > 0) inserted += '## Text Elements\n' + textBody(entries);
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
