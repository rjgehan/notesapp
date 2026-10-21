// Offline editing end to end at the session level (DESIGN §6.26): a note opened from the device's
// copy, edited without a connection, and saved through the ordinary version check once the
// server is back. A stale queued save always surfaces as the conflict banner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '../api/client';
import { MockVault } from '../api/mock/vault';
import type { SaveFileRequest, TextFile } from '../api/types';
import { DocumentSession } from '../sync/DocumentSession';
import { sessionDeps } from '../test/fakes';

function setup() {
  const vault = new MockVault(false);
  vault.createFile({ path: 'a.md', content: 'from the server' }, 'other-device-1');
  const copy: TextFile = structuredClone(vault.readFile('a.md'));
  let online = false;
  const offline = () => {
    if (!online) throw new TransientError('Network error');
  };
  const api = {
    readFile: vi.fn(async (path: string) => {
      offline();
      return structuredClone(vault.readFile(path));
    }),
    saveFile: vi.fn(async (path: string, req: SaveFileRequest) => {
      offline();
      return structuredClone(vault.saveFile(path, req, 'tab-a-000001'));
    }),
  };
  // The registry's loadFile: the server, else the device's copy (offlineStore.openNote).
  const loadFile = async (path: string) => {
    try {
      return await api.readFile(path);
    } catch (e) {
      if (e instanceof TransientError && path === copy.path) return structuredClone(copy);
      throw e;
    }
  };
  let caughtUp = false;
  const deps = sessionDeps(api, { loadFile, caughtUp: () => caughtUp });
  return {
    vault,
    api,
    deps,
    copy,
    goOnline() {
      online = true;
      caughtUp = true;
    },
  };
}

const type = (s: DocumentSession, insert: string) => s.applyEdit({ from: s.editorState.doc.length, insert });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('offline editing', () => {
  it('opens the device copy, queues the edit and saves it on reconnect when the server did not change', async () => {
    const { vault, api, deps, copy, goOnline } = setup();
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    expect(session.getText()).toBe('from the server');
    expect(session.currentVersion).toBe(copy.version);

    type(session, ' + offline');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().status).toBe('offline');
    // The draft is the queued save: the text and the base it applies to.
    expect(deps.drafts.forPath('a.md')).toMatchObject([{ text: 'from the server + offline', baseVersion: copy.version }]);

    goOnline();
    session.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveFile).toHaveBeenLastCalledWith('a.md', { content: 'from the server + offline', baseVersion: copy.version });
    expect(session.getSnapshot().status).toBe('clean');
    expect(vault.readFile('a.md').content).toBe('from the server + offline');
    expect(deps.drafts.forPath('a.md')).toHaveLength(0);
  });

  it('a queued save against a note changed elsewhere becomes the conflict banner, never an overwrite', async () => {
    const { vault, deps, copy, goOnline } = setup();
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    type(session, ' + offline');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().status).toBe('offline');

    vault.externalWrite('a.md', 'edited on the PC');
    goOnline();
    session.retryNow();
    await vi.advanceTimersByTimeAsync(0);

    const snap = session.getSnapshot();
    expect(snap.status).toBe('conflict');
    expect(snap.conflict).toMatchObject({ theirsText: 'edited on the PC', theirsVersion: vault.readFile('a.md').version, baseText: 'from the server', source: 'save' });
    expect(session.getText()).toBe('from the server + offline');
    expect(vault.readFile('a.md').content).toBe('edited on the PC');
    // Autosave stays paused; mine is still protected by its draft.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vault.readFile('a.md').content).toBe('edited on the PC');
    // (Its base is not the server's version, so a restore re-enters the conflict too.)
    expect(deps.drafts.forPath('a.md')).toMatchObject([{ text: 'from the server + offline', baseVersion: copy.version }]);
  });

  it('retries wait until the event stream has caught up', async () => {
    const { api, deps, goOnline } = setup();
    let caughtUp = false;
    deps.caughtUp = () => caughtUp;
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    type(session, '!');
    await vi.advanceTimersByTimeAsync(1000);
    goOnline();
    caughtUp = false;
    api.saveFile.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.saveFile).not.toHaveBeenCalled();
    caughtUp = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.saveFile).toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('clean');
  });

  it('a clean note opened from a stale copy catches up silently when revalidated online', async () => {
    const { vault, deps, copy, goOnline } = setup();
    vault.externalWrite('a.md', 'newer on the server');
    const session = new DocumentSession('a.md', deps);
    await session.ready;
    expect(session.getText()).toBe('from the server');
    goOnline();
    await session.revalidate(vault.readFile('a.md').version);
    expect(session.getText()).toBe('newer on the server');
    expect(session.getSnapshot().status).toBe('clean');
    expect(session.currentVersion).not.toBe(copy.version);
  });

  it('a note without a copy explains why it cannot open offline', async () => {
    const { deps } = setup();
    const session = new DocumentSession('b.md', deps);
    await session.ready;
    expect(session.getSnapshot().status).toBe('error');
    expect(session.getSnapshot().error).toMatch(/no offline copy/);
  });
});
