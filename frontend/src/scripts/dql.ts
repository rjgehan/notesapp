// Dataview-style queries (ROADMAP item 17, DESIGN §6.39.4): the `query("…")` helper of scripts and
// ```` ```dataview ```` blocks. A subset of the Dataview Query Language, parsed and evaluated here,
// over the notes `GET /api/notes/query` returns (API.md §40.1): never `eval`, no code, data only.
//
//   TABLE [WITHOUT ID] expr [AS "Name"], …  |  LIST [expr]  |  TASK
//   [FROM #tag and "folder" and [[Note]]]   (notes with the tag, in the folder, linking to the note)
//   [WHERE expr]  [SORT expr [ASC|DESC], …]  [LIMIT n]
//
// Expressions: properties by name, `file.name`, `file.path`, `file.folder`, `file.link`,
// `file.mtime`, `file.mday`, `file.tags`, `file.size`, `file.aliases`, `file.outlinks`; in TASK queries
// also `text`, `completed`, `status`, `line`. Literals: numbers, "strings", true, false, null,
// [[links]]. Operators: = != < <= > >= and or ! + - * /. Functions: contains, date ("today", "now",
// "YYYY-MM-DD"), default, length, lower, upper, number, string, round, startswith, endswith.
import type { QueriedNote } from '../api/types';
import type { OutputItem } from './protocol';

// ---------- tokens ----------

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'link'; v: string }
  | { k: 'tag'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'end' };

export class QueryError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new QueryError('A string is not closed');
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (src.startsWith('[[', i)) {
      const end = src.indexOf(']]', i + 2);
      if (end < 0) throw new QueryError('A link is not closed');
      out.push({ k: 'link', v: src.slice(i + 2, end).split('|')[0].trim() });
      i = end + 2;
      continue;
    }
    if (ch === '#' && /[\p{L}\p{N}_/-]/u.test(src[i + 1] ?? '')) {
      const m = /^#[\p{L}\p{N}_/-]+/u.exec(src.slice(i))!;
      out.push({ k: 'tag', v: m[0].slice(1) });
      i += m[0].length;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_-]*(?:\.[\p{L}_][\p{L}\p{N}_-]*)*/u.exec(src.slice(i));
    if (id) {
      out.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(?:!=|<=|>=|&&|\|\||[=<>!+\-*/(),])/.exec(src.slice(i));
    if (op) {
      out.push({ k: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new QueryError(`Unexpected "${ch}"`);
  }
  out.push({ k: 'end' });
  return out;
}

// ---------- syntax ----------

export type Expr =
  | { e: 'lit'; v: Value }
  | { e: 'field'; name: string }
  | { e: 'call'; fn: string; args: Expr[] }
  | { e: 'un'; op: '!' | '-'; x: Expr }
  | { e: 'bin'; op: string; a: Expr; b: Expr };

export interface Query {
  kind: 'table' | 'list' | 'task';
  withoutId: boolean;
  fields: { expr: Expr; name: string }[];
  from: { tags: string[]; folder: string | null; linksTo: string | null };
  where: Expr | null;
  sort: { expr: Expr; desc: boolean }[];
  limit: number | null;
}

const KEYWORDS = new Set(['from', 'where', 'sort', 'limit', 'as', 'and', 'or', 'asc', 'desc', 'ascending', 'descending', 'flatten', 'group']);

class Parser {
  private i = 0;
  private readonly toks: Tok[];
  constructor(src: string) {
    this.toks = tokenize(src);
  }
  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isWord(word: string): boolean {
    const t = this.peek();
    return t.k === 'id' && t.v.toLowerCase() === word;
  }
  word(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.i++;
    return true;
  }
  isOp(op: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === op;
  }
  op(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.i++;
    return true;
  }

  query(): Query {
    const head = this.next();
    const kind = head.k === 'id' ? head.v.toLowerCase() : '';
    if (kind !== 'table' && kind !== 'list' && kind !== 'task') throw new QueryError('A query starts with TABLE, LIST or TASK');
    const q: Query = { kind, withoutId: false, fields: [], from: { tags: [], folder: null, linksTo: null }, where: null, sort: [], limit: null };
    if (kind === 'table') {
      if (this.word('without')) {
        if (!this.word('id')) throw new QueryError('WITHOUT must be followed by ID');
        q.withoutId = true;
      }
      if (!this.atClause()) {
        do {
          const start = this.i;
          const expr = this.expr();
          let name = this.sourceOf(start);
          if (this.word('as')) {
            const t = this.next();
            if (t.k !== 'str' && t.k !== 'id') throw new QueryError('AS must be followed by a name');
            name = t.v;
          }
          q.fields.push({ expr, name });
        } while (this.op(','));
      }
    } else if (kind === 'list' && !this.atClause()) {
      q.fields.push({ expr: this.expr(), name: '' });
    }
    while (this.peek().k !== 'end') {
      if (this.word('from')) this.from(q);
      else if (this.word('where')) q.where = q.where ? { e: 'bin', op: 'and', a: q.where, b: this.expr() } : this.expr();
      else if (this.word('sort')) {
        do {
          const expr = this.expr();
          let desc = false;
          if (this.word('desc') || this.word('descending')) desc = true;
          else if (!this.word('asc')) this.word('ascending');
          q.sort.push({ expr, desc });
        } while (this.op(','));
      } else if (this.word('limit')) {
        const t = this.next();
        if (t.k !== 'num') throw new QueryError('LIMIT must be followed by a number');
        q.limit = t.v;
      } else {
        const t = this.peek();
        throw new QueryError(t.k === 'id' && (t.v.toLowerCase() === 'group' || t.v.toLowerCase() === 'flatten') ? `${t.v.toUpperCase()} is not supported` : 'Expected FROM, WHERE, SORT or LIMIT');
      }
    }
    return q;
  }

  private atClause(): boolean {
    return this.peek().k === 'end' || ['from', 'where', 'sort', 'limit'].some((w) => this.isWord(w));
  }

  private sourceOf(start: number): string {
    // The field's text as written, for its column name.
    const toks = this.toks.slice(start, this.i);
    return toks.map((t) => (t.k === 'str' ? `"${t.v}"` : t.k === 'link' ? `[[${t.v}]]` : t.k === 'end' ? '' : String(t.v))).join(' ').replace(/ ?([().,]) ?/g, '$1').replace(/,/g, ', ');
  }

  private from(q: Query): void {
    do {
      const t = this.next();
      if (t.k === 'tag') q.from.tags.push(t.v);
      else if (t.k === 'str') {
        if (q.from.folder !== null) throw new QueryError('FROM takes one folder');
        q.from.folder = t.v;
      } else if (t.k === 'link') {
        if (q.from.linksTo !== null) throw new QueryError('FROM takes one link');
        q.from.linksTo = t.v;
      } else if (t.k === 'op' && t.v === '-') throw new QueryError('Excluding sources (-) is not supported');
      else throw new QueryError('FROM takes #tags, "folders" and [[links]], joined with AND');
    } while (this.word('and') || this.op('&&'));
    if (this.isWord('or')) throw new QueryError('OR between sources is not supported');
  }

  expr(): Expr {
    return this.or();
  }
  private or(): Expr {
    let a = this.and();
    while (this.word('or') || this.op('||')) a = { e: 'bin', op: 'or', a, b: this.and() };
    return a;
  }
  private and(): Expr {
    let a = this.not();
    while (this.word('and') || this.op('&&')) a = { e: 'bin', op: 'and', a, b: this.not() };
    return a;
  }
  private not(): Expr {
    if (this.op('!')) return { e: 'un', op: '!', x: this.not() };
    return this.cmp();
  }
  private cmp(): Expr {
    const a = this.add();
    for (const op of ['!=', '<=', '>=', '=', '<', '>']) if (this.op(op)) return { e: 'bin', op, a, b: this.add() };
    return a;
  }
  private add(): Expr {
    let a = this.mul();
    for (;;) {
      if (this.op('+')) a = { e: 'bin', op: '+', a, b: this.mul() };
      else if (this.op('-')) a = { e: 'bin', op: '-', a, b: this.mul() };
      else return a;
    }
  }
  private mul(): Expr {
    let a = this.unary();
    for (;;) {
      if (this.op('*')) a = { e: 'bin', op: '*', a, b: this.unary() };
      else if (this.op('/')) a = { e: 'bin', op: '/', a, b: this.unary() };
      else return a;
    }
  }
  private unary(): Expr {
    if (this.op('-')) return { e: 'un', op: '-', x: this.unary() };
    return this.primary();
  }
  private primary(): Expr {
    const t = this.next();
    switch (t.k) {
      case 'num':
      case 'str':
        return { e: 'lit', v: t.v };
      case 'link':
        return { e: 'lit', v: { link: t.v } };
      case 'tag':
        return { e: 'lit', v: `#${t.v}` };
      case 'op':
        if (t.v === '(') {
          const x = this.expr();
          if (!this.op(')')) throw new QueryError('Expected )');
          return x;
        }
        throw new QueryError(`Unexpected "${t.v}"`);
      case 'id': {
        const lower = t.v.toLowerCase();
        if (lower === 'true' || lower === 'false') return { e: 'lit', v: lower === 'true' };
        if (lower === 'null') return { e: 'lit', v: null };
        if (this.op('(')) {
          const args: Expr[] = [];
          if (!this.op(')')) {
            do args.push(this.expr());
            while (this.op(','));
            if (!this.op(')')) throw new QueryError('Expected )');
          }
          // `date(today)`: Dataview's bare date words.
          if (lower === 'date' && args.length === 1 && args[0].e === 'field' && /^(today|now|tomorrow|yesterday)$/i.test(args[0].name)) args[0] = { e: 'lit', v: args[0].name };
          return { e: 'call', fn: lower, args };
        }
        if (KEYWORDS.has(lower)) throw new QueryError(`Unexpected ${t.v.toUpperCase()}`);
        return { e: 'field', name: t.v };
      }
      case 'end':
        throw new QueryError('The query ends too early');
    }
  }
}

export function parseQuery(src: string): Query {
  if (src.length > 4000) throw new QueryError('The query is too long');
  return new Parser(src.trim()).query();
}

// ---------- values ----------

export type Value = string | number | boolean | null | { link: string } | Value[];

export interface Row {
  note: QueriedNote;
  task?: { text: string; done: boolean; status: string; line: number };
}

export interface EvalContext {
  /** Today, local, `YYYY-MM-DD`; now, local, `YYYY-MM-DDTHH:mm`. */
  today: string;
  now: string;
  /** A note's local modification time, `YYYY-MM-DDTHH:mm`. */
  localTime(iso: string): string;
  /** Resolves a link target to a vault path (null: unresolved). */
  resolve(target: string): string | null;
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function field(name: string, row: Row, ctx: EvalContext): Value {
  const lower = name.toLowerCase();
  const n = row.note;
  if (row.task) {
    if (lower === 'text') return row.task.text;
    if (lower === 'completed') return row.task.done;
    if (lower === 'status') return row.task.status;
    if (lower === 'line') return row.task.line;
  }
  switch (lower) {
    case 'file.name':
      return n.title;
    case 'file.path':
      return n.path;
    case 'file.folder':
      return folderOf(n.path);
    case 'file.link':
      return { link: n.path };
    case 'file.mtime':
      return ctx.localTime(n.mtime);
    case 'file.mday':
      return ctx.localTime(n.mtime).slice(0, 10);
    case 'file.tags':
    case 'file.etags':
      return n.tags.map((t) => `#${t}`);
    case 'file.size':
      return n.size;
    case 'file.aliases':
      return n.aliases;
    case 'file.outlinks':
      return n.links.map((l) => ({ link: l }));
  }
  const fm = n.frontmatter ?? {};
  const [head, ...rest] = name.split('.');
  const key = Object.keys(fm).find((k) => k.toLowerCase() === head.toLowerCase() || k.toLowerCase().replace(/\s+/g, '-') === head.toLowerCase());
  let v: unknown = key === undefined ? null : fm[key];
  for (const part of rest) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[part] : null;
  return toValue(v);
}

const LINK = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/;

function toValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const m = LINK.exec(v.trim());
    return m ? { link: m[1].trim() } : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(toValue);
  return JSON.stringify(v);
}

const isLink = (v: Value): v is { link: string } => typeof v === 'object' && v !== null && !Array.isArray(v);

function linkPath(v: { link: string }, ctx: EvalContext): string {
  return ctx.resolve(v.link) ?? v.link;
}

function equal(a: Value, b: Value, ctx: EvalContext): boolean {
  if (isLink(a) || isLink(b)) {
    const pa = isLink(a) ? linkPath(a, ctx) : typeof a === 'string' ? (ctx.resolve(a) ?? a) : null;
    const pb = isLink(b) ? linkPath(b, ctx) : typeof b === 'string' ? (ctx.resolve(b) ?? b) : null;
    return pa !== null && pa === pb;
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Orders values: nulls last, numbers, then text (dates as ISO text sort right). */
export function compare(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = text(a);
  const sb = text(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

function text(v: Value): string {
  if (v === null) return '';
  if (Array.isArray(v)) return v.map(text).join(', ');
  if (isLink(v)) return v.link.replace(/\.md$/i, '').split('/').pop() ?? v.link;
  return String(v);
}

function truthy(v: Value): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && v !== false && v !== 0 && v !== '';
}

function contains(a: Value, b: Value, ctx: EvalContext): boolean {
  if (Array.isArray(a)) return a.some((x) => (typeof x === 'string' && typeof b === 'string' ? x.toLowerCase() === b.toLowerCase() || (x.startsWith('#') && x.toLowerCase().startsWith(`${b.toLowerCase()}/`)) : equal(x, b, ctx)));
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase().includes(b.toLowerCase());
  return equal(a, b, ctx);
}

function dateValue(v: Value, ctx: EvalContext): Value {
  if (typeof v !== 'string') return isLink(v) ? dateValue(v.link, ctx) : null;
  const s = v.trim().toLowerCase();
  if (s === 'today') return ctx.today;
  if (s === 'now') return ctx.now;
  if (s === 'tomorrow' || s === 'yesterday') {
    const d = new Date(`${ctx.today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (s === 'tomorrow' ? 1 : -1));
    return d.toISOString().slice(0, 10);
  }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(v.trim());
  return m ? (m[2] ? `${m[1]}T${m[2]}` : m[1]) : null;
}

const FUNCTIONS: Record<string, (args: Value[], ctx: EvalContext) => Value> = {
  contains: ([a, b], ctx) => contains(a ?? null, b ?? null, ctx),
  icontains: ([a, b], ctx) => contains(a ?? null, b ?? null, ctx),
  date: ([a], ctx) => dateValue(a ?? null, ctx),
  default: ([a, b]) => (a === null || a === undefined ? (b ?? null) : a),
  length: ([a]) => (Array.isArray(a) ? a.length : typeof a === 'string' ? a.length : 0),
  lower: ([a]) => text(a ?? null).toLowerCase(),
  upper: ([a]) => text(a ?? null).toUpperCase(),
  number: ([a]) => {
    const n = typeof a === 'number' ? a : Number.parseFloat(text(a ?? null));
    return Number.isFinite(n) ? n : null;
  },
  string: ([a]) => text(a ?? null),
  round: ([a, d]) => (typeof a === 'number' ? Number(a.toFixed(typeof d === 'number' ? Math.max(0, Math.min(10, d)) : 0)) : null),
  startswith: ([a, b]) => text(a ?? null).toLowerCase().startsWith(text(b ?? null).toLowerCase()),
  endswith: ([a, b]) => text(a ?? null).toLowerCase().endsWith(text(b ?? null).toLowerCase()),
  link: ([a]) => (a === null || a === undefined ? null : { link: text(a) }),
};

export function evaluate(x: Expr, row: Row, ctx: EvalContext): Value {
  switch (x.e) {
    case 'lit':
      return x.v;
    case 'field':
      return field(x.name, row, ctx);
    case 'un': {
      const v = evaluate(x.x, row, ctx);
      return x.op === '!' ? !truthy(v) : typeof v === 'number' ? -v : null;
    }
    case 'call': {
      const f = FUNCTIONS[x.fn];
      if (!f) throw new QueryError(`Unknown function ${x.fn}()`);
      return f(
        x.args.map((a) => evaluate(a, row, ctx)),
        ctx,
      );
    }
    case 'bin': {
      if (x.op === 'and') return truthy(evaluate(x.a, row, ctx)) && truthy(evaluate(x.b, row, ctx));
      if (x.op === 'or') return truthy(evaluate(x.a, row, ctx)) || truthy(evaluate(x.b, row, ctx));
      const a = evaluate(x.a, row, ctx);
      const b = evaluate(x.b, row, ctx);
      switch (x.op) {
        case '=':
          return equal(a, b, ctx);
        case '!=':
          return !equal(a, b, ctx);
        case '<':
          return a !== null && b !== null && compare(a, b) < 0;
        case '<=':
          return a !== null && b !== null && compare(a, b) <= 0;
        case '>':
          return a !== null && b !== null && compare(a, b) > 0;
        case '>=':
          return a !== null && b !== null && compare(a, b) >= 0;
        case '+':
          return typeof a === 'number' && typeof b === 'number' ? a + b : text(a) + text(b);
        case '-':
          return typeof a === 'number' && typeof b === 'number' ? a - b : null;
        case '*':
          return typeof a === 'number' && typeof b === 'number' ? a * b : null;
        case '/':
          return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null;
      }
      return null;
    }
  }
}

// ---------- running ----------

/** The `GET /api/notes/query` filters a query's FROM gives. */
export function sourceFilter(q: Query): { tag: string[]; folder: string | null; linksTo: string | null; tasks: boolean } {
  return { tag: q.from.tags, folder: q.from.folder, linksTo: q.from.linksTo, tasks: q.kind === 'task' };
}

function cell(v: Value): OutputItem {
  if (isLink(v)) return { t: 'link', path: v.link, title: text(v) };
  if (Array.isArray(v) && v.length > 0 && v.every(isLink)) return { t: 'list', items: v.map(cell) };
  if (typeof v === 'number') return { t: 'text', v: Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10))) };
  // A local time (`file.mtime`) reads as 2026-10-22 11:56.
  const s = text(v);
  return { t: 'text', v: typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s.replace('T', ' ') : s };
}

const MAX_ROWS = 1000;

/** Runs a parsed query over the notes its FROM matched; the result as a script's output. */
export function runQuery(q: Query, notes: readonly QueriedNote[], ctx: EvalContext): OutputItem {
  let rows: Row[] =
    q.kind === 'task'
      ? notes.flatMap((note) => (note.tasks ?? []).map((task) => ({ note, task })))
      : notes.map((note) => ({ note }));
  if (q.where) rows = rows.filter((r) => truthy(evaluate(q.where!, r, ctx)));
  if (q.sort.length) {
    const keyed = rows.map((r) => ({ r, keys: q.sort.map((s) => evaluate(s.expr, r, ctx)) }));
    keyed.sort((a, b) => {
      for (let i = 0; i < q.sort.length; i++) {
        const c = compare(a.keys[i], b.keys[i]);
        if (c !== 0) return q.sort[i].desc ? -c : c;
      }
      return 0;
    });
    rows = keyed.map((k) => k.r);
  }
  rows = rows.slice(0, Math.min(q.limit ?? MAX_ROWS, MAX_ROWS));
  const link = (r: Row): OutputItem => ({ t: 'link', path: r.note.path, title: r.note.title });
  if (q.kind === 'task') {
    return { t: 'list', items: rows.map((r) => ({ t: 'inline', items: [{ t: 'text', v: `${r.task!.done ? '☑' : '☐'} ${r.task!.text}` }, link(r)] })) };
  }
  if (q.kind === 'list') {
    const f = q.fields[0];
    return { t: 'list', items: rows.map((r) => (f ? { t: 'inline', items: [link(r), cell(evaluate(f.expr, r, ctx))] } : link(r))) };
  }
  const columns = [...(q.withoutId ? [] : ['File']), ...q.fields.map((f) => f.name)];
  return { t: 'table', columns, rows: rows.map((r) => [...(q.withoutId ? [] : [link(r)]), ...q.fields.map((f) => cell(evaluate(f.expr, r, ctx)))]) };
}
