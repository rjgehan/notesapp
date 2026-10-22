// Scripts in notes (ROADMAP item 40, DESIGN §6.39): the API a script sees, run inside the QuickJS
// sandbox before the script. It has no DOM, no network and no storage: only the two functions the
// worker gives it, `__host` (an API call the page answers, which looks synchronous to the script)
// and `__emit` (one item of output). Both are taken out of the global object before the script
// runs. Every value crossing to the page is JSON text.
/* global __host, __emit, __ctx */
(function () {
  'use strict';
  const host = __host;
  const emitRaw = __emit;
  const ctx = __ctx;
  delete globalThis.__host;
  delete globalThis.__emit;
  delete globalThis.__ctx;

  function call(name, args) {
    const reply = JSON.parse(host(name, JSON.stringify(args === undefined ? null : args)));
    if (reply.e !== undefined) throw new Error(reply.e);
    return reply.v;
  }

  // ---------- dates: local wall time, kept as if it were UTC ----------

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY_MS = 86400000;
  const pad = (n, w) => String(n).padStart(w || 2, '0');

  class NoteDate {
    constructor(ms) {
      this.ms = ms;
    }
    get d() {
      return new Date(this.ms);
    }
    get year() {
      return this.d.getUTCFullYear();
    }
    /** 1–12. */
    get month() {
      return this.d.getUTCMonth() + 1;
    }
    get day() {
      return this.d.getUTCDate();
    }
    get hour() {
      return this.d.getUTCHours();
    }
    get minute() {
      return this.d.getUTCMinutes();
    }
    get weekday() {
      return DAYS[this.d.getUTCDay()];
    }
    /** 1 (Monday) to 7 (Sunday), as ISO counts. */
    get weekdayNumber() {
      return this.d.getUTCDay() || 7;
    }
    format(fmt) {
      const d = this.d;
      const tokens = {
        YYYY: () => pad(d.getUTCFullYear(), 4),
        YY: () => pad(d.getUTCFullYear() % 100),
        MMMM: () => MONTHS[d.getUTCMonth()],
        MMM: () => MONTHS[d.getUTCMonth()].slice(0, 3),
        MM: () => pad(d.getUTCMonth() + 1),
        M: () => String(d.getUTCMonth() + 1),
        DD: () => pad(d.getUTCDate()),
        D: () => String(d.getUTCDate()),
        dddd: () => DAYS[d.getUTCDay()],
        ddd: () => DAYS[d.getUTCDay()].slice(0, 3),
        HH: () => pad(d.getUTCHours()),
        H: () => String(d.getUTCHours()),
        mm: () => pad(d.getUTCMinutes()),
        ss: () => pad(d.getUTCSeconds()),
      };
      return String(fmt === undefined ? 'YYYY-MM-DD' : fmt).replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, (m, literal) => (literal !== undefined ? literal : tokens[m]()));
    }
    add(n, unit) {
      const d = this.d;
      const u = String(unit || 'days').replace(/s$/, '');
      if (u === 'day') return new NoteDate(this.ms + n * DAY_MS);
      if (u === 'week') return new NoteDate(this.ms + 7 * n * DAY_MS);
      if (u === 'hour') return new NoteDate(this.ms + n * 3600000);
      if (u === 'minute') return new NoteDate(this.ms + n * 60000);
      if (u === 'month' || u === 'year') {
        const months = u === 'year' ? 12 * n : n;
        const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
        const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
        target.setUTCDate(Math.min(d.getUTCDate(), last));
        return new NoteDate(target.getTime());
      }
      throw new Error('Unknown unit: ' + unit);
    }
    startOfDay() {
      return new NoteDate(Math.floor(this.ms / DAY_MS) * DAY_MS);
    }
    daysUntil(other) {
      return Math.round((toDate(other).startOfDay().ms - this.startOfDay().ms) / DAY_MS);
    }
    daysSince(other) {
      return -this.daysUntil(other);
    }
    isBefore(other) {
      return this.ms < toDate(other).ms;
    }
    isAfter(other) {
      return this.ms > toDate(other).ms;
    }
    isSameDay(other) {
      return this.daysUntil(other) === 0;
    }
    toString() {
      return this.ms % DAY_MS === 0 ? this.format('YYYY-MM-DD') : this.format('YYYY-MM-DD HH:mm');
    }
    toJSON() {
      return this.toString();
    }
    valueOf() {
      return this.ms;
    }
  }

  const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

  function date(value) {
    if (value instanceof NoteDate) return value;
    if (typeof value === 'number') return new NoteDate(value);
    const m = DATE.exec(String(value).trim().replace(/^\[\[|\]\]$/g, ''));
    if (!m) throw new Error('Not a date: ' + value);
    return new NoteDate(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  }
  const toDate = (v) => (v instanceof NoteDate ? v : date(v));

  // ---------- notes ----------

  const NOTE = Symbol('note');
  const OUT = Symbol('output');

  function makeNote(d) {
    const n = {
      path: d.path,
      title: d.title,
      name: d.title,
      folder: d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '',
      aliases: d.aliases,
      tags: d.tags,
      props: d.frontmatter || {},
      modified: new NoteDate(d.mtimeLocal),
      size: d.size,
      links: d.links,
      text() {
        return call('text', d.path);
      },
      tasks() {
        if (d.tasks) return d.tasks.map((t) => ({ ...t, note: n }));
        return call('noteTasks', d.path).map((t) => ({ ...t, note: n }));
      },
    };
    Object.defineProperty(n, NOTE, { value: true });
    return n;
  }

  function note(ref) {
    const d = call('note', String(ref));
    return d ? makeNote(d) : null;
  }

  function notes(filter) {
    return call('notes', filter || {}).map(makeNote);
  }

  function tasks(filter) {
    return call('tasks', filter || {}).map((t) => ({ ...t.task, note: makeNote(t.note) }));
  }

  // ---------- output ----------

  function out(item) {
    const o = { item };
    Object.defineProperty(o, OUT, { value: true });
    return o;
  }

  function toItem(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v[OUT]) return v.item;
    if (typeof v === 'object' && v[NOTE]) return { t: 'link', path: v.path, title: v.title };
    if (v instanceof NoteDate) return { t: 'text', v: v.toString() };
    if (typeof v === 'string') return { t: 'md', v };
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return { t: 'text', v: String(v) };
    if (v instanceof Error) return { t: 'text', v: String(v) };
    if (Array.isArray(v)) return { t: 'list', items: v.map(cellItem) };
    try {
      return { t: 'code', v: JSON.stringify(v, null, 2) };
    } catch (e) {
      return { t: 'text', v: String(v) };
    }
  }

  /** A list's or table's entry: strings there are plain text, not Markdown blocks. */
  function cellItem(v) {
    if (typeof v === 'string') return { t: 'text', v };
    if (Array.isArray(v)) return { t: 'text', v: v.map((x) => (x && x[NOTE] ? x.title : String(x))).join(', ') };
    return toItem(v) || { t: 'text', v: '' };
  }

  function list(items) {
    return out({ t: 'list', items: Array.from(items || [], cellItem) });
  }

  function cellOf(row, column, index) {
    if (Array.isArray(row)) return row[index];
    if (row && row[NOTE]) {
      if (column === 'title' || column === 'name' || column === 'file') return row;
      if (column === 'modified') return row.modified;
      if (column === 'path' || column === 'folder' || column === 'tags' || column === 'size') return row[column];
      return row.props[column];
    }
    return row === null || row === undefined ? undefined : row[column];
  }

  function table(rows, columns) {
    const all = Array.from(rows || []);
    let cols = columns ? Array.from(columns, String) : null;
    if (!cols) {
      const first = all[0];
      cols = first && first[NOTE] ? ['title'] : first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : [];
    }
    return out({ t: 'table', columns: cols, rows: all.map((r) => cols.map((c, i) => cellItem(cellOf(r, c, i)))) });
  }

  function embed(name) {
    return out({ t: 'embed', target: String(name && name[NOTE] ? name.path : name) });
  }

  function show(...values) {
    for (const v of values) {
      const item = toItem(v);
      if (item) emitRaw(JSON.stringify(item));
    }
  }

  // ---------- formulas (item 39) and queries (item 17) ----------

  const fn = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        return (...args) => call('fn', { name, args: args.map((a) => (a instanceof NoteDate ? a.format('YYYY-MM-DD') : a)) });
      },
    },
  );

  function formula(expression) {
    return call('formula', String(expression));
  }

  function query(text) {
    return out(call('query', String(text)));
  }

  const now = () => new NoteDate(ctx.now);
  const today = () => now().startOfDay();
  const thisNote = () => note(ctx.path);

  const api = { today, now, date, note, notes, tasks, thisNote, show, list, table, embed, fn, formula, query };
  for (const [k, v] of Object.entries(api)) Object.defineProperty(globalThis, k, { value: v, writable: false, configurable: false, enumerable: false });
})();
