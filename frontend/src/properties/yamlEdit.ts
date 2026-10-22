// Typed property edits on a note's frontmatter YAML (ROADMAP item 13, DESIGN §6.38), made the way
// the server's rename is made: a change rewrites only the lines of the property it touches (or,
// for a rename, only the key's characters), so every other byte, comment, quoting style and line
// ending stays as it was. The YAML is never re-serialized. New values are written as Obsidian
// writes them: lists in block style, an empty value as `key:`.
import { isMap, isScalar, parseDocument, stringify, type Pair } from 'yaml';

/** A value as the editor writes it; null writes an empty property (`key:`). */
export type EditValue = string | number | boolean | string[] | null;

export interface PropertyEntry {
  /** The key as written (its parsed value). */
  key: string;
  value: unknown;
  /** The property's lines in the YAML: from its key's line start to the end of its value's last line. */
  from: number;
  to: number;
  /** The key's own characters. */
  keyFrom: number;
  keyTo: number;
}

export interface ParsedProperties {
  entries: PropertyEntry[];
  /** Why the YAML cannot be edited as properties (invalid, or not a mapping); null when it can. */
  error: string | null;
}

export class PropertyEditError extends Error {}

type Ranged = { range?: [number, number, number] | null };

/** The top-level properties of the YAML, with where each one is written. */
export function readProperties(yaml: string): ParsedProperties {
  const doc = parseDocument(yaml, { uniqueKeys: false });
  if (doc.errors.length) return { entries: [], error: doc.errors[0].message.split('\n')[0] };
  const contents = doc.contents;
  if (contents === null || (isScalar(contents) && (contents.value === null || contents.value === undefined))) return { entries: [], error: null };
  if (!isMap(contents)) return { entries: [], error: 'The frontmatter is not a list of properties' };
  if (contents.flow) return { entries: [], error: 'The properties are written in flow style ({ … }); edit them as YAML' };
  const pairs = contents.items as Pair[];
  const entries: PropertyEntry[] = [];
  const js = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown> | null;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!isScalar(pair.key) || !(pair.key as Ranged).range) return { entries: [], error: 'A property has a key that is not text; edit it as YAML' };
    const keyRange = (pair.key as Ranged).range!;
    const key = String(pair.key.value);
    const from = lineStart(yaml, keyRange[0]);
    let to = (pair.value as Ranged | null)?.range ? (pair.value as Ranged).range![1] : keyRange[1];
    // Through the end of that line (a trailing comment goes with the value), never into the next key.
    if (to > 0 && yaml[to - 1] !== '\n') {
      const nl = yaml.indexOf('\n', to);
      to = nl < 0 ? yaml.length : nl + 1;
    }
    const next = pairs[i + 1]?.key as Ranged | undefined;
    if (next?.range) to = Math.min(to, lineStart(yaml, next.range[0]));
    entries.push({ key, value: js && Object.hasOwn(js, key) ? js[key] : null, from, to: Math.max(to, from), keyFrom: keyRange[0], keyTo: keyEnd(yaml, keyRange) });
  }
  return { entries, error: null };
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

/** The end of a key's own characters (its range may run on to the `:`). */
function keyEnd(yaml: string, range: [number, number, number]): number {
  let end = range[1];
  while (end > range[0] && /[ \t]/.test(yaml[end - 1])) end--;
  return end;
}

function eolOf(yaml: string): string {
  return yaml.includes('\r\n') ? '\r\n' : '\n';
}

/** A scalar in YAML: plain when that reads back as the same value, quoted otherwise. */
export function yamlScalar(value: string | number | boolean): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

const PLAIN_KEY = /^[\p{L}_][\p{L}\p{N}_ .\-/]*$/u;
const RESERVED = /^(true|false|null|~)$/i;

/** A property name as a YAML key: plain when it can be, JSON-quoted otherwise (as the server writes it). */
export function yamlKey(name: string): string {
  return PLAIN_KEY.test(name) && !RESERVED.test(name) && !name.endsWith(' ') ? name : JSON.stringify(name);
}

/** A property's lines. */
export function serializeProperty(key: string, value: EditValue, eol = '\n'): string {
  const k = yamlKey(key);
  if (value === null || value === '') return `${k}:${eol}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${k}:${eol}`;
    return `${k}:${eol}${value.map((v) => `  - ${yamlScalar(v)}`).join(eol)}${eol}`;
  }
  return `${k}: ${yamlScalar(value)}${eol}`;
}

function parsedOrThrow(yaml: string): PropertyEntry[] {
  const parsed = readProperties(yaml);
  if (parsed.error !== null) throw new PropertyEditError(parsed.error);
  return parsed.entries;
}

/** The entry named `key`: the exact name first, else the same name in another case. */
export function findEntry(entries: readonly PropertyEntry[], key: string): PropertyEntry | undefined {
  return entries.find((e) => e.key === key) ?? entries.find((e) => e.key.toLowerCase() === key.toLowerCase());
}

/** `yaml` with a line break at its end, so a property can follow. */
function withFinalBreak(yaml: string): string {
  return yaml === '' || yaml.endsWith('\n') ? yaml : yaml + eolOf(yaml);
}

/** Sets a property's value (its lines are replaced); a property that is not there is added last. */
export function setValue(yaml: string, key: string, value: EditValue): string {
  const entries = parsedOrThrow(yaml);
  const entry = findEntry(entries, key);
  const eol = eolOf(yaml);
  if (!entry) return withFinalBreak(yaml) + serializeProperty(key, value, eol);
  return yaml.slice(0, entry.from) + serializeProperty(entry.key, value, eol) + yaml.slice(entry.to);
}

/** Adds a property (last, or at `index`); throws when the note has one by that name. */
export function addProperty(yaml: string, key: string, value: EditValue, index?: number): string {
  const entries = parsedOrThrow(yaml);
  if (findEntry(entries, key)) throw new PropertyEditError(`The note already has a property “${key}”`);
  const text = serializeProperty(key, value, eolOf(yaml));
  const at = index !== undefined && index < entries.length ? entries[Math.max(0, index)].from : null;
  return at === null ? withFinalBreak(yaml) + text : yaml.slice(0, at) + text + yaml.slice(at);
}

/** Removes a property's lines (comment lines around it stay). */
export function removeProperty(yaml: string, key: string): string {
  const entry = findEntry(parsedOrThrow(yaml), key);
  if (!entry) return yaml;
  return yaml.slice(0, entry.from) + yaml.slice(entry.to);
}

/** Renames a property in this note: only the key's characters change. Throws when the new name is taken. */
export function renameProperty(yaml: string, from: string, to: string): string {
  const entries = parsedOrThrow(yaml);
  const entry = findEntry(entries, from);
  if (!entry) throw new PropertyEditError(`The note has no property “${from}”`);
  const name = to.trim();
  if (name === '' || /[\r\n]/.test(name)) throw new PropertyEditError('A property name is one line of text');
  if (entries.some((e) => e !== entry && e.key.toLowerCase() === name.toLowerCase())) throw new PropertyEditError(`The note already has a property “${name}”`);
  const next = yaml.slice(0, entry.keyFrom) + yamlKey(name) + yaml.slice(entry.keyTo);
  const check = readProperties(next);
  const renamed = check.entries.find((e) => e.from === entry.from);
  if (check.error !== null || renamed?.key !== name || JSON.stringify(renamed.value) !== JSON.stringify(entry.value)) {
    throw new PropertyEditError(`“${from}” cannot be renamed here; edit it as YAML`);
  }
  return next;
}

/** Moves a property to position `index` (counted in the list without it). */
export function moveProperty(yaml: string, key: string, index: number): string {
  const entries = parsedOrThrow(yaml);
  const entry = findEntry(entries, key);
  if (!entry) return yaml;
  let block = yaml.slice(entry.from, entry.to);
  if (!block.endsWith('\n')) block += eolOf(yaml);
  const without = yaml.slice(0, entry.from) + yaml.slice(entry.to);
  const rest = parsedOrThrow(without);
  const target = Math.max(0, Math.min(index, rest.length));
  if (target === rest.length) {
    // After the last property's lines (comments after it stay after it).
    const at = rest.length ? rest[rest.length - 1].to : without.length;
    const head = withFinalBreak(without.slice(0, at));
    return head + block + without.slice(at);
  }
  const at = rest[target].from;
  return without.slice(0, at) + block + without.slice(at);
}
