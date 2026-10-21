// Reading and writing `.canvas` files byte-stably (ROADMAP item 25). A document that has not
// changed is written back as the exact text it came from; a changed one is written in the layout
// it was read in (Obsidian's, by default), and every node, edge and top-level member that the edit
// did not touch keeps the exact text it had in the file, so a diff shows only what changed and
// fields this app does not know survive. The model never interprets unknown fields; they ride
// along inside the node and edge objects.
import { DEFAULT_FORMAT, type CanvasDoc, type CanvasEdge, type CanvasFormat, type CanvasNode } from './model';

export class CanvasParseError extends Error {}

/** Text of each array element and top-level value as it was in the file, by object identity. */
const rawText = new WeakMap<object, string>();

interface Member {
  key: string;
  start: number;
  end: number;
  /** For an array value: the spans of its elements. */
  elements: Array<[number, number]> | null;
}

// ---------- a lenient scanner over text JSON.parse has already accepted ----------

function skipWs(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    i++;
  }
  return i;
}

function skipString(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92) i += 2;
    else if (c === 34) return i + 1;
    else i++;
  }
  return i;
}

function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        i = skipString(s, i);
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  while (i < s.length && !',}] \t\n\r'.includes(s[i])) i++;
  return i;
}

function scanMembers(s: string): Map<string, Member> {
  const members = new Map<string, Member>();
  let i = skipWs(s, 0);
  if (s[i] !== '{') return members;
  i++;
  for (;;) {
    i = skipWs(s, i);
    if (i >= s.length || s[i] === '}') break;
    if (s[i] === ',') {
      i++;
      continue;
    }
    const keyEnd = skipString(s, i);
    const key = JSON.parse(s.slice(i, keyEnd)) as string;
    i = skipWs(s, keyEnd);
    i = skipWs(s, i + 1); // ':'
    const start = i;
    const end = skipValue(s, i);
    let elements: Array<[number, number]> | null = null;
    if (s[start] === '[') {
      elements = [];
      let j = start + 1;
      for (;;) {
        j = skipWs(s, j);
        if (j >= end || s[j] === ']') break;
        if (s[j] === ',') {
          j++;
          continue;
        }
        const elEnd = skipValue(s, j);
        elements.push([j, elEnd]);
        j = elEnd;
      }
    }
    members.set(key, { key, start, end, elements });
    i = end;
  }
  return members;
}

function detectFormat(text: string, keys: string[]): CanvasFormat {
  const trailingNewline = /\n$/.test(text);
  const body = text.replace(/\s+$/, '');
  if (!body.includes('\n')) return { layout: 'compact', indent: '', trailingNewline, keys };
  const firstKey = /^\{\n([ \t]+)"(?:[^"\\]|\\.)*":( ?)/.exec(body);
  if (firstKey && firstKey[2] === ' ') return { layout: 'pretty', indent: firstKey[1], trailingNewline, keys };
  return { layout: 'obsidian', indent: '\t', trailingNewline, keys };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parses `.canvas` text. An empty file is an empty canvas (Obsidian creates new canvases empty).
 * Throws `CanvasParseError` for text that is not a JSON Canvas object.
 */
export function parseCanvas(text: string): CanvasDoc {
  if (text.trim() === '') {
    const empty = { nodes: [], edges: [], extra: new Map() };
    return { ...empty, format: { ...DEFAULT_FORMAT, keys: [] }, origin: { text, ...empty } };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CanvasParseError(`This canvas is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(data)) throw new CanvasParseError('This file is not a JSON Canvas: its top level is not an object.');
  if (data.nodes !== undefined && !Array.isArray(data.nodes)) throw new CanvasParseError('This file is not a JSON Canvas: "nodes" is not a list.');
  if (data.edges !== undefined && !Array.isArray(data.edges)) throw new CanvasParseError('This file is not a JSON Canvas: "edges" is not a list.');
  const members = scanMembers(text);
  const keys = Object.keys(data);

  const record = (value: unknown, span: [number, number] | undefined) => {
    if (span && typeof value === 'object' && value !== null) rawText.set(value, text.slice(span[0], span[1]));
  };
  const nodes: CanvasNode[] = [];
  const nodeSpans = members.get('nodes')?.elements ?? [];
  const seen = new Set<string>();
  ((data.nodes as unknown[] | undefined) ?? []).forEach((n, i) => {
    if (!isObject(n)) return;
    // A node without a usable id gets one; the repaired node is written only when the canvas changes.
    if (typeof n.id !== 'string' || n.id === '' || seen.has(n.id)) n = { ...n, id: freshId(seen) };
    else record(n, nodeSpans[i]);
    seen.add((n as CanvasNode).id);
    nodes.push(n as CanvasNode);
  });
  const edges: CanvasEdge[] = [];
  const edgeSpans = members.get('edges')?.elements ?? [];
  ((data.edges as unknown[] | undefined) ?? []).forEach((e, i) => {
    if (!isObject(e)) return;
    if (typeof e.id !== 'string' || e.id === '' || seen.has(e.id)) e = { ...e, id: freshId(seen) };
    else record(e, edgeSpans[i]);
    seen.add((e as CanvasEdge).id);
    edges.push(e as CanvasEdge);
  });
  const extra = new Map<string, unknown>();
  for (const key of keys) {
    if (key === 'nodes' || key === 'edges') continue;
    const m = members.get(key);
    extra.set(key, data[key]);
    if (m) record(data[key], [m.start, m.end]);
  }
  rawScalars.set(extra, new Map(keys.filter((k) => extra.has(k) && members.has(k)).map((k) => [k, text.slice(members.get(k)!.start, members.get(k)!.end)])));
  return { nodes, edges, extra, format: detectFormat(text, keys), origin: { text, nodes, edges, extra } };
}

/** Raw text of top-level scalar members (strings and numbers cannot be WeakMap keys). */
const rawScalars = new WeakMap<object, Map<string, string>>();

function freshId(seen: Set<string>): string {
  let i = seen.size;
  for (;;) {
    const id = `repaired-${i++}`;
    if (!seen.has(id)) return id;
  }
}

function reindent(json: string, prefix: string): string {
  return json.replace(/\n/g, '\n' + prefix);
}

/** The text of one element or value in `format`: its original text when untouched. */
function valueText(value: unknown, format: CanvasFormat, depthPrefix: string): string {
  if (typeof value === 'object' && value !== null) {
    const raw = rawText.get(value);
    if (raw !== undefined && (format.layout !== 'obsidian' || !raw.includes('\n') || depthPrefix === '')) return raw;
  }
  if (format.layout === 'pretty') return reindent(JSON.stringify(value, null, format.indent), depthPrefix);
  return JSON.stringify(value);
}

function arrayText(items: readonly object[], format: CanvasFormat): string {
  if (items.length === 0) return '[]';
  if (format.layout === 'compact') return '[' + items.map((v) => valueText(v, format, '')).join(',') + ']';
  const inner = format.layout === 'pretty' ? format.indent + format.indent : '\t\t';
  const outer = format.layout === 'pretty' ? format.indent : '\t';
  return '[\n' + items.map((v) => inner + valueText(v, format, inner)).join(',\n') + '\n' + outer + ']';
}

/** Serializes a document; an unchanged one gives back exactly the text it was parsed from. */
export function serializeCanvas(doc: CanvasDoc): string {
  const o = doc.origin;
  if (o && o.nodes === doc.nodes && o.edges === doc.edges && o.extra === doc.extra) return o.text;
  const format = doc.format;
  const keys = [...format.keys.filter((k) => k === 'nodes' || k === 'edges' || doc.extra.has(k))];
  for (const k of doc.extra.keys()) if (!keys.includes(k)) keys.push(k);
  // A canvas lists its nodes and edges once it has any, and a bare one lists both (as Obsidian
  // writes them).
  const listBoth = doc.nodes.length > 0 || doc.edges.length > 0 || keys.length === 0;
  if (!keys.includes('nodes') && listBoth) keys.unshift('nodes');
  if (!keys.includes('edges') && listBoth) keys.splice(keys.indexOf('nodes') + 1, 0, 'edges');
  const scalars = o ? rawScalars.get(o.extra) : undefined;
  const parts = keys.map((key) => {
    let value: string;
    if (key === 'nodes') value = arrayText(doc.nodes, format);
    else if (key === 'edges') value = arrayText(doc.edges, format);
    else {
      const v = doc.extra.get(key);
      const raw = o && o.extra.get(key) === v ? scalars?.get(key) : undefined;
      value = raw ?? valueText(v, format, format.layout === 'pretty' ? format.indent : '');
    }
    const name = JSON.stringify(key);
    switch (format.layout) {
      case 'compact':
        return `${name}:${value}`;
      case 'pretty':
        return `${format.indent}${name}: ${value}`;
      default:
        return `\t${name}:${value}`;
    }
  });
  let text: string;
  if (parts.length === 0) text = '{}';
  else if (format.layout === 'compact') text = '{' + parts.join(',') + '}';
  else text = '{\n' + parts.join(',\n') + '\n}';
  return format.trailingNewline ? text + '\n' : text;
}

/** The text a new, empty canvas starts with (Obsidian's layout). */
export function newCanvasText(): string {
  return serializeCanvas({ nodes: [], edges: [], extra: new Map(), format: DEFAULT_FORMAT, origin: null });
}

/** Records the text an object would be written as, for objects built from another document's text. */
export function rawOf(value: object): string | undefined {
  return rawText.get(value);
}
