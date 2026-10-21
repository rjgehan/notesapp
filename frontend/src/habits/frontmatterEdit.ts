// Edits of one frontmatter property that leave the rest of the note byte for byte (DESIGN §6.35):
// the property's lines are replaced, appended, or removed; every other line, comment and quoting
// stays. Lists are written in block style, as Obsidian writes them.
import { isMap, isScalar, parseDocument, stringify, type Pair } from 'yaml';
import { splitFrontmatter } from '../features/frontmatter';

export type PropertyValue = string | number | boolean | string[];

/** A scalar in YAML: plain when that reads back as the same value, quoted otherwise. */
export function yamlScalar(value: string | number | boolean): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

function serialize(key: string, value: PropertyValue): string {
  const k = /^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${k}: []\n`;
    return `${k}:\n${value.map((v) => `  - ${yamlScalar(v)}`).join('\n')}\n`;
  }
  return `${k}: ${yamlScalar(value)}\n`;
}

export class FrontmatterError extends Error {}

function keyOf(pair: Pair): string | null {
  return isScalar(pair.key) && pair.key.value !== null && pair.key.value !== undefined ? String(pair.key.value) : null;
}

/**
 * `text` with the frontmatter property `key` set to `value`, or removed with `null`. The key is
 * matched case-insensitively (an existing `Exercise:` is the property `exercise`); a new property
 * goes last. A note without frontmatter gets one. Throws FrontmatterError when the frontmatter is
 * not valid YAML or not a mapping, so a broken block is never rewritten.
 */
export function setProperty(text: string, key: string, value: PropertyValue | null): string {
  const split = splitFrontmatter(text);
  if (split.yaml === null) {
    if (value === null) return text;
    return `---\n${serialize(key, value)}---\n${text}`;
  }
  const yamlStart = text.indexOf('\n') + 1;
  const yaml = split.yaml;
  const doc = parseDocument(yaml, { keepSourceTokens: true });
  if (doc.errors.length) throw new FrontmatterError('The frontmatter is not valid YAML');
  const contents = doc.contents;
  if (contents !== null && !isMap(contents)) throw new FrontmatterError('The frontmatter is not a list of properties');
  const pairs = contents ? (contents.items as Pair[]) : [];
  const wanted = key.toLowerCase();
  const index = pairs.findIndex((p) => keyOf(p)?.toLowerCase() === wanted);
  let next: string;
  if (index < 0) {
    if (value === null) return text;
    next = (yaml === '' || yaml.endsWith('\n') ? yaml : yaml + '\n') + serialize(key, value);
  } else {
    const pair = pairs[index];
    const start = (pair.key as { range?: [number, number, number] }).range![0];
    const lineStart = yaml.lastIndexOf('\n', start - 1) + 1;
    const nextKey = pairs[index + 1]?.key as { range?: [number, number, number] } | undefined;
    const valueNode = pair.value as { range?: [number, number, number] } | null;
    let end = valueNode?.range ? valueNode.range[1] : (pair.key as { range: [number, number, number] }).range[1];
    // Through the end of that line (a trailing comment goes with the value), never into the next key.
    if (end > 0 && yaml[end - 1] !== '\n') {
      const nl = yaml.indexOf('\n', end);
      end = nl < 0 ? yaml.length : nl + 1;
    }
    if (nextKey?.range) end = Math.min(end, yaml.lastIndexOf('\n', nextKey.range[0] - 1) + 1 || end);
    const name = keyOf(pair)!;
    const replacement = value === null ? '' : serialize(name, value);
    next = yaml.slice(0, lineStart) + replacement + yaml.slice(end);
  }
  return text.slice(0, yamlStart) + next + text.slice(yamlStart + yaml.length);
}

/** The property's value in `text`'s frontmatter (case-insensitive key), or undefined. */
export function getProperty(text: string, key: string): unknown {
  const split = splitFrontmatter(text);
  if (split.yaml === null) return undefined;
  const doc = parseDocument(split.yaml);
  if (doc.errors.length || !isMap(doc.contents)) return undefined;
  const wanted = key.toLowerCase();
  const pair = (doc.contents.items as Pair[]).find((p) => keyOf(p)?.toLowerCase() === wanted);
  return pair ? (doc.toJS() as Record<string, unknown>)[keyOf(pair)!] : undefined;
}
