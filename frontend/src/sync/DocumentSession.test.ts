import { history, undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../api/client';
import { MockVault } from '../api/mock/vault';
import type { Problem, SaveFileRequest, WriteResult } from '../api/types';
import { isLocalEdit } from '../editor/remote';
import { serverToDocOffset } from '../features/eol';
import { lineHash, toggleTaskAtLine } from '../render/render';
import { fakeApi, MemoryDraftStore, sessionDeps } from '../test/fakes';
import { DocumentSession } from './DocumentSession';
import { DocumentRegistry, KEEPALIVE_BUDGET } from './documents';
import { MoveMap } from './moves';

function setup(content = 'hello', path = 'a.md') {
  const vault = new MockVault(false);
  vault.createFile({ path, content }, 'other-device-1');
  const fake = fakeApi(vault);
  const deps = sessionDeps(fake.api);
  const session = new DocumentSession(path, deps);
  return { vault, fake, deps, session };
}

function problem(p: Record<string, unknown> & Pick<Problem, 'code' | 'status'>): ApiError {
  return new ApiError({ type: `urn:notesapp:problem:${p.code}`, title: p.code, ...p });
}

const text = (s: DocumentSession) => s.getText();
const status = (s: DocumentSession) => s.getSnapshot().status;
const versionOf = (vault: MockVault, path: string) => vault.readFile(path).version;

/** Appends text as a local edit, the way the reading view or a toolbar would. */
function type(s: DocumentSession, insert: string) {
  s.applyEdit({ from: s.editorState.doc.length, insert });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DocumentSession autosave', () => {
  it('saves 1000 ms after the last edit', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    expect(status(session)).toBe('clean');
    type(session, '!');
    expect(status(session)).toBe('dirty');
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.api.saveFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    expect(status(session)).toBe('clean');
    expect(vault.readFile('a.md').content).toBe('hello!');
  });

  it('saves at most 5000 ms after the first unsaved edit while typing continues', async () => {
    const { fake, session } = setup();
    await session.ready;
    for (let t = 0; t < 4500; t += 500) {
      type(session, 'x');
      await vi.advanceTimersByTimeAsync(500);
    }
    // 4500 ms of continuous typing: the debounce never fired.
    expect(fake.api.saveFile).not.toHaveBeenCalled();
    type(session, 'x');
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
  });

  it('keeps one request in flight and saves edits made meanwhile with the returned version', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    const release = fake.holdSaves();
    type(session, ' one');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('saving');
    type(session, ' two');
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe('dirty');
    const firstVersion = session.currentVersion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(2);
    expect((fake.api.saveFile.mock.calls[1][1] as SaveFileRequest).baseVersion).toBe(firstVersion);
    expect(status(session)).toBe('clean');
    expect(vault.readFile('a.md').content).toBe('hello one two');
  });

  it('flushes immediately on demand', async () => {
    const { fake, session } = setup();
    await session.ready;
    type(session, '!');
    await session.flush();
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    expect(status(session)).toBe('clean');
  });
});

describe('DocumentSession conflicts', () => {
  it('a 409 enters conflict and pauses autosave', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    vault.externalWrite('a.md', 'theirs');
    type(session, ' mine');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('conflict');
    expect(session.getSnapshot().conflict).toMatchObject({ theirsText: 'theirs', theirsVersion: versionOf(vault, 'a.md'), source: 'save' });
    type(session, ' more');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
  });

  it('a 409 whose content equals mine becomes clean', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    vault.externalWrite('a.md', 'hello!');
    const current = versionOf(vault, 'a.md');
    fake.failNext(() => {
      throw problem({ code: 'version-conflict', status: 409, path: 'a.md', currentVersion: current, currentContent: 'hello!', currentMtime: null, movedTo: null });
    });
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('clean');
    expect(session.currentVersion).toBe(current);
  });

  it('Keep mine saves with the theirs version and flushHistory', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    vault.externalWrite('a.md', 'theirs');
    type(session, ' mine');
    await vi.advanceTimersByTimeAsync(1000);
    await session.keepMine();
    const req = fake.api.saveFile.mock.calls[1][1] as SaveFileRequest;
    expect(req).toMatchObject({ content: 'hello mine', flushHistory: true });
    expect(status(session)).toBe('clean');
    expect(vault.readFile('a.md').content).toBe('hello mine');
  });

  it('Keep mine blocked by history-unavailable keeps the conflict and mine', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    vault.externalWrite('a.md', 'theirs');
    type(session, ' mine');
    await vi.advanceTimersByTimeAsync(1000);
    fake.failNext(() => {
      throw problem({ code: 'history-unavailable', status: 503, reason: 'commit-failed' });
    });
    await session.keepMine();
    expect(status(session)).toBe('conflict');
    expect(session.getSnapshot().conflict?.historyBlocked).toBe(true);
    expect(text(session)).toBe('hello mine');
  });

  it('Take theirs is undoable and keeps mine in the discarded store', async () => {
    const { vault, deps, session } = setup();
    await session.ready;
    const view = new EditorView({
      state: session.prepareState((st) =>
        st.update({
          effects: StateEffect.reconfigure.of([
            history(),
            EditorView.updateListener.of((u) => {
              if (u.transactions.some(isLocalEdit)) session.markDirty();
            }),
          ]),
        }).state,
      ),
    });
    session.attach(view);
    vault.externalWrite('a.md', 'theirs');
    view.dispatch({ changes: { from: 5, insert: ' mine' }, userEvent: 'input' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('conflict');
    await session.takeTheirs();
    expect(text(session)).toBe('theirs');
    expect(status(session)).toBe('clean');
    expect(session.currentVersion).toBe(versionOf(vault, 'a.md'));
    expect((deps.drafts as MemoryDraftStore).discarded.map((d) => d.text)).toEqual(['hello mine']);
    undo(view);
    expect(text(session)).toBe('hello mine');
    expect(status(session)).toBe('dirty');
    view.destroy();
  });
});

describe('DocumentSession remote changes', () => {
  it('applies a remote change to a clean session', async () => {
    const { vault, deps, session } = setup();
    await session.ready;
    vault.externalWrite('a.md', 'from the phone');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(text(session)).toBe('from the phone');
    expect(status(session)).toBe('clean');
    expect(session.currentVersion).toBe(versionOf(vault, 'a.md'));
    expect(deps.notices).toContain('Updated from another device');
  });

  it('a remote change to a dirty session enters conflict', async () => {
    const { vault, session } = setup();
    await session.ready;
    type(session, ' local');
    vault.externalWrite('a.md', 'remote');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(status(session)).toBe('conflict');
    expect(session.getSnapshot().conflict).toMatchObject({ theirsText: 'remote', source: 'remote' });
  });

  it('a remote change equal to the local text adopts its version', async () => {
    const { vault, session } = setup();
    await session.ready;
    type(session, '!');
    vault.externalWrite('a.md', 'hello!');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(status(session)).toBe('clean');
  });

  it('defers a remote change during an in-flight save and compares it with the new base', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.api.saveFile.mockImplementationOnce(async (path: string, req: SaveFileRequest) => {
      const result: WriteResult = vault.saveFile(path, req, 'me-0000001');
      await gate;
      return structuredClone(result);
    });
    type(session, ' mine');
    await vi.advanceTimersByTimeAsync(1000);
    // Another device saves on top of ours; its event arrives before our 200.
    vault.externalWrite('a.md', 'hello mine and theirs', 'other-device-2');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(status(session)).toBe('saving');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe('clean');
    expect(text(session)).toBe('hello mine and theirs');
    expect(session.currentVersion).toBe(versionOf(vault, 'a.md'));
  });

  it('a remote delete of a clean session shows the tombstone', async () => {
    const { session } = setup();
    await session.ready;
    session.onRemoteDeleted('01JA7Q3M9K2Z');
    expect(session.getSnapshot()).toMatchObject({ status: 'deleted', deleted: { trashId: '01JA7Q3M9K2Z', hasLocalEdits: false } });
  });
});

describe('DocumentSession moves', () => {
  it('a 409 with movedTo re-keys the session and retries at the new path', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    vault.move({ from: 'a.md', to: 'b.md' }, 'other-device-1');
    type(session, ' edit');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.path).toBe('b.md');
    expect(status(session)).toBe('clean');
    expect(fake.api.saveFile.mock.calls.map((c) => c[0])).toEqual(['a.md', 'b.md']);
    expect(vault.readFile('b.md').content).toBe('hello edit');
  });

  it('entry.moved before the save ends in the same state', async () => {
    const { vault, session } = setup();
    await session.ready;
    vault.move({ from: 'a.md', to: 'b.md' }, 'other-device-1');
    type(session, ' edit');
    session.onRemoteMoved('b.md');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.path).toBe('b.md');
    expect(status(session)).toBe('clean');
    expect(vault.readFile('b.md').content).toBe('hello edit');
  });

  it('a 409 without movedTo enters deleted, and entry.moved afterwards returns to dirty and saves', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    vault.move({ from: 'a.md', to: 'b.md' }, 'other-device-1');
    fake.failNext(() => {
      throw problem({ code: 'version-conflict', status: 409, path: 'a.md', currentVersion: null, currentContent: null, currentMtime: null, movedTo: null });
    });
    type(session, ' edit');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('deleted');
    session.onRemoteMoved('b.md');
    expect(status(session)).toBe('dirty');
    await vi.advanceTimersByTimeAsync(10);
    expect(status(session)).toBe('clean');
    expect(vault.readFile('b.md').content).toBe('hello edit');
  });

  it('uses the client move map when the server forgot the move', async () => {
    const { vault, fake } = setup();
    const moves = new MoveMap();
    const session = new DocumentSession('a.md', sessionDeps(fake.api, { moves }));
    await session.ready;
    vault.move({ from: 'a.md', to: 'Folder/b.md' }, 'other-device-1');
    moves.record('a.md', 'Folder/b.md', 'file');
    fake.failNext(() => {
      throw problem({ code: 'version-conflict', status: 409, path: 'a.md', currentVersion: null, currentContent: null, currentMtime: null, movedTo: null });
    });
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.path).toBe('Folder/b.md');
    expect(status(session)).toBe('clean');
  });

  it('re-keys its draft on a move', async () => {
    const { deps, session } = setup();
    await session.ready;
    type(session, ' draft');
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.drafts.forPath('a.md')).toHaveLength(1);
    session.onRemoteMoved('b.md');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.drafts.forPath('a.md')).toHaveLength(0);
    expect(deps.drafts.forPath('b.md')[0]).toMatchObject({ text: 'hello draft', clientId: 'tab-a-000001' });
  });
});

describe('DocumentSession failures', () => {
  it.each([
    ['network error', () => new TransientError('Failed to fetch')],
    ['empty 502', () => new TransientError('HTTP 502', 502)],
  ])('%s goes offline and retries with backoff', async (_name, makeError) => {
    const { fake, session } = setup();
    await session.ready;
    fake.failNext(() => {
      throw makeError();
    });
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('offline');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(2);
    expect(status(session)).toBe('clean');
  });

  it('503 busy honours Retry-After', async () => {
    const { fake, session } = setup();
    await session.ready;
    fake.failNext(() => {
      throw new TransientError('Server busy', 503, 5000);
    });
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('offline');
    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(status(session)).toBe('clean');
  });

  it('io-error shows the storage error and retries', async () => {
    const { fake, session } = setup();
    await session.ready;
    fake.failNext(() => {
      throw problem({ code: 'io-error', status: 500, incidentId: 'x1' });
    });
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('storage-error');
    await vi.advanceTimersByTimeAsync(2000);
    expect(status(session)).toBe('clean');
  });

  it('waits for the event stream to catch up before retrying', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'x' }, 'o');
    const fake = fakeApi(vault);
    let caughtUp = false;
    const session = new DocumentSession('a.md', sessionDeps(fake.api, { caughtUp: () => caughtUp }));
    await session.ready;
    fake.failNext(() => {
      throw new TransientError('Failed to fetch');
    });
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    caughtUp = true;
    session.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe('clean');
  });
});

describe('DocumentSession drafts', () => {
  it('writes a draft while dirty and removes it after the save', async () => {
    const { deps, session } = setup();
    await session.ready;
    type(session, ' draft');
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.drafts.forPath('a.md')[0]).toMatchObject({ text: 'hello draft', baseVersion: session.currentVersion, baseText: 'hello', eol: 'lf' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('clean');
    expect(deps.drafts.forPath('a.md')).toHaveLength(0);
  });

  it('reports a draft write failure', async () => {
    const { fake } = setup();
    const onDraftWrite = vi.fn();
    const deps = sessionDeps(fake.api, { onDraftWrite });
    deps.drafts.failPuts = true;
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    type(session, '!');
    await vi.advanceTimersByTimeAsync(600);
    expect(onDraftWrite).toHaveBeenCalledWith(false);
  });

  async function withDraft(draft: { baseVersion: string | null; text: string; clientId?: string; baseText?: string }, live: string[] = []) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'server' }, 'o');
    const fake = fakeApi(vault);
    const deps = sessionDeps(fake.api, { liveDraftOwners: async () => new Set(live) });
    await deps.drafts.put({ path: 'a.md', clientId: draft.clientId ?? 'crashed-tab-1', eol: 'lf', at: Date.now(), ...draft });
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    return { vault, deps, session };
  }

  it('restores a draft based on the server version as a dirty buffer', async () => {
    const vault = new MockVault(false);
    const v = vault.createFile({ path: 'x.md', content: 'server' }, 'o').file.version;
    const { deps, session } = await withDraft({ baseVersion: v, text: 'server plus draft' });
    expect(text(session)).toBe('server plus draft');
    expect(status(session)).toBe('dirty');
    expect(deps.notices).toContain('Restored unsaved changes');
    expect(deps.drafts.forPath('a.md').map((d) => d.clientId)).toEqual(['tab-a-000001']);
  });

  it('drops a stale draft whose text equals the server content', async () => {
    const { deps, session } = await withDraft({ baseVersion: 'old0000000000000000000000000000000000000', text: 'server' });
    expect(status(session)).toBe('clean');
    expect(deps.drafts.forPath('a.md')).toHaveLength(0);
  });

  it('a draft on another base enters conflict with the draft as mine', async () => {
    const { session } = await withDraft({ baseVersion: 'old0000000000000000000000000000000000000', text: 'mine', baseText: 'base' });
    expect(status(session)).toBe('conflict');
    expect(text(session)).toBe('mine');
    expect(session.getSnapshot().conflict).toMatchObject({ theirsText: 'server', baseText: 'base', source: 'draft' });
  });

  it('leaves drafts owned by a live tab alone', async () => {
    const { deps, session } = await withDraft({ baseVersion: null, text: 'other tab', clientId: 'live-tab-01' }, ['live-tab-01']);
    expect(status(session)).toBe('clean');
    expect(deps.drafts.forPath('a.md')).toHaveLength(1);
  });
});

describe('DocumentRegistry', () => {
  function registry(vault: MockVault, fake: ReturnType<typeof fakeApi>, drafts = new MemoryDraftStore()) {
    return new DocumentRegistry({
      api: fake.api,
      drafts,
      moves: new MoveMap(),
      clientId: 'tab-a-000001',
      queryClient: null,
      tabs: null,
      treeEntry: (path) => vault.getTree().files.find((f) => f.path === path),
      notify: () => {},
      onDraftWrite: () => {},
      onSummary: () => {},
      onSessionMoved: () => {},
      caughtUp: () => true,
    });
  }

  it('flushes on release', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'x' }, 'o');
    const fake = fakeApi(vault);
    const docs = registry(vault, fake);
    const s = docs.acquire('a.md', 'view-1');
    await s.ready;
    type(s, '!');
    docs.release(s, 'view-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    expect(vault.readFile('a.md').content).toBe('x!');
  });

  it('open, close, remote change, reopen shows the new text without a conflict', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'v1' }, 'o');
    const fake = fakeApi(vault);
    const docs = registry(vault, fake);
    const s = docs.acquire('a.md', 'view-1');
    await s.ready;
    docs.release(s, 'view-1');
    vault.externalWrite('a.md', 'v2 from the phone');
    const again = docs.acquire('a.md', 'view-2');
    expect(again).toBe(s);
    await vi.advanceTimersByTimeAsync(0);
    expect(text(again)).toBe('v2 from the phone');
    expect(status(again)).toBe('clean');
  });

  it('shares the keepalive budget across sessions, smallest first', async () => {
    const vault = new MockVault(false);
    for (const p of ['s.md', 'm.md', 'l.md']) vault.createFile({ path: p, content: '' }, 'o');
    const fake = fakeApi(vault);
    const docs = registry(vault, fake);
    const sizes: Record<string, number> = { 's.md': 10_000, 'm.md': 30_000, 'l.md': 40_000 };
    for (const [p, n] of Object.entries(sizes)) {
      const s = docs.acquire(p, 'v');
      await s.ready;
      type(s, 'x'.repeat(n));
    }
    docs.keepaliveAll();
    const sent = fake.api.saveFile.mock.calls.filter((c) => c[2]?.keepalive).map((c) => c[0]);
    expect(sent).toEqual(['s.md', 'm.md']);
    const bytes = fake.api.saveFile.mock.calls.reduce((n, c) => n + JSON.stringify({ content: (c[1] as SaveFileRequest).content, baseVersion: (c[1] as SaveFileRequest).baseVersion }).length, 0);
    expect(bytes).toBeLessThanOrEqual(KEEPALIVE_BUDGET);
  });
});

describe('DocumentSession with CRLF files', () => {
  async function crlfSession(content: string) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'w.md', content }, 'o');
    const fake = fakeApi(vault);
    const session = new DocumentSession('w.md', sessionDeps(fake.api));
    await session.ready;
    return { vault, session };
  }

  it('edits LF text and saves CRLF', async () => {
    const { vault, session } = await crlfSession('# T\r\n\r\n- [ ] a\r\n');
    expect(text(session)).toBe('# T\n\n- [ ] a\n');
    expect(session.getSnapshot().eol).toBe('crlf');
    const change = toggleTaskAtLine(text(session), 2, lineHash('- [ ] a'))!;
    session.applyEdit(change);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('w.md').content).toBe('# T\r\n\r\n- [x] a\r\n');
  });

  it('applies a remote CRLF update on the right characters', async () => {
    const { vault, session } = await crlfSession('one\r\ntwo\r\n');
    vault.externalWrite('w.md', 'one\r\nTWO\r\nthree\r\n');
    await session.onRemoteChanged({ version: versionOf(vault, 'w.md') });
    expect(text(session)).toBe('one\nTWO\nthree\n');
    type(session, 'four\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('w.md').content).toBe('one\r\nTWO\r\nthree\r\nfour\r\n');
  });

  it('converts a mention at server offsets into a link', async () => {
    const server = 'Mention Plan here\r\nand Plan again\r\n';
    const { vault, session } = await crlfSession(server);
    const from = server.indexOf('Plan', 10);
    const docFrom = serverToDocOffset(text(session), from, 'crlf');
    const docTo = serverToDocOffset(text(session), from + 4, 'crlf');
    expect(text(session).slice(docFrom, docTo)).toBe('Plan');
    session.applyEdit({ from: docFrom, to: docTo, insert: '[[Plan]]' });
    await session.flush();
    expect(vault.readFile('w.md').content).toBe('Mention Plan here\r\nand [[Plan]] again\r\n');
  });
});

describe('DocumentSession tombstones', () => {
  it('returns to clean when the deleted file comes back with the same content (trash restore)', async () => {
    const { vault, session } = setup('kept');
    await session.ready;
    const version = versionOf(vault, 'a.md');
    const trash = vault.deleteFile('a.md', 'other-device-1');
    session.onRemoteDeleted(trash.id);
    expect(status(session)).toBe('deleted');
    vault.restoreTrash(trash.id, undefined, 'other-device-1');
    await session.onRemoteChanged({ version });
    expect(status(session)).toBe('clean');
    expect(session.getSnapshot().deleted).toBeNull();
  });

  it('a restore of a dirty tombstone saves the unsaved edits on top', async () => {
    const { vault, session } = setup('kept');
    await session.ready;
    const trash = vault.deleteFile('a.md', 'other-device-1');
    type(session, ' more');
    session.onRemoteDeleted(trash.id);
    expect(session.getSnapshot().deleted).toEqual({ trashId: trash.id, hasLocalEdits: true });
    vault.restoreTrash(trash.id, undefined, 'other-device-1');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(status(session)).toBe('dirty');
    await vi.advanceTimersByTimeAsync(0);
    await session.flush();
    expect(vault.readFile('a.md').content).toBe('kept more');
  });

  it('Discard keeps a tombstone, stores mine, and Undo brings it back as an unsaved edit', async () => {
    const { vault, deps, session } = setup('kept');
    await session.ready;
    type(session, ' mine');
    vault.externalDelete('a.md');
    session.onRemoteDeleted(null);
    await session.discardLocal();
    expect(text(session)).toBe('kept');
    expect(session.getSnapshot().deleted).toEqual({ trashId: null, hasLocalEdits: false });
    expect(session.hasUnsavedChanges()).toBe(false);
    expect(deps.drafts.discarded.map((d) => d.text)).toEqual(['kept mine']);
    expect(deps.notices.at(-1)).toMatch(/Discarded/);
  });

  it('quiet remote changes (own moves and restores) apply without a notice', async () => {
    const { vault, deps, session } = setup('one');
    await session.ready;
    vault.externalWrite('a.md', 'two');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') }, { quiet: true });
    expect(text(session)).toBe('two');
    expect(deps.notices).toEqual([]);
  });
});

// ---------- review regressions (fe-sync) ----------

function registryFor(vault: MockVault, fake: ReturnType<typeof fakeApi>, opts: { drafts?: MemoryDraftStore; moves?: MoveMap; notify?: (m: string) => void } = {}) {
  return new DocumentRegistry({
    api: fake.api,
    drafts: opts.drafts ?? new MemoryDraftStore(),
    moves: opts.moves ?? new MoveMap(),
    clientId: 'tab-a-000001',
    queryClient: null,
    tabs: null,
    treeEntry: (path) => vault.getTree().files.find((f) => f.path === path),
    notify: (n) => opts.notify?.(n.message),
    onDraftWrite: () => {},
    onSummary: () => {},
    onSessionMoved: () => {},
    caughtUp: () => true,
  });
}

describe('a note that failed to load (FE-1)', () => {
  function failingFirstRead(content = 'the full note text') {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content }, 'other-device-1');
    const fake = fakeApi(vault);
    fake.api.readFile.mockImplementationOnce(async () => {
      throw new TransientError('Failed to fetch');
    });
    return { vault, fake };
  }

  it('reads the file on a remote change instead of entering conflict with an empty mine', async () => {
    const { vault, fake } = failingFirstRead();
    const session = new DocumentSession('a.md', sessionDeps(fake.api));
    await session.ready;
    expect(session.getSnapshot()).toMatchObject({ status: 'error', loaded: false });
    expect(session.isEditable()).toBe(false);
    expect(session.hasUnsavedChanges()).toBe(false);
    vault.externalWrite('a.md', 'the full note, edited on the desktop');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    await session.whenSettled();
    expect(status(session)).toBe('clean');
    expect(session.getSnapshot().conflict).toBeNull();
    expect(text(session)).toBe('the full note, edited on the desktop');
    await session.keepMine();
    expect(vault.readFile('a.md').content).toBe('the full note, edited on the desktop');
  });

  it('a remote delete leaves no tombstone with "unsaved changes" that Recreate would empty', async () => {
    const { vault, fake } = failingFirstRead();
    const session = new DocumentSession('a.md', sessionDeps(fake.api));
    await session.ready;
    vault.externalDelete('a.md');
    session.onRemoteDeleted(null);
    expect(session.getSnapshot().deleted).toBeNull();
    expect(session.hasUnsavedChanges()).toBe(false);
    await session.recreate();
    expect(fake.api.saveFile).not.toHaveBeenCalled();
  });

  it('retries a transient load failure with backoff', async () => {
    const { fake } = failingFirstRead('hello');
    const session = new DocumentSession('a.md', sessionDeps(fake.api));
    await session.ready;
    expect(session.getSnapshot().retryAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    await session.whenSettled();
    expect(session.getSnapshot()).toMatchObject({ status: 'clean', loaded: true, retryAt: null });
    expect(text(session)).toBe('hello');
  });

  it('is not counted as unsaved by the registry', async () => {
    const { vault, fake } = failingFirstRead();
    const docs = registryFor(vault, fake);
    const s = docs.acquire('a.md', 'view');
    await s.ready;
    expect(status(s)).toBe('error');
    expect(docs.anyUnsaved()).toBe(false);
  });
});

describe('saves racing a move (FE-2)', () => {
  it('a 409 for the old path after the session was already re-keyed retries at the new path', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    const release = fake.holdSaves();
    type(session, ' world');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('saving');
    vault.move({ from: 'a.md', to: 'b.md' }, 'other-device-1');
    session.onRemoteMoved('b.md');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.path).toBe('b.md');
    expect(status(session)).toBe('clean');
    expect(session.getSnapshot().deleted).toBeNull();
    expect(vault.readFile('b.md').content).toBe('hello world');
  });

  it('a 200 for the old path processed after the move never re-keys the session back', async () => {
    const { vault, fake } = setup();
    const rekeys: string[] = [];
    const session = new DocumentSession(
      'a.md',
      sessionDeps(fake.api, {
        onRekey: (s, from) => {
          rekeys.push(`${from}->${s.path}`);
          return true;
        },
      }),
    );
    await session.ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.api.saveFile.mockImplementationOnce(async (path: string, req: SaveFileRequest) => {
      const result: WriteResult = vault.saveFile(path, req, 'me-0000001');
      await gate;
      return structuredClone(result);
    });
    type(session, ' world');
    await vi.advanceTimersByTimeAsync(1000);
    vault.move({ from: 'a.md', to: 'b.md' }, 'other-device-1');
    session.onRemoteMoved('b.md');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(rekeys).toEqual(['a.md->b.md']);
    expect(session.path).toBe('b.md');
    expect(status(session)).toBe('clean');
    expect(session.currentVersion).toBe(versionOf(vault, 'b.md'));
  });
});

describe('a stale move entry for a re-created path (FE-4)', () => {
  async function scenario(recordClientMove: boolean) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Untitled.md', content: 'foo body' }, 'me');
    const fake = fakeApi(vault);
    const drafts = new MemoryDraftStore();
    const moves = new MoveMap();
    const docs = registryFor(vault, fake, { drafts, moves });
    // Untitled.md becomes Foo.md, which is open with unsaved typing.
    vault.move({ from: 'Untitled.md', to: 'Foo.md' }, 'me');
    if (recordClientMove) moves.record('Untitled.md', 'Foo.md', 'file');
    const foo = docs.acquire('Foo.md', 'view-foo');
    await foo.ready;
    const release = fake.holdSaves();
    type(foo, ' + unsaved foo edits');
    await vi.advanceTimersByTimeAsync(600);
    // The next new note is Untitled.md again.
    vault.createFile({ path: 'Untitled.md', content: '' }, 'me');
    moves.created('Untitled.md');
    const un = docs.acquire('Untitled.md', 'view-new');
    await un.ready;
    type(un, 'second note text');
    // Another device deletes the new note before its save goes out.
    vault.externalDelete('Untitled.md');
    release();
    await vi.advanceTimersByTimeAsync(400);
    return { vault, docs, drafts, foo, un };
  }

  it.each([
    ['the client map and the server both remember the old move', true],
    ['only the server remembers it', false],
  ])('%s: the save never lands on the other note', async (_name, recordClientMove) => {
    const { vault, docs, drafts, foo, un } = await scenario(recordClientMove);
    await vi.advanceTimersByTimeAsync(1000);
    expect(un.path).toBe('Untitled.md');
    expect(un.getSnapshot()).toMatchObject({ status: 'deleted', deleted: { hasLocalEdits: true } });
    expect(foo.isDisposed).toBe(false);
    expect(docs.get('Foo.md')).toBe(foo);
    expect(vault.readFile('Foo.md').content).toBe('foo body + unsaved foo edits');
    expect(drafts.forPath('Untitled.md').map((d) => d.text)).toEqual(['second note text']);
  });

  it('a 409 move never replaces a session holding unsaved text at the destination', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'A' }, 'o');
    vault.createFile({ path: 'b.md', content: 'B' }, 'o');
    const fake = fakeApi(vault);
    const moves = new MoveMap();
    const docs = registryFor(vault, fake, { moves });
    const b = docs.acquire('b.md', 'vb');
    await b.ready;
    const a = docs.acquire('a.md', 'va');
    await a.ready;
    // A stale entry says a.md went to b.md; a.md is gone without a move.
    moves.record('a.md', 'b.md', 'file');
    vault.externalDelete('a.md');
    const release = fake.holdSaves();
    type(b, ' unsaved');
    type(a, ' mine');
    await vi.advanceTimersByTimeAsync(1000);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(a.path).toBe('a.md');
    expect(status(a)).toBe('deleted');
    expect(b.isDisposed).toBe(false);
  });
});

describe('a save refused as too large (FE-5)', () => {
  function tooLarge() {
    return problem({ code: 'too-large', status: 413, limit: 5 });
  }

  it('keeps the text editable and unsaved, never replaces it silently', async () => {
    const { vault, fake, deps, session } = setup('hello');
    await session.ready;
    fake.failNext(() => {
      throw tooLarge();
    });
    type(session, ' BIG');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot()).toMatchObject({ status: 'error', tooLarge: true });
    expect(session.isEditable()).toBe(true);
    expect(session.hasUnsavedChanges()).toBe(true);
    // A remote change does not overwrite text the server never had.
    vault.externalWrite('a.md', 'hello from phone');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(status(session)).toBe('conflict');
    expect(text(session)).toBe('hello BIG');
    await session.takeTheirs();
    expect(deps.drafts.discarded.map((d) => d.text)).toEqual(['hello BIG']);
  });

  it('saves again once the text is shorter, and Discard my changes returns to the server copy', async () => {
    const { vault, fake, deps, session } = setup('hello');
    await session.ready;
    fake.failNext(() => {
      throw tooLarge();
    });
    type(session, ' BIG');
    await vi.advanceTimersByTimeAsync(1000);
    // Trimming re-arms autosave.
    session.applyEdit({ from: 6, to: 9, insert: '' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('clean');
    expect(vault.readFile('a.md').content).toBe('hello ');
    fake.failNext(() => {
      throw tooLarge();
    });
    type(session, 'HUGE');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('error');
    await session.discardUnsaved();
    expect(status(session)).toBe('clean');
    expect(text(session)).toBe('hello ');
    expect(deps.drafts.discarded.map((d) => d.text)).toEqual(['hello HUGE']);
  });
});

describe('conflict intent survives a reload (FE-6)', () => {
  it('a draft written after a blocked Keep mine restores as a conflict, never as a plain edit', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'base' }, 'o');
    const fake = fakeApi(vault);
    const deps = sessionDeps(fake.api);
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    type(session, ' mine');
    vault.externalWrite('a.md', 'base theirs');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    fake.failNext(() => {
      throw problem({ code: 'history-unavailable', status: 503, reason: 'commit-failed' });
    });
    await session.keepMine();
    expect(session.getSnapshot().conflict?.historyBlocked).toBe(true);
    type(session, '!');
    await vi.advanceTimersByTimeAsync(600);
    const draft = deps.drafts.forPath('a.md')[0];
    expect(draft).toMatchObject({ text: 'base mine!', baseVersion: versionOf(vault, 'a.md'), conflict: true });
    // The tab dies; a new one opens the note.
    const next = new DocumentSession('a.md', { ...sessionDeps(fake.api), clientId: 'tab-b-000002', drafts: deps.drafts });
    await next.ready;
    await vi.advanceTimersByTimeAsync(5000);
    expect(status(next)).toBe('conflict');
    expect(text(next)).toBe('base mine!');
    expect(vault.readFile('a.md').content).toBe('base theirs');
  });

  it('keepalive saves carry flushHistory while a Keep mine is pending', async () => {
    const { vault, fake, session } = setup('base');
    await session.ready;
    type(session, ' mine');
    vault.externalWrite('a.md', 'theirs');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    fake.failNext(() => {
      throw new TransientError('Failed to fetch');
    });
    await session.keepMine();
    expect(status(session)).toBe('offline');
    session.keepaliveSave(KEEPALIVE_BUDGET);
    expect(fake.api.saveFile.mock.calls.at(-1)![1]).toMatchObject({ flushHistory: true });
  });

  it('Save merged writes the merged text to the draft before saving', async () => {
    const { vault, fake, deps, session } = setup('base');
    await session.ready;
    type(session, ' mine');
    vault.externalWrite('a.md', 'base theirs');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    fake.failNext(() => {
      throw new TransientError('Failed to fetch');
    });
    await session.saveMerged('MERGED TEXT');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.drafts.forPath('a.md')[0]).toMatchObject({ text: 'MERGED TEXT', conflict: true });
  });
});

describe('restoring text into a note (FE-7)', () => {
  it('waits for the reload of a reopened note, and reports when nothing landed', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'server text' }, 'o');
    const fake = fakeApi(vault);
    fake.api.readFile.mockImplementationOnce(async () => {
      throw new TransientError('Failed to fetch');
    });
    const docs = registryFor(vault, fake);
    const s = docs.acquire('a.md', 'view');
    await s.ready;
    docs.release(s, 'view');
    // Settings › This device › Restore into note reopens it.
    const again = docs.acquire('a.md', 'settings-restore');
    expect(status(again)).toBe('loading');
    expect(await again.restoreText('discarded text')).toBe(true);
    expect(text(again)).toBe('discarded text');

    const offline = new MockVault(false);
    offline.createFile({ path: 'b.md', content: 'x' }, 'o');
    const failing = fakeApi(offline);
    failing.api.readFile.mockImplementation(async () => {
      throw new TransientError('Failed to fetch');
    });
    const b = new DocumentSession('b.md', sessionDeps(failing.api));
    await b.ready;
    expect(await b.restoreText('discarded text')).toBe(false);
  });
});

describe('remote updates during an IME composition (FE-9)', () => {
  function mount(session: DocumentSession) {
    const view = new EditorView({
      state: session.prepareState((st) =>
        st.update({
          effects: StateEffect.reconfigure.of([
            history(),
            EditorView.updateListener.of((u) => {
              if (u.transactions.some(isLocalEdit)) session.markDirty();
            }),
          ]),
        }).state,
      ),
    });
    session.attach(view);
    (view as unknown as { inputState: { composing: number } }).inputState.composing = 1;
    return view;
  }

  it('a view destroyed while the update waits keeps no stale text under the new version', async () => {
    const { vault, session } = setup('v1 text');
    await session.ready;
    const view = mount(session);
    vault.externalWrite('a.md', 'v2 text from the phone');
    const done = session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    await vi.advanceTimersByTimeAsync(0);
    // Navigation: the editor goes away within the 300 ms wait.
    session.detach(view);
    view.destroy();
    await vi.advanceTimersByTimeAsync(400);
    await done;
    expect(text(session)).toBe('v2 text from the phone');
    expect(session.currentVersion).toBe(versionOf(vault, 'a.md'));
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('a.md').content).toBe('v2 text from the phone!');
  });

  it('text typed while the update waits is kept, as a conflict', async () => {
    const { vault, session } = setup('v1 text');
    await session.ready;
    const view = mount(session);
    vault.externalWrite('a.md', 'v2 text from the phone');
    const done = session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    await vi.advanceTimersByTimeAsync(0);
    view.dispatch({ changes: { from: 7, insert: ' typed' }, userEvent: 'input.type' });
    await vi.advanceTimersByTimeAsync(400);
    await done;
    expect(status(session)).toBe('conflict');
    expect(text(session)).toBe('v1 text typed');
    view.destroy();
  });
});

describe('Take theirs line endings (FE-14)', () => {
  it('adopts the line-ending style of theirs', async () => {
    const { vault, session } = setup('l1\nl2\n');
    await session.ready;
    type(session, 'mine');
    vault.externalWrite('a.md', 'l1\r\nl2\r\ntheirs\r\n');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    await session.takeTheirs();
    expect(session.getSnapshot().eol).toBe('crlf');
    type(session, 'x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('a.md').content).toBe('l1\r\nl2\r\ntheirs\r\nx');
  });
});

describe('deletions racing loads and saves (FE-16)', () => {
  it('a delete that arrives while the note loads leaves a tombstone', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'x' }, 'o');
    const fake = fakeApi(vault);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.api.readFile.mockImplementationOnce(async (path: string) => {
      const file = structuredClone(vault.readFile(path));
      await gate;
      return file;
    });
    const session = new DocumentSession('a.md', sessionDeps(fake.api));
    const trash = vault.deleteFile('a.md', 'other-device-1');
    session.onRemoteDeleted(trash.id);
    release();
    await session.ready;
    expect(session.getSnapshot()).toMatchObject({ status: 'deleted', deleted: { trashId: trash.id } });
  });

  it('a delete followed by a restore during a save ends on the restored file', async () => {
    const { vault, fake, session } = setup('kept');
    await session.ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.api.saveFile.mockImplementationOnce(async (path: string, req: SaveFileRequest) => {
      const result: WriteResult = vault.saveFile(path, req, 'me-0000001');
      await gate;
      return structuredClone(result);
    });
    type(session, ' more');
    await vi.advanceTimersByTimeAsync(1000);
    const trash = vault.deleteFile('a.md', 'other-device-1');
    session.onRemoteDeleted(trash.id);
    vault.restoreTrash(trash.id, undefined, 'other-device-1');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe('clean');
    expect(session.getSnapshot().deleted).toBeNull();
  });
});

describe('views that keep their own model (markDirty(serialize), DESIGN §6.8)', () => {
  /** A stand-in for a drawing: the view's model is a string the session never sees directly. */
  function modelView(session: DocumentSession, initial: string) {
    const view = { model: initial, applied: session.remoteChangeCount };
    session.subscribe(() => {
      if (session.remoteChangeCount === view.applied) return;
      view.applied = session.remoteChangeCount;
      view.model = session.editorState.doc.toString();
    });
    return {
      view,
      edit(next: string) {
        view.model = next;
        session.markDirty(() => view.model);
      },
    };
  }

  it('serializes only when saving, and text the session put into its buffer wins until the next edit', async () => {
    const { vault, fake, session } = setup('one');
    await session.ready;
    const { view, edit } = modelView(session, 'one');
    const serialize = vi.fn(() => view.model);
    view.model = 'one two';
    session.markDirty(serialize);
    session.markDirty(serialize);
    expect(serialize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(serialize).toHaveBeenCalled();
    expect(vault.readFile('a.md').content).toBe('one two');
    // A remote change: the buffer holds theirs; the old serializer must not shadow it.
    vault.externalWrite('a.md', 'theirs');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(session.getText()).toBe('theirs');
    expect(view.model).toBe('theirs');
    edit('theirs!');
    expect(session.getText()).toBe('theirs!');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('a.md').content).toBe('theirs!');
    expect(fake.api.saveFile).toHaveBeenCalledTimes(2);
  });

  it('counts every text the session puts into its buffer, also one equal to the buffer', async () => {
    const { vault, session } = setup('base');
    await session.ready;
    const { edit } = modelView(session, 'base');
    const before = session.remoteChangeCount;
    edit('mine');
    await vi.advanceTimersByTimeAsync(1000);
    // Another device writes the buffer's old text back: the view must still hear about it.
    vault.externalWrite('a.md', 'base');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(session.remoteChangeCount).toBeGreaterThan(before);
    expect(session.getText()).toBe('base');
  });

  it('a save refused as too large retries once the serialized text is shorter', async () => {
    const { vault, fake, session } = setup('x');
    await session.ready;
    const { edit } = modelView(session, 'x');
    fake.failNext(() => {
      throw problem({ code: 'too-large', status: 413, limit: 5 });
    });
    edit('x'.repeat(100));
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().tooLarge).toBe(true);
    edit('x'.repeat(50));
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('a.md').content).toBe('x'.repeat(50));
  });

  it('an edit from outside the view applies to its serialized text, which the view then re-reads', async () => {
    const { vault, session } = setup('one');
    await session.ready;
    const { view, edit } = modelView(session, 'one');
    edit('one two');
    await vi.advanceTimersByTimeAsync(1000);
    // The buffer still holds "one"; a mention linked at its offsets in the text.
    session.applyEdit({ from: 4, to: 7, insert: '[[two]]' });
    expect(session.getText()).toBe('one [[two]]');
    expect(view.model).toBe('one [[two]]');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('a.md').content).toBe('one [[two]]');
    // A restored text lands even though the view edited before (its serializer is gone).
    edit('one [[two]] three');
    expect(await session.restoreText('restored')).toBe(true);
    expect(view.model).toBe('restored');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vault.readFile('a.md').content).toBe('restored');
  });

  it('counts uploads of views without editor widgets as unsaved work', async () => {
    const { session } = setup();
    await session.ready;
    let release!: (v: string) => void;
    const upload = session.trackUpload(new Promise<string>((r) => (release = r)));
    expect(session.uploadsInFlight).toBe(1);
    release('done');
    await expect(upload).resolves.toBe('done');
    expect(session.uploadsInFlight).toBe(0);
    await expect(session.trackUpload(Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(session.uploadsInFlight).toBe(0);
  });
});

describe('semantic merge of a view (DESIGN §6.8)', () => {
  /** Merges line sets: theirs, plus the lines mine added; gives up on a line saying CONFLICT. */
  const lineMerge = (base: string, mine: string, theirs: string): string | null => {
    if (mine.includes('CONFLICT') || theirs.includes('CONFLICT')) return null;
    const b = new Set(base.split('\n'));
    const t = theirs.split('\n');
    return [...t, ...mine.split('\n').filter((l) => !b.has(l) && !t.includes(l))].join('\n');
  };

  function mergeSetup(content = 'a\nb') {
    const vault = new MockVault(false);
    vault.createFile({ path: 'd.json', content }, 'other-device-1');
    const fake = fakeApi(vault);
    const deps = sessionDeps(fake.api, { mergeFor: (path) => (path === 'd.json' ? lineMerge : undefined) });
    const session = new DocumentSession('d.json', deps);
    return { vault, fake, deps, session };
  }

  it('merges a remote change into unsaved edits without the banner, saving with flushHistory', async () => {
    const { vault, fake, deps, session } = mergeSetup();
    await session.ready;
    type(session, '\nmine');
    vault.externalWrite('d.json', 'a\nb\ntheirs');
    await session.onRemoteChanged({ version: versionOf(vault, 'd.json') });
    expect(status(session)).toBe('dirty');
    expect(session.getSnapshot().conflict).toBeNull();
    expect(text(session)).toBe('a\nb\ntheirs\nmine');
    expect(deps.notices).toContain('Merged changes from another device');
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe('clean');
    expect(vault.readFile('d.json').content).toBe('a\nb\ntheirs\nmine');
    expect(fake.api.saveFile.mock.calls.at(-1)![1] as SaveFileRequest).toMatchObject({ flushHistory: true });
  });

  it('merges when a save meets a newer version (409)', async () => {
    const { vault, session } = mergeSetup();
    await session.ready;
    vault.externalWrite('d.json', 'a\nb\ntheirs');
    type(session, '\nmine');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('clean');
    expect(vault.readFile('d.json').content).toBe('a\nb\ntheirs\nmine');
  });

  it('a merge that gives up shows the banner as before', async () => {
    const { vault, session } = mergeSetup();
    await session.ready;
    type(session, '\nmine');
    vault.externalWrite('d.json', 'CONFLICT');
    await session.onRemoteChanged({ version: versionOf(vault, 'd.json') });
    expect(status(session)).toBe('conflict');
    expect(session.getSnapshot().conflict).toMatchObject({ theirsText: 'CONFLICT', source: 'remote' });
    expect(text(session)).toBe('a\nb\nmine');
  });

  it('a merge equal to theirs adopts theirs without saving', async () => {
    const { vault, fake, session } = mergeSetup();
    await session.ready;
    type(session, '\nsame');
    vault.externalWrite('d.json', 'a\nb\nsame\nmore');
    await session.onRemoteChanged({ version: versionOf(vault, 'd.json') });
    expect(status(session)).toBe('clean');
    expect(session.currentVersion).toBe(versionOf(vault, 'd.json'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.api.saveFile).not.toHaveBeenCalled();
  });

  it('a draft from an earlier visit on another base is merged too', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'd.json', content: 'a\nb\ntheirs' }, 'o');
    const deps = sessionDeps(fakeApi(vault).api, { mergeFor: () => lineMerge });
    await deps.drafts.put({ path: 'd.json', clientId: 'crashed-tab-1', eol: 'lf', at: Date.now(), baseVersion: 'old0000000000000000000000000000000000000', baseText: 'a\nb', text: 'a\nb\nmine' });
    const session = new DocumentSession('d.json', deps);
    await session.ready;
    expect(session.getSnapshot().conflict).toBeNull();
    expect(text(session)).toBe('a\nb\ntheirs\nmine');
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.readFile('d.json').content).toBe('a\nb\ntheirs\nmine');
  });

  it('notes without a merge keep the banner', async () => {
    const { vault, session } = setup('hello');
    await session.ready;
    type(session, ' mine');
    vault.externalWrite('a.md', 'theirs');
    await session.onRemoteChanged({ version: versionOf(vault, 'a.md') });
    expect(status(session)).toBe('conflict');
  });
});
