import { afterEach, describe, expect, it } from 'vitest';
import type { NotesQueryResponse, QueriedNote } from '../api/types';
import { notesQueryUrl, type NotesFilter } from './api';
import { createHost, formulaLiteral, notesFilter, type HostDeps } from './host';
import { resetRunnerForTests, runScript } from './runner';

const alpha: QueriedNote = { path: 'P/Alpha.md', title: 'Alpha', aliases: [], tags: ['project'], frontmatter: { status: 'open' }, mtime: '2026-10-20T10:00:00.000Z', size: 5, links: [], tasks: [{ line: 2, status: ' ', done: false, text: 'call' }] };

function deps(overrides: Partial<HostDeps> = {}): HostDeps & { filters: NotesFilter[] } {
  const filters: NotesFilter[] = [];
  return {
    filters,
    path: 'Here.md',
    queryNotes: async (f): Promise<NotesQueryResponse> => {
      filters.push(f);
      const notes = f.path && f.path !== alpha.path ? [] : [alpha];
      return { notes: notes.map((n) => (f.tasks ? n : { ...n, tasks: null })), total: notes.length, truncated: false };
    },
    readText: async (p) => `text of ${p}`,
    resolve: (t) => (t === 'Alpha' || t === 'P/Alpha.md' ? 'P/Alpha.md' : t === 'Here.md' ? 'Here.md' : null),
    evaluate: async (e) => (e === '=SUM(1,2,"a""b",TRUE,{1,2;3,4})' ? 3 : e === '=budget!B5' ? 1725 : { error: '#NAME?', message: 'Unknown' }),
    ...overrides,
  };
}

afterEach(() => resetRunnerForTests());

describe('script host (ROADMAP 40)', () => {
  it('checks filters and builds the endpoint URL with repeated parameters', () => {
    expect(notesFilter({ tag: ['#project', 'x'], prop: { status: 'done', archived: true }, search: 'a b' })).toMatchObject({ tag: ['project', 'x'], prop: ['status=done', 'archived'], q: 'a b' });
    expect(() => notesFilter({ evil: 1 })).toThrow('Unknown filter: evil');
    expect(() => notesFilter({ limit: 99999 })).toThrow('limit');
    expect(() => notesFilter('x')).toThrow();
    expect(notesQueryUrl({ tag: ['a', 'b c'], prop: ['s!=x,y'], tasks: true, limit: 5 })).toBe('/api/notes/query?tag=a&tag=b%20c&prop=s!%3Dx%2Cy&tasks=true&limit=5');
  });

  it('writes formula arguments as spreadsheet literals', () => {
    expect(formulaLiteral('say "hi"')).toBe('"say ""hi"""');
    expect(formulaLiteral([[1, 2], [3, 4]])).toBe('{1,2;3,4}');
    expect(() => formulaLiteral({})).toThrow();
    expect(() => formulaLiteral(Infinity)).toThrow();
  });

  it('answers calls with JSON, refuses unknown ones, and records what was read', async () => {
    const d = deps();
    const host = createHost(d);
    expect(JSON.parse(await host.call('note', '"Alpha"')).v.path).toBe('P/Alpha.md');
    expect(host.reads.paths.has('P/Alpha.md')).toBe(true);
    expect(host.reads.broad).toBe(false);
    expect(JSON.parse(await host.call('text', '"P/Alpha.md"')).v).toBe('text of P/Alpha.md');
    expect(JSON.parse(await host.call('text', '"../../etc/passwd"')).e).toContain('No note');
    expect(JSON.parse(await host.call('saveFile', '{}')).e).toContain('Unknown API call');
    expect(JSON.parse(await host.call('constructor', '{}')).e).toContain('Unknown API call');
    expect(JSON.parse(await host.call('notes', '{"tag":"project"}')).v).toHaveLength(1);
    expect(host.reads.broad).toBe(true);
    expect(JSON.parse(await host.call('fn', '{"name":"sum","args":[1,2,"a\\"b",true,[[1,2],[3,4]]]}')).v).toBe(3);
    expect(JSON.parse(await host.call('fn', '{"name":"SUM)+HACK(","args":[]}')).e).toContain('Not a formula function');
    expect(JSON.parse(await host.call('formula', '"budget!B5"')).v).toBe(1725);
    expect(JSON.parse(await host.call('formula', '"nope()"')).e).toContain('#NAME?');
    expect(JSON.parse(await host.call('tasks', '{"done":false}')).v[0].task.text).toBe('call');
  });

  it('runs a whole script with notes, tasks, formulas and a query (in the page without Worker support)', async () => {
    const r = await runScript(
      `const ns = notes({ tag: "project" });
       show(list(ns), ns[0].tasks()[0].text, fn.SUM(1, 2, 'a"b', true, [[1,2],[3,4]]), formula("=budget!B5"));
       show(query('TABLE status FROM #project'));`,
      deps(),
    );
    expect(r.error).toBeNull();
    expect(r.output).toEqual([
      { t: 'list', items: [{ t: 'link', path: 'P/Alpha.md', title: 'Alpha' }] },
      { t: 'md', v: 'call' },
      { t: 'text', v: '3' },
      { t: 'text', v: '1725' },
      { t: 'table', columns: ['File', 'status'], rows: [[{ t: 'link', path: 'P/Alpha.md', title: 'Alpha' }, { t: 'text', v: 'open' }]] },
    ]);
    expect(r.reads.broad).toBe(true);
  });

  it('reports a query error as the script’s error', async () => {
    const r = await runScript('show(query("SELECT nothing"))', deps());
    expect(r.error?.message).toContain('Query: A query starts with TABLE, LIST or TASK');
  });
});

describe('script host: escapes (security re-test)', () => {
  it('a __proto__ key in a call’s arguments pollutes nothing on the page', async () => {
    const host = createHost(deps());
    const reply = JSON.parse(await host.call('notes', '{"__proto__":{"polluted":1},"tag":"project"}'));
    expect(reply.e).toContain('Unknown filter: __proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(await host.call('__proto__', '{}')).e).toContain('Unknown API call');
    expect(JSON.parse(await host.call('hasOwnProperty', '{}')).e).toContain('Unknown API call');
  });

  it('formula() cannot reach beyond one expression, and text() only notes the index has', async () => {
    const seen: string[] = [];
    const host = createHost(deps({ evaluate: async (e) => (seen.push(e), 1) }));
    expect(JSON.parse(await host.call('formula', JSON.stringify('x'.repeat(9000)))).e).toContain('formula() takes');
    expect(JSON.parse(await host.call('fn', '{"name":"SUM","args":[{"a":1}]}')).e).toContain('Formula arguments');
    expect(JSON.parse(await host.call('text', '"/etc/passwd"')).e).toContain('No note');
    expect(seen).toEqual([]);
  });
});
