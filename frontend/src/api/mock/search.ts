// Full-text search for the dev-only mock API (API.md §12.1): the real query grammar
// (features/searchQuery), evaluated with simple string matching instead of the server's index.
// Typo tolerance and PDF text are server-only; the mock never reports corrections.
import { parseSearchQuery, queryLeaves, toJsRegExp, type QueryLeaf, type QueryNode } from '../../features/searchQuery';
import { lastSegment, stripMd } from '../../features/paths';
import type { SearchHit, SearchResponse, TextRange } from '../types';
import { fail } from './problems';
import { lineAt, type NoteScan } from './scan';

export interface SearchDoc {
  path: string;
  text: string;
  scan: NoteScan;
  mtime: string;
}

export function foldAccents(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordPattern(value: string, prefix: boolean): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(foldAccents(value))}${prefix ? '' : '(?![\\p{L}\\p{N}])'}`, 'u');
}

interface Unit {
  text: string;
}

class Evaluator {
  private readonly regexes = new Map<QueryLeaf, RegExp>();
  private readonly prefix: boolean;

  constructor(prefix: boolean, root: QueryNode) {
    this.prefix = prefix;
    for (const { leaf } of queryLeaves(root)) {
      if (!leaf.regex) continue;
      if (leaf.value.length > 500) fail('bad-request', 'The regular expression is longer than 500 characters', { errors: [{ field: 'q', message: 'too long' }] });
      const re = toJsRegExp(leaf.value);
      if (!re) fail('bad-request', `Invalid regular expression /${leaf.value}/`, { errors: [{ field: 'q', message: 'invalid regular expression' }] });
      this.regexes.set(leaf, new RegExp(re.source, re.flags.replace('g', '')));
    }
  }

  matches(node: QueryNode, doc: SearchDoc, unit: Unit | null): boolean {
    switch (node.type) {
      case 'leaf':
        return this.leaf(node, doc, unit);
      case 'and': {
        const positives = node.children.filter((c) => c.type !== 'not');
        if (positives.length === 0) return false;
        return positives.every((c) => this.matches(c, doc, unit)) && node.children.every((c) => c.type !== 'not' || !this.matches(c.child, doc, unit));
      }
      case 'or':
        return node.children.some((c) => this.matches(c, doc, unit));
      case 'not':
        return false;
      case 'scope': {
        const units = node.scope === 'line' ? lines(doc) : sections(doc);
        return units.some((u) => this.matches(node.child, doc, u));
      }
    }
  }

  private leaf(leaf: QueryLeaf, doc: SearchDoc, unit: Unit | null): boolean {
    const regex = this.regexes.get(leaf);
    const name = lastSegment(doc.path);
    switch (leaf.kind) {
      case 'tag': {
        if (regex) return doc.scan.tags.some((t) => regex.test(t));
        const tag = leaf.value.replace(/^#/, '').toLowerCase();
        return doc.scan.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
      }
      case 'path':
        return regex ? regex.test(doc.path) : doc.path.toLowerCase().includes(leaf.value.toLowerCase());
      case 'file':
        return regex ? regex.test(name) : name.toLowerCase().includes(leaf.value.toLowerCase());
      case 'regex':
        return regex!.test(unit ? unit.text : doc.text);
      case 'phrase': {
        const v = foldAccents(leaf.value);
        if (unit) return foldAccents(unit.text).includes(v);
        return foldAccents(doc.text.slice(doc.scan.bodyStart)).includes(v) || foldAccents(stripMd(name)).includes(v);
      }
      case 'word': {
        const re = wordPattern(leaf.value, this.prefix && leaf.last && leaf.value.length >= 2);
        if (unit) return re.test(foldAccents(unit.text));
        const hay = `${foldAccents(stripMd(name))} ${doc.scan.aliases.map(foldAccents).join(' ')} ${foldAccents(doc.text.slice(doc.scan.bodyStart))}`;
        return re.test(hay);
      }
    }
  }
}

function lines(doc: SearchDoc): Unit[] {
  const first = lineAt(doc.scan.lineStarts, doc.scan.bodyStart);
  return doc.text
    .split('\n')
    .slice(doc.scan.bodyStart > 0 ? first : 0)
    .map((text) => ({ text }));
}

function sections(doc: SearchDoc): Unit[] {
  const all = doc.text.split('\n');
  const first = doc.scan.bodyStart > 0 ? lineAt(doc.scan.lineStarts, doc.scan.bodyStart) : 0;
  const breaks = new Set(doc.scan.headings.map((h) => h.line));
  const units: Unit[] = [];
  let start = first;
  for (let line = first + 1; line <= all.length; line++) {
    if (line === all.length || breaks.has(line)) {
      units.push({ text: all.slice(start, line).join('\n') });
      start = line;
    }
  }
  return units;
}

function rangesIn(text: string, terms: string[], regexes: RegExp[]): TextRange[] {
  const folded = foldAccents(text);
  const ranges: TextRange[] = [];
  for (const t of terms) {
    const at = folded.indexOf(t);
    if (at >= 0) ranges.push({ from: at, to: at + t.length });
  }
  for (const re of regexes) {
    const m = new RegExp(re.source, re.flags.replace('g', '') + 'g').exec(text);
    if (m && m[0].length > 0) ranges.push({ from: m.index, to: m.index + m[0].length });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

export function mockSearch(docs: SearchDoc[], q: string, limit: number, sort: 'relevance' | 'mtime', prefix: boolean): SearchResponse {
  const started = performance.now();
  if (limit < 1 || limit > 200) fail('bad-request', 'limit out of range', { errors: [{ field: 'limit', message: '1 to 200' }] });
  const root = parseSearchQuery(q);
  const empty: SearchResponse = { query: q, total: 0, tookMs: 0, results: [], corrections: [] };
  if (!root) return empty;
  const evaluator = new Evaluator(prefix, root);
  const positive = queryLeaves(root).filter((l) => !l.negated);
  const terms = positive.filter((l) => l.leaf.kind === 'word' || l.leaf.kind === 'phrase').map((l) => foldAccents(l.leaf.value));
  const regexes = positive.filter((l) => l.leaf.kind === 'regex').flatMap((l) => toJsRegExp(l.leaf.value) ?? []);
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    if (!evaluator.matches(root, doc, null)) continue;
    const title = stripMd(lastSegment(doc.path));
    const all = doc.text.split('\n');
    const matches: SearchHit['matches'] = [];
    let moreMatches = 0;
    const first = doc.scan.bodyStart > 0 ? lineAt(doc.scan.lineStarts, doc.scan.bodyStart) : 0;
    for (let i = first; i < all.length && (terms.length > 0 || regexes.length > 0); i++) {
      const line = all[i].replace(/\r$/, '');
      const ranges = rangesIn(line, terms, regexes);
      if (ranges.length === 0) continue;
      if (matches.length < 3) matches.push({ line: i, text: line.slice(0, 200), ranges: ranges.filter((r) => r.to <= 200), page: null });
      else moreMatches++;
    }
    const titleRanges = rangesIn(title, terms, []);
    const score = terms.reduce((s, t) => s + (foldAccents(title).includes(t) ? 4 : 0) + Math.min(5, foldAccents(doc.text).split(t).length - 1), 0);
    hits.push({ path: doc.path, basename: title, kind: 'note', score, mtime: doc.mtime, titleRanges, matches, moreMatches });
  }
  hits.sort((a, b) => (sort === 'mtime' ? 0 : b.score - a.score) || Date.parse(b.mtime) - Date.parse(a.mtime));
  return { query: q, total: hits.length, tookMs: Math.round(performance.now() - started), results: hits.slice(0, limit), corrections: [] };
}
