// Scripts in notes (ROADMAP items 40 and 17, DESIGN §6.39): the page's side of a script's API
// calls. The sandbox asks by name with JSON arguments; every call is checked here (the arguments
// come from the script) and answered with JSON data. Read-only: nothing here writes to the vault.
// The paths a run read, and whether it asked for many notes, decide when it runs again.
import type { NotesQueryResponse, QueriedNote } from '../api/types';
import type { NotesFilter } from './api';
import { parseQuery, QueryError, runQuery, sourceFilter, type EvalContext } from './dql';

export interface HostDeps {
  /** The note the script is in. */
  path: string;
  queryNotes(filter: NotesFilter): Promise<NotesQueryResponse>;
  readText(path: string): Promise<string>;
  /** Resolves a link target (or a path) from the note; null if nothing in the vault matches. */
  resolve(target: string): string | null;
  /** Evaluates a spreadsheet expression (`=…`) with the engine of item 39; `note` uses this note's tables. */
  evaluate(expression: string, note: boolean): Promise<unknown>;
  /** The device's clock (tests). */
  now?(): Date;
}

/** What one run read: the notes by path, and whether it listed notes (any change may matter then). */
export interface ReadSet {
  paths: Set<string>;
  broad: boolean;
}

const MAX_TEXT = 1024 * 1024;
const MAX_LIMIT = 2000;
const FILTER_KEYS = new Set(['tag', 'tags', 'folder', 'prop', 'props', 'linksTo', 'search', 'limit', 'done']);

export class HostError extends Error {}

const pad = (n: number) => String(n).padStart(2, '0');

/** A time as the device's local wall time, kept as if it were UTC (what the sandbox's dates hold). */
export function localWallMs(d: Date): number {
  return d.getTime() - d.getTimezoneOffset() * 60_000;
}

function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function strings(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x) => typeof x === 'string')) throw new HostError(`${name} must be text or a list of text`);
  return list as string[];
}

function optionalString(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HostError(`${name} must be text`);
  return v;
}

/** `prop` as the endpoint takes it: `"status"`, `"status!=done"`, or `{ status: "done" }`. */
function props(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v as Record<string, unknown>).map(([k, value]) => {
      if (value === true || value === undefined) return k;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new HostError('prop values must be text, numbers or booleans');
      return `${k}=${String(value)}`;
    });
  }
  return strings(v, 'prop');
}

/** A script's `notes({…})` filter, checked, as the endpoint's. */
export function notesFilter(raw: unknown): NotesFilter & { done?: boolean } {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HostError('notes() takes an object: { tag, folder, prop, linksTo, search, limit }');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FILTER_KEYS.has(k)) throw new HostError(`Unknown filter: ${k}`);
  const limit = o.limit === undefined ? undefined : o.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) throw new HostError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  if (o.done !== undefined && typeof o.done !== 'boolean') throw new HostError('done must be true or false');
  return {
    tag: [...strings(o.tag, 'tag'), ...strings(o.tags, 'tags')].map((t) => t.replace(/^#/, '')),
    folder: optionalString(o.folder, 'folder'),
    prop: [...props(o.prop), ...props(o.props)],
    linksTo: optionalString(o.linksTo, 'linksTo'),
    q: optionalString(o.search, 'search'),
    limit: limit as number | undefined,
    done: o.done as boolean | undefined,
  };
}

/** A formula argument as spreadsheet text: numbers, "text", TRUE/FALSE, {arrays}. */
export function formulaLiteral(v: unknown, depth = 0): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new HostError('Formula arguments must be finite numbers');
    return String(v);
  }
  if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === null || v === undefined) return '';
  if (Array.isArray(v) && depth === 0) {
    const rows = v.every(Array.isArray) ? (v as unknown[][]) : [v];
    return `{${rows.map((r) => r.map((x) => formulaLiteral(x, 2)).join(',')).join(';')}}`;
  }
  throw new HostError('Formula arguments must be numbers, text, booleans or lists of them');
}

function guestNote(n: QueriedNote) {
  const mtime = new Date(n.mtime);
  return { ...n, mtimeLocal: Number.isFinite(mtime.getTime()) ? localWallMs(mtime) : 0 };
}

/** Answers one run's API calls. */
export function createHost(deps: HostDeps): { call(name: string, args: string): Promise<string>; reads: ReadSet } {
  const reads: ReadSet = { paths: new Set(), broad: false };
  const now = () => deps.now?.() ?? new Date();

  const notePath = (ref: string): string | null => deps.resolve(ref);

  const one = async (path: string, tasks: boolean): Promise<QueriedNote | null> => {
    reads.paths.add(path);
    const r = await deps.queryNotes({ path, tasks, limit: 1 });
    return r.notes[0] ?? null;
  };

  const evalContext = (): EvalContext => {
    const d = now();
    const stamp = localStamp(d);
    return { today: stamp.slice(0, 10), now: stamp, localTime: (iso) => localStamp(new Date(iso)), resolve: (t) => deps.resolve(t) };
  };

  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {
    async note(args) {
      if (typeof args !== 'string') throw new HostError('note() takes a title or a path');
      const path = notePath(args);
      if (!path) {
        reads.broad = true; // it may appear later
        return null;
      }
      const n = await one(path, false);
      return n ? guestNote(n) : null;
    },
    async notes(args) {
      reads.broad = true;
      const { done: _done, ...filter } = notesFilter(args);
      const r = await deps.queryNotes({ ...filter, limit: filter.limit ?? 500 });
      return r.notes.map(guestNote);
    },
    async tasks(args) {
      reads.broad = true;
      const { done, ...filter } = notesFilter(args);
      const r = await deps.queryNotes({ ...filter, tasks: true, limit: filter.limit ?? 500 });
      return r.notes.flatMap((n) => (n.tasks ?? []).filter((t) => done === undefined || t.done === done).map((task) => ({ task, note: guestNote({ ...n, tasks: null }) })));
    },
    async noteTasks(args) {
      if (typeof args !== 'string') throw new HostError('A path is needed');
      const n = await one(args, true);
      return n?.tasks ?? [];
    },
    async text(args) {
      if (typeof args !== 'string') throw new HostError('A path is needed');
      // Only a note the vault has (the query checks it is one, outside excluded folders).
      const n = await one(args, false);
      if (!n) throw new HostError(`No note at ${args}`);
      const text = await deps.readText(n.path);
      return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
    },
    async fn(args) {
      const { name, args: list } = (args ?? {}) as { name?: unknown; args?: unknown };
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,40}$/.test(name)) throw new HostError('Not a formula function name');
      if (!Array.isArray(list) || list.length > 255) throw new HostError('Too many arguments');
      return evaluated(await deps.evaluate(`=${name.toUpperCase()}(${list.map((a) => formulaLiteral(a)).join(',')})`, false));
    },
    async formula(args) {
      if (typeof args !== 'string' || args.length > 8000) throw new HostError('formula() takes a formula as text');
      const expression = args.trim().startsWith('=') ? args.trim() : `=${args.trim()}`;
      return evaluated(await deps.evaluate(expression, true));
    },
    async query(args) {
      if (typeof args !== 'string') throw new HostError('query() takes a query as text');
      reads.broad = true;
      try {
        const q = parseQuery(args);
        const f = sourceFilter(q);
        const r = await deps.queryNotes({ tag: f.tag, folder: f.folder, linksTo: f.linksTo, tasks: f.tasks, limit: MAX_LIMIT });
        return runQuery(q, r.notes, evalContext());
      } catch (e) {
        if (e instanceof QueryError) throw new HostError(`Query: ${e.message}`);
        throw e;
      }
    },
  };

  return {
    reads,
    async call(name, argsJson) {
      const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
      if (!handler) return JSON.stringify({ e: `Unknown API call: ${name}` });
      try {
        const args: unknown = JSON.parse(argsJson);
        const value = await handler(args);
        return JSON.stringify({ v: value === undefined ? null : value });
      } catch (e) {
        return JSON.stringify({ e: e instanceof HostError ? e.message : `The call failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
  };
}

/** An engine value for a script: an error becomes an exception, with its code. */
function evaluated(v: unknown): unknown {
  if (v && typeof v === 'object' && 'error' in v) {
    const e = v as { error: string; message?: string };
    throw new HostError(`${e.error}${e.message ? ` ${e.message}` : ''}`);
  }
  if (Array.isArray(v)) return v;
  return v ?? null;
}
