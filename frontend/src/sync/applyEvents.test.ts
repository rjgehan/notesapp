import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, MoveResult, TreeResponse } from '../api/types';
import { DEFAULT_SETTINGS } from '../features/settings';
import { basenameOf, extensionOf, folderOf, lastSegment } from '../features/paths';
import type { DocumentSession } from './DocumentSession';
import {
  applyAttachmentResult,
  applyEvent,
  applyFolderResult,
  applyHistoryRestoreResult,
  applyMoveResult,
  applyRestoreResult,
  applyTrashEntry,
  type SyncTarget,
} from './applyEvents';
import { MoveMap } from './moves';

function entry(path: string, version: string | null = 'v1', aliases: string[] = []): FileEntry {
  const ext = extensionOf(path);
  return {
    path,
    name: lastSegment(path),
    basename: basenameOf(path),
    extension: ext,
    kind: ext === 'md' ? 'note' : ext === 'png' ? 'image' : 'other',
    size: 10,
    mtime: '2026-10-16T10:00:00.000Z',
    version,
    aliases,
  };
}

function tree(paths: string[]): TreeResponse {
  const folders = new Set<string>();
  for (const p of paths) for (let f = folderOf(p); f; f = folderOf(f)) folders.add(f);
  return { eventId: 'b.1', folders: [...folders].sort().map((path) => ({ path, name: lastSegment(path) })), files: paths.sort().map((p) => entry(p)) };
}

interface FakeSession {
  path: string;
  onRemoteChanged: ReturnType<typeof vi.fn>;
  onRemoteDeleted: ReturnType<typeof vi.fn>;
}

let qc: QueryClient;
let sessions: FakeSession[];
let target: SyncTarget;
let applyMove: Mock<(from: string, to: string, type: 'file' | 'folder') => void>;
let onEntryMoved: Mock<(from: string, to: string, type: 'file' | 'folder') => void>;
let rekey: Mock<(from: string, to: string) => Promise<void>>;

const ALL_KEYS = [
  queryKeys.tags(),
  queryKeys.search('plan', 'relevance'),
  queryKeys.backlinks('Plan.md', false),
  queryKeys.meta('Plan.md'),
  queryKeys.meta('Other.md'),
  queryKeys.templates(),
  queryKeys.trash(),
  queryKeys.history('Plan.md'),
  queryKeys.history('Other.md'),
  queryKeys.status(),
  queryKeys.settings(),
  queryKeys.bookmarks(),
];

function invalidated(): string[] {
  return ALL_KEYS.filter((k) => qc.getQueryState(k)?.isInvalidated).map((k) => k.join(':'));
}

const paths = () => qc.getQueryData<TreeResponse>(queryKeys.tree())!.files.map((f) => f.path);
const folders = () => qc.getQueryData<TreeResponse>(queryKeys.tree())!.folders.map((f) => f.path);

function session(path: string): FakeSession {
  const s: FakeSession = { path, onRemoteChanged: vi.fn(async () => {}), onRemoteDeleted: vi.fn() };
  sessions.push(s);
  return s;
}

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData(queryKeys.tree(), tree(['Plan.md', 'Projects/Spec.md', 'Projects/Alpha/notes.md', 'Templates/Daily.md']));
  for (const k of ALL_KEYS) qc.setQueryData(k, {});
  qc.setQueryData(queryKeys.file('Plan.md'), { content: 'x' });
  qc.setQueryData(queryKeys.file('Projects/Spec.md'), { content: 'x' });
  sessions = [];
  const documents = {
    get: (p: string) => sessions.find((s) => s.path === p) as unknown as DocumentSession | undefined,
    all: () => sessions as unknown as DocumentSession[],
    applyMove: (applyMove = vi.fn()),
  };
  target = {
    qc,
    documents,
    moves: new MoveMap(),
    drafts: { rekey: (rekey = vi.fn(async () => {})) },
    settings: () => DEFAULT_SETTINGS,
    onEntryMoved: (onEntryMoved = vi.fn()),
    onDraftFailure: vi.fn(),
  };
});

describe('applyEvent (DESIGN §6.3)', () => {
  it('file.created inserts the entry and invalidates tags and search (templates under the folder)', () => {
    applyEvent(target, 'file.created', { file: entry('Ideas/New.md'), origin: null });
    expect(paths()).toContain('Ideas/New.md');
    expect(folders()).toContain('Ideas');
    expect(invalidated()).toEqual(expect.arrayContaining(['tags', 'search:plan:relevance']));
    expect(invalidated()).not.toContain('templates');
    applyEvent(target, 'file.created', { file: entry('Templates/Meeting.md'), origin: null });
    expect(invalidated()).toContain('templates');
  });

  it('file.created lets a session left on a tombstone at that path catch up', () => {
    const s = session('Gone.md');
    applyEvent(target, 'file.created', { file: entry('Gone.md', 'v9'), origin: null });
    expect(s.onRemoteChanged).toHaveBeenCalledWith(expect.objectContaining({ version: 'v9' }));
  });

  it('file.changed replaces the entry, removes the cached file without a session, and invalidates', () => {
    applyEvent(target, 'file.changed', { file: entry('Plan.md', 'v2', ['Roadmap']), origin: null });
    const updated = qc.getQueryData<TreeResponse>(queryKeys.tree())!.files.find((f) => f.path === 'Plan.md')!;
    expect(updated).toMatchObject({ version: 'v2', aliases: ['Roadmap'] });
    expect(qc.getQueryData(queryKeys.file('Plan.md'))).toBeUndefined();
    expect(invalidated()).toEqual(expect.arrayContaining(['meta:Plan.md', 'backlinks:Plan.md:false', 'tags', 'search:plan:relevance']));
    expect(invalidated()).not.toContain('meta:Other.md');
  });

  it('file.changed hands an open note to its session and still drops its stale file query (embeds)', () => {
    const s = session('Plan.md');
    applyEvent(target, 'file.changed', { file: entry('Plan.md', 'v2'), origin: null });
    expect(s.onRemoteChanged).toHaveBeenCalledWith(expect.objectContaining({ version: 'v2' }));
    // A note opened once keeps its session for the page's lifetime; ![[Plan]] embeds read the query.
    expect(qc.getQueryData(queryKeys.file('Plan.md'))).toBeUndefined();
  });

  it('file.changed refetches an observed file query (a mounted embed) even when the note has a session', async () => {
    session('Plan.md');
    const queryFn = vi.fn(async () => ({ path: 'Plan.md', kind: 'note', content: 'new B from phone', version: 'v2', size: 1, mtime: '', lossy: false }));
    qc.setQueryData(queryKeys.file('Plan.md'), { path: 'Plan.md', kind: 'note', content: 'old B', version: 'v1', size: 1, mtime: '', lossy: false });
    const observer = new QueryObserver(qc, { queryKey: queryKeys.file('Plan.md'), queryFn, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    applyEvent(target, 'file.changed', { file: entry('Plan.md', 'v2'), origin: null });
    await vi.waitFor(() => expect(qc.getQueryData<{ content: string }>(queryKeys.file('Plan.md'))?.content).toBe('new B from phone'));
    unsubscribe();
  });

  it('link updates of a move refresh the rewritten notes\' file queries even when they have sessions', () => {
    session('Other.md');
    qc.setQueryData(queryKeys.file('Other.md'), { path: 'Other.md', content: 'old link' });
    applyMoveResult(target, { from: 'Plan.md', to: 'Plans/Plan.md', type: 'file', dryRun: false, createdFolders: [], moved: [], linkUpdates: [{ path: 'Other.md', version: 'v9' }], failed: [] } as unknown as MoveResult);
    expect(qc.getQueryData(queryKeys.file('Other.md'))).toBeUndefined();
  });

  it('applying the same event twice changes nothing more', () => {
    applyEvent(target, 'file.changed', { file: entry('Plan.md', 'v2'), origin: null });
    const before = qc.getQueryData(queryKeys.tree());
    applyEvent(target, 'file.changed', { file: entry('Plan.md', 'v2'), origin: null });
    expect(qc.getQueryData(queryKeys.tree())).toBe(before);
  });

  it('file.deleted removes the entry and its file query and notifies the session with the trash id', () => {
    const s = session('Plan.md');
    applyEvent(target, 'file.deleted', { path: 'Plan.md', trashed: true, trashId: '01JA7Q3M9K2Z', origin: null });
    expect(paths()).not.toContain('Plan.md');
    expect(qc.getQueryData(queryKeys.file('Plan.md'))).toBeUndefined();
    expect(s.onRemoteDeleted).toHaveBeenCalledWith('01JA7Q3M9K2Z');
    expect(invalidated()).toEqual(expect.arrayContaining(['backlinks:Plan.md:false', 'tags', 'search:plan:relevance']));
  });

  it('folder.created and folder.deleted patch the folders; a delete removes descendants and notifies their sessions', () => {
    applyEvent(target, 'folder.created', { path: 'Inbox/Later', origin: null });
    expect(folders()).toEqual(expect.arrayContaining(['Inbox', 'Inbox/Later']));
    const inside = session('Projects/Alpha/notes.md');
    const outside = session('Plan.md');
    applyEvent(target, 'folder.deleted', { path: 'Projects', trashed: true, trashId: 'T1', origin: null });
    expect(paths()).toEqual(['Plan.md', 'Templates/Daily.md']);
    expect(folders()).not.toContain('Projects/Alpha');
    expect(qc.getQueryData(queryKeys.file('Projects/Spec.md'))).toBeUndefined();
    expect(inside.onRemoteDeleted).toHaveBeenCalledWith('T1');
    expect(outside.onRemoteDeleted).not.toHaveBeenCalled();
  });

  it('entry.moved re-keys the tree, records the move, re-keys drafts and sessions, and re-routes', () => {
    applyEvent(target, 'entry.moved', { from: 'Plan.md', to: 'Archive/Plan.md', type: 'file', origin: null });
    expect(paths()).toContain('Archive/Plan.md');
    expect(paths()).not.toContain('Plan.md');
    expect(folders()).toContain('Archive');
    expect(qc.getQueryData(queryKeys.file('Plan.md'))).toBeUndefined();
    expect(target.moves.lookup('plan.md')).toBe('Archive/Plan.md');
    expect(rekey).toHaveBeenCalledWith('Plan.md', 'Archive/Plan.md');
    expect(applyMove).toHaveBeenCalledWith('Plan.md', 'Archive/Plan.md', 'file');
    expect(onEntryMoved).toHaveBeenCalledWith('Plan.md', 'Archive/Plan.md', 'file');
    expect(invalidated()).toContain('backlinks:Plan.md:false');
  });

  it('entry.moved of a folder re-keys every descendant', () => {
    applyEvent(target, 'entry.moved', { from: 'Projects', to: 'Work/Projects', type: 'folder', origin: null });
    expect(paths()).toEqual(['Plan.md', 'Templates/Daily.md', 'Work/Projects/Alpha/notes.md', 'Work/Projects/Spec.md']);
    expect(folders()).toEqual(expect.arrayContaining(['Work', 'Work/Projects', 'Work/Projects/Alpha']));
    expect(target.moves.lookup('Projects/Alpha/notes.md')).toBe('Work/Projects/Alpha/notes.md');
  });

  it('trash, history, settings and status events invalidate their queries', () => {
    applyEvent(target, 'trash.changed', {});
    expect(invalidated()).toEqual(['trash']);
    applyEvent(target, 'history.committed', { commitId: 'c', message: 'm', authorName: 'a', time: '', paths: ['Plan.md'], truncated: false });
    expect(invalidated()).toEqual(expect.arrayContaining(['history:Plan.md', 'status']));
    expect(invalidated()).not.toContain('history:Other.md');
    applyEvent(target, 'settings.changed', { version: 'v', origin: null });
    expect(invalidated()).toContain('settings');
    applyEvent(target, 'bookmarks.changed', { version: 'v', origin: null });
    expect(invalidated()).toContain('bookmarks');
  });

  it('a truncated history.committed invalidates every history', () => {
    applyEvent(target, 'history.committed', { commitId: 'c', message: 'm', authorName: 'a', time: '', paths: [], truncated: true });
    expect(invalidated()).toEqual(expect.arrayContaining(['history:Plan.md', 'history:Other.md']));
  });
});

describe('own mutations (DESIGN §6.3)', () => {
  const move = (over: Partial<MoveResult> = {}): MoveResult => ({
    dryRun: false,
    type: 'file',
    from: 'Plan.md',
    to: 'Ideas/Roadmap.md',
    moved: [{ from: 'Plan.md', to: 'Ideas/Roadmap.md' }],
    createdFolders: ['Ideas'],
    linkUpdates: [
      { path: 'Projects/Spec.md', links: 1, version: 'v7' },
      { path: 'Projects/Alpha/notes.md', links: 2, version: 'v8' },
    ],
    failed: [],
    commitId: 'c',
    ...over,
  });

  it('MoveResult re-keys, records, refreshes the rewritten notes and invalidates', () => {
    const open = session('Projects/Alpha/notes.md');
    applyMoveResult(target, move());
    expect(paths()).toContain('Ideas/Roadmap.md');
    expect(folders()).toContain('Ideas');
    const files = qc.getQueryData<TreeResponse>(queryKeys.tree())!.files;
    expect(files.find((f) => f.path === 'Projects/Spec.md')?.version).toBe('v7');
    expect(files.find((f) => f.path === 'Ideas/Roadmap.md')).toMatchObject({ name: 'Roadmap.md', basename: 'Roadmap' });
    expect(open.onRemoteChanged).toHaveBeenCalledWith({ version: 'v8' }, { quiet: true });
    expect(qc.getQueryData(queryKeys.file('Projects/Spec.md'))).toBeUndefined();
    expect(rekey).toHaveBeenCalledWith('Plan.md', 'Ideas/Roadmap.md');
    expect(target.moves.lookup('Plan.md')).toBe('Ideas/Roadmap.md');
    expect(invalidated()).toEqual(expect.arrayContaining(['backlinks:Plan.md:false', 'tags', 'search:plan:relevance']));
  });

  it('a dry run changes nothing', () => {
    const before = qc.getQueryData(queryKeys.tree());
    applyMoveResult(target, move({ dryRun: true }));
    expect(qc.getQueryData(queryKeys.tree())).toBe(before);
    expect(rekey).not.toHaveBeenCalled();
    expect(invalidated()).toEqual([]);
  });

  it('TrashEntry removes the entry or folder and invalidates, trash included', () => {
    applyTrashEntry(target, { id: 'T', originalPath: 'Projects', type: 'folder', deletedAt: '', deletedBy: '', size: 0, fileCount: 2 });
    expect(paths()).toEqual(['Plan.md', 'Templates/Daily.md']);
    expect(qc.getQueryData(queryKeys.file('Projects/Spec.md'))).toBeUndefined();
    expect(invalidated()).toEqual(expect.arrayContaining(['trash', 'tags', 'backlinks:Plan.md:false', 'search:plan:relevance']));
  });

  it('RestoreResult adds files and folders, lets a tombstone session adopt the file, and invalidates', () => {
    const tomb = session('Old/Gone.md');
    applyRestoreResult(target, { type: 'file', path: 'Old/Gone.md', files: [entry('Old/Gone.md', 'v3')], createdFolders: ['Old'], commitId: null });
    expect(paths()).toContain('Old/Gone.md');
    expect(folders()).toContain('Old');
    expect(tomb.onRemoteChanged).toHaveBeenCalledWith(expect.objectContaining({ version: 'v3' }), { quiet: true });
    expect(invalidated()).toEqual(expect.arrayContaining(['trash', 'tags']));
  });

  it('HistoryRestoreResult upserts the file, the session adopts it, and its meta is invalidated', () => {
    const s = session('Plan.md');
    applyHistoryRestoreResult(target, { file: entry('Plan.md', 'v5'), created: false, createdFolders: [], commitId: 'c' });
    expect(s.onRemoteChanged).toHaveBeenCalledWith(expect.objectContaining({ version: 'v5' }), { quiet: true });
    expect(invalidated()).toEqual(expect.arrayContaining(['meta:Plan.md', 'tags', 'backlinks:Plan.md:false', 'search:plan:relevance']));
  });

  it('AttachmentResult and FolderResult add their entries', () => {
    applyAttachmentResult(target, { file: entry('Attachments/pic.png', null), created: true, createdFolders: ['Attachments'], linkText: 'pic.png', markdown: '![[pic.png]]' });
    applyFolderResult(target, { folder: { path: 'Inbox/Sub', name: 'Sub' }, createdFolders: ['Inbox', 'Inbox/Sub'] });
    expect(paths()).toContain('Attachments/pic.png');
    expect(folders()).toEqual(expect.arrayContaining(['Attachments', 'Inbox', 'Inbox/Sub']));
  });
});
