// The app's side of script blocks (ROADMAP items 40 and 17, DESIGN §6.43): a block runs end to end in
// the sandbox (in the page: tests have no Worker) against the notes query, and comes back as
// Markdown; the event handlers decide which changes make results stale.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { NotesQueryResponse, QueriedNote } from '../api/types';
import type { NotesFilter } from './api';
import { dataviewScript, runNoteScript } from './noteScripts';
import { changedPaths } from './register';
import { resetRunnerForTests } from './runner';

const queries: NotesFilter[] = [];

function queried(path: string, extra: Partial<QueriedNote> = {}): QueriedNote {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return { path, title, aliases: [], tags: [], frontmatter: null, mtime: '2026-10-20T10:00:00Z', size: 10, links: [], tasks: null, ...extra };
}

const NOTES = [queried('P/Alpha.md', { tags: ['project'], frontmatter: { status: 'open' } }), queried('P/Beta.md', { tags: ['project'], frontmatter: { status: 'done' } })];

vi.mock('./api', () => ({
  queryNotes: async (f: NotesFilter): Promise<NotesQueryResponse> => {
    queries.push(f);
    const notes = f.path ? NOTES.filter((n) => n.path === f.path) : NOTES.filter((n) => !f.tag?.length || f.tag.every((t) => n.tags.includes(t)));
    return { notes, total: notes.length, truncated: false };
  },
}));

const TREE = {
  eventId: 'b.1',
  folders: [{ path: 'P', name: 'P' }],
  files: NOTES.map((n) => ({ path: n.path, name: n.title + '.md', basename: n.title, extension: 'md', kind: 'note' as const, size: 10, mtime: n.mtime, version: 'v', aliases: [] })),
};

const evaluate = async () => null;

beforeEach(() => {
  queries.length = 0;
  queryClient.setQueryData(queryKeys.tree(), TREE);
});

afterEach(() => {
  queryClient.clear();
  resetRunnerForTests();
});

describe('runNoteScript', () => {
  it('runs a script and returns its Markdown (links as wikilinks) and what it read', async () => {
    const r = await runNoteScript('Here.md', { kind: 'script', source: 'const a = note("Alpha")\nshow(a, "1 < 2 *not bold*")', evaluate });
    expect(r.error).toBeNull();
    expect(r.markdown).toBe('[[P/Alpha.md|Alpha]]\n\n1 < 2 *not bold*');
    expect([...r.reads.paths]).toEqual(['P/Alpha.md']);
    expect(r.reads.broad).toBe(false);
  });

  it('runs a dataview block as a query', async () => {
    const r = await runNoteScript('Here.md', { kind: 'dataview', source: 'TABLE status FROM #project WHERE status != "done"', evaluate });
    expect(r.error).toBeNull();
    expect(r.markdown).toContain('[[P/Alpha.md\\|Alpha]]');
    expect(r.markdown).not.toContain('Beta');
    expect(r.reads.broad).toBe(true);
    expect(queries[0].tag).toEqual(['project']);
  });

  it('reports a script error with its line, and a query error without one', async () => {
    const s = await runNoteScript('Here.md', { kind: 'script', source: 'show(1)\nnope()', evaluate });
    expect(s.markdown).toBe('1');
    expect(s.error).toMatchObject({ line: 2 });
    expect(s.error!.message).toMatch(/nope/);
    const q = await runNoteScript('Here.md', { kind: 'dataview', source: 'TABLE x GROUP BY y', evaluate });
    expect(q.error).toMatchObject({ line: null });
    expect(q.error!.message).toMatch(/GROUP is not supported/);
  });

  it('a dataview block is a string to the script, whatever it holds', () => {
    expect(dataviewScript('LIST "a")); show(("')).toBe('show(query("LIST \\"a\\")); show((\\""))');
  });
});

describe('changedPaths', () => {
  it('reads the paths an event changed, or null when any note may have changed', () => {
    const file = { path: 'A.md', name: 'A.md' };
    expect(changedPaths('file.changed', { file, origin: null })).toEqual(['A.md']);
    expect(changedPaths('file.created', { file, origin: null })).toEqual(['A.md']);
    expect(changedPaths('file.deleted', { path: 'A.md' })).toEqual(['A.md']);
    expect(changedPaths('entry.moved', { from: 'A.md', to: 'B/A.md', type: 'file' })).toEqual(['A.md', 'B/A.md']);
    expect(changedPaths('entry.moved', { from: 'A', to: 'B', type: 'folder' })).toBeNull();
    expect(changedPaths('folder.deleted', { path: 'A' })).toBeNull();
    expect(changedPaths('resync', { reason: 'bulk-change' })).toBeNull();
    expect(changedPaths('file.changed', null)).toBeNull();
  });
});
