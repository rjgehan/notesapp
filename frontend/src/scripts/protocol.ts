// Scripts in notes (ROADMAP item 40, DESIGN §6.39): what the page and the sandbox worker say to
// each other, and what a script shows. Everything that crosses is plain JSON data; nothing the
// script produces is ever HTML, code or a function on the page's side.

/** One thing a script shows (`show(…)`), in order. */
export type OutputItem =
  | { t: 'md'; v: string }
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; path: string; title: string }
  | { t: 'embed'; target: string }
  | { t: 'list'; items: OutputItem[] }
  /** Items on one line, separated by a dash (a query's task with its note). */
  | { t: 'inline'; items: OutputItem[] }
  | { t: 'table'; columns: string[]; rows: OutputItem[][] };

/** A script's error: its message, and the line of the script it happened on (1-based) when known. */
export interface ScriptError {
  message: string;
  line: number | null;
  /** `timeout`, `memory`, `output` (too much shown), `host` (an API call failed) or `script`. */
  kind: 'timeout' | 'memory' | 'output' | 'host' | 'script';
}

export interface RunRequest {
  type: 'run';
  id: number;
  code: string;
  /** The note the script is in (`thisNote()`). */
  path: string;
  /** The device's local wall time as if it were UTC (`today()`, `now()`), in milliseconds. */
  now: number;
}

export interface HostReply {
  type: 'reply';
  id: number;
  call: number;
  /** JSON of `{v: value}` or `{e: message}`. */
  json: string;
}

export type ToWorker = RunRequest | HostReply;

export interface HostCall {
  type: 'call';
  id: number;
  call: number;
  name: string;
  /** JSON of the arguments. */
  args: string;
}

export interface RunDone {
  type: 'done';
  id: number;
  output: OutputItem[];
  error: ScriptError | null;
}

export type FromWorker = HostCall | RunDone;

// ---------- limits ----------

/** CPU time a run may take in the sandbox, excluding the time its API calls wait for the page. */
export const CPU_LIMIT_MS = 250;
/** The sandbox's heap. */
export const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const STACK_LIMIT_BYTES = 512 * 1024;
/** API calls one run may make. */
export const MAX_HOST_CALLS = 200;
/** What one run may show: items, and the JSON they make. */
export const MAX_OUTPUT_ITEMS = 2000;
export const MAX_OUTPUT_BYTES = 512 * 1024;
/** A run that has not finished after this long (wall time, API calls included) is stopped: the worker is replaced. */
export const WALL_LIMIT_MS = 15_000;

const KINDS = new Set(['md', 'text', 'code', 'link', 'embed', 'list', 'inline', 'table']);

/** Checks an output item's shape (it comes from the sandbox); null if it is not one. */
export function checkItem(x: unknown, depth = 0): OutputItem | null {
  if (depth > 8 || typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.t !== 'string' || !KINDS.has(o.t)) return null;
  switch (o.t) {
    case 'md':
    case 'text':
    case 'code':
      return typeof o.v === 'string' ? { t: o.t, v: o.v } : null;
    case 'link':
      return typeof o.path === 'string' && typeof o.title === 'string' ? { t: 'link', path: o.path, title: o.title } : null;
    case 'embed':
      return typeof o.target === 'string' ? { t: 'embed', target: o.target } : null;
    case 'list':
    case 'inline': {
      if (!Array.isArray(o.items)) return null;
      const items = o.items.map((i) => checkItem(i, depth + 1));
      return items.every((i) => i !== null) ? { t: o.t, items: items as OutputItem[] } : null;
    }
    case 'table': {
      if (!Array.isArray(o.columns) || !o.columns.every((c) => typeof c === 'string') || !Array.isArray(o.rows)) return null;
      const rows: OutputItem[][] = [];
      for (const row of o.rows) {
        if (!Array.isArray(row)) return null;
        const cells = row.map((c) => checkItem(c, depth + 1));
        if (!cells.every((c) => c !== null)) return null;
        rows.push(cells as OutputItem[]);
      }
      return { t: 'table', columns: o.columns as string[], rows };
    }
  }
  return null;
}
