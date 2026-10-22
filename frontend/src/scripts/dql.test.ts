import { describe, expect, it } from 'vitest';
import type { QueriedNote } from '../api/types';
import { parseQuery, QueryError, runQuery, sourceFilter, type EvalContext } from './dql';

function note(path: string, frontmatter: Record<string, unknown> | null, extra: Partial<QueriedNote> = {}): QueriedNote {
  const title = path.split('/').pop()!.replace(/\.md$/, '');
  return { path, title, aliases: [], tags: [], frontmatter, mtime: '2026-10-20T10:00:00.000Z', size: 10, links: [], tasks: null, ...extra };
}

const ctx: EvalContext = {
  today: '2026-10-21',
  now: '2026-10-21T09:30',
  localTime: (iso) => iso.slice(0, 16),
  resolve: (t) => (t === 'Ann' ? 'People/Ann.md' : t.endsWith('.md') ? t : null),
};

const NOTES = [
  note('Projects/Alpha.md', { status: 'active', due: '2026-11-01', owner: '[[Ann]]', priority: 2 }, { tags: ['project'] }),
  note('Projects/Beta.md', { status: 'done', due: '2026-10-01', priority: 1 }, { tags: ['project', 'archive'] }),
  note('Projects/Gamma.md', { status: 'active', priority: 3 }, { tags: ['project'] }),
];

describe('Dataview-style queries (ROADMAP 17)', () => {
  it('parses the clauses and gives the endpoint the FROM filters', () => {
    const q = parseQuery('TABLE due, status AS "State" FROM #project and "Projects" WHERE status != "done" SORT due DESC LIMIT 5');
    expect(q.kind).toBe('table');
    expect(q.fields.map((f) => f.name)).toEqual(['due', 'State']);
    expect(sourceFilter(q)).toEqual({ tag: ['project'], folder: 'Projects', linksTo: null, tasks: false });
    expect(q.limit).toBe(5);
    expect(sourceFilter(parseQuery('TASK FROM [[Ann]]'))).toEqual({ tag: [], folder: null, linksTo: 'Ann', tasks: true });
  });

  it('runs a TABLE with WHERE and SORT; empty values sort last', () => {
    const out = runQuery(parseQuery('TABLE due, status FROM #project WHERE status != "done" SORT due'), NOTES, ctx);
    expect(out).toEqual({
      t: 'table',
      columns: ['File', 'due', 'status'],
      rows: [
        [{ t: 'link', path: 'Projects/Alpha.md', title: 'Alpha' }, { t: 'text', v: '2026-11-01' }, { t: 'text', v: 'active' }],
        [{ t: 'link', path: 'Projects/Gamma.md', title: 'Gamma' }, { t: 'text', v: '' }, { t: 'text', v: 'active' }],
      ],
    });
  });

  it('compares dates, links, numbers and lists, with functions', () => {
    const titles = (src: string) => {
      const out = runQuery(parseQuery(src), NOTES, ctx);
      return out.t === 'list' ? out.items.map((i) => (i.t === 'link' ? i.title : '?')) : [];
    };
    expect(titles('LIST WHERE due < date(today)')).toEqual(['Beta']);
    expect(titles('LIST WHERE owner = [[Ann]]')).toEqual(['Alpha']);
    expect(titles('LIST WHERE priority >= 2 SORT priority DESC')).toEqual(['Gamma', 'Alpha']);
    expect(titles('LIST WHERE contains(file.tags, "#archive")')).toEqual(['Beta']);
    expect(titles('LIST WHERE !contains(file.tags, "#archive") and (status = "ACTIVE" or false) LIMIT 1')).toEqual(['Alpha']);
    expect(titles('LIST WHERE default(due, "none") = "none"')).toEqual(['Gamma']);
    expect(titles('LIST WHERE file.folder = "Projects" and startswith(file.name, "g")')).toEqual(['Gamma']);
  });

  it('runs LIST with a value, TABLE WITHOUT ID with arithmetic, and TASK', () => {
    expect(runQuery(parseQuery('LIST status SORT file.name LIMIT 1'), NOTES, ctx)).toEqual({ t: 'list', items: [{ t: 'inline', items: [{ t: 'link', path: 'Projects/Alpha.md', title: 'Alpha' }, { t: 'text', v: 'active' }] }] });
    expect(runQuery(parseQuery('TABLE WITHOUT ID file.name AS "Name", priority * 10 SORT priority LIMIT 1'), NOTES, ctx)).toEqual({ t: 'table', columns: ['Name', 'priority * 10'], rows: [[{ t: 'text', v: 'Beta' }, { t: 'text', v: '10' }]] });
    const withTasks = [note('A.md', null, { tasks: [{ line: 3, status: ' ', done: false, text: 'call Ann' }, { line: 4, status: 'x', done: true, text: 'buy milk' }] })];
    expect(runQuery(parseQuery('TASK WHERE !completed'), withTasks, ctx)).toEqual({ t: 'list', items: [{ t: 'inline', items: [{ t: 'text', v: '☐ call Ann' }, { t: 'link', path: 'A.md', title: 'A' }] }] });
  });

  it('refuses what it does not support, with a message', () => {
    for (const bad of ['SELECT x', 'TABLE x FROM #a OR #b', 'LIST GROUP BY status', 'LIST WHERE (a', 'LIST FROM -#a', 'LIST WHERE "open', 'TABLE x FROM "a" and "b"']) {
      expect(() => parseQuery(bad), bad).toThrow(QueryError);
    }
    expect(() => runQuery(parseQuery('LIST WHERE nope(1)'), NOTES, ctx)).toThrow('Unknown function nope()');
  });
});
