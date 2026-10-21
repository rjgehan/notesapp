import { describe, expect, it, vi } from 'vitest';
import { TransientError } from '../api/client';
import { MockVault } from '../api/mock/vault';
import type { SaveFileRequest } from '../api/types';
import type { DraftRecord } from '../sync/drafts';
import { MemoryDraftStore } from '../test/fakes';
import { replayOrphanDrafts, type DraftReplayDeps } from './draftReplay';

const ME = 'tab-now-0001';
const DEAD = 'tab-dead-001';

function setup(files: Record<string, string> = { 'a.md': 'server text' }) {
  const vault = new MockVault(false);
  for (const [path, content] of Object.entries(files)) vault.createFile({ path, content }, 'other-device-1');
  const drafts = new MemoryDraftStore();
  const saved: string[] = [];
  const deps: DraftReplayDeps & { saveFile: ReturnType<typeof vi.fn> } = {
    drafts,
    clientId: ME,
    liveOwners: async () => new Set<string>(),
    treeEntry: (path) => vault.getTree().files.find((f) => f.path === path),
    hasSession: () => false,
    readFile: vi.fn(async (path: string) => structuredClone(vault.readFile(path))),
    saveFile: vi.fn(async (path: string, req: SaveFileRequest) => structuredClone(vault.saveFile(path, req, ME))),
    onSaved: (result) => saved.push(result.file.path),
  };
  const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
    path: 'a.md',
    clientId: DEAD,
    baseVersion: vault.readFile('a.md').version,
    text: 'edited offline',
    eol: 'lf',
    at: 1000,
    ...over,
  });
  return { vault, drafts, deps, saved, draft };
}

describe('replaying edits made offline in closed tabs', () => {
  it('saves a draft whose base is still the server version, with that base', async () => {
    const { vault, drafts, deps, saved, draft } = setup();
    const base = vault.readFile('a.md').version;
    await drafts.put(draft());
    const report = await replayOrphanDrafts(deps);
    expect(report).toEqual({ synced: ['a.md'], review: [], interrupted: false });
    expect(deps.saveFile).toHaveBeenCalledWith('a.md', { content: 'edited offline', baseVersion: base });
    expect(vault.readFile('a.md').content).toBe('edited offline');
    expect(saved).toEqual(['a.md']);
    expect(drafts.drafts.size).toBe(0);
  });

  it('keeps CRLF notes CRLF', async () => {
    const { vault, drafts, deps, draft } = setup({ 'a.md': 'one\r\ntwo\r\n' });
    await drafts.put(draft({ text: 'one\ntwo\nthree\n', eol: 'crlf' }));
    await replayOrphanDrafts(deps);
    expect(vault.readFile('a.md').content).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('never overwrites a note that changed since the draft’s base: it is listed for review and the draft stays', async () => {
    const { vault, drafts, deps, draft } = setup();
    await drafts.put(draft());
    vault.externalWrite('a.md', 'changed on the PC');
    const report = await replayOrphanDrafts(deps);
    expect(report.review).toEqual(['a.md']);
    expect(report.synced).toEqual([]);
    expect(deps.saveFile).not.toHaveBeenCalled();
    expect(vault.readFile('a.md').content).toBe('changed on the PC');
    expect(drafts.forPath('a.md')).toHaveLength(1);
  });

  it('a save that loses a race (409) is listed for review, not retried', async () => {
    const { vault, drafts, deps, draft } = setup();
    await drafts.put(draft());
    // The tree still shows the old version; the server has moved on.
    const stale = deps.treeEntry('a.md')!;
    vault.externalWrite('a.md', 'changed meanwhile');
    deps.treeEntry = () => stale;
    const report = await replayOrphanDrafts(deps);
    expect(deps.saveFile).toHaveBeenCalledTimes(1);
    expect(report.review).toEqual(['a.md']);
    expect(vault.readFile('a.md').content).toBe('changed meanwhile');
    expect(drafts.forPath('a.md')).toHaveLength(1);
  });

  it('drops a draft whose text is already on the server (its save went through)', async () => {
    const { vault, drafts, deps, draft } = setup();
    await drafts.put(draft({ baseVersion: 'stale-version', text: 'server text' }));
    const report = await replayOrphanDrafts(deps);
    expect(report).toEqual({ synced: [], review: [], interrupted: false });
    expect(drafts.drafts.size).toBe(0);
    expect(vault.readFile('a.md').content).toBe('server text');
  });

  it('leaves a pending Keep mine to the conflict banner', async () => {
    const { drafts, deps, draft } = setup();
    await drafts.put(draft({ conflict: true }));
    const report = await replayOrphanDrafts(deps);
    expect(report.review).toEqual(['a.md']);
    expect(deps.saveFile).not.toHaveBeenCalled();
  });

  it('stops at the first transient failure and keeps everything', async () => {
    const { drafts, deps, draft, vault } = setup({ 'a.md': 'x', 'b.md': 'y' });
    await drafts.put(draft());
    await drafts.put(draft({ path: 'b.md', baseVersion: vault.readFile('b.md').version }));
    deps.saveFile.mockRejectedValue(new TransientError('offline'));
    const report = await replayOrphanDrafts(deps);
    expect(report.interrupted).toBe(true);
    expect(deps.saveFile).toHaveBeenCalledTimes(1);
    expect(drafts.drafts.size).toBe(2);
  });

  it('skips drafts of live tabs, of this tab, of open notes and of paths that are gone', async () => {
    const { drafts, deps, draft } = setup({ 'a.md': 'x', 'open.md': 'y' });
    await drafts.put(draft({ clientId: 'tab-live-001' }));
    await drafts.put(draft({ clientId: ME, text: 'mine' }));
    await drafts.put(draft({ path: 'open.md' }));
    await drafts.put(draft({ path: 'deleted.md' }));
    deps.liveOwners = async (path) => new Set(path === 'a.md' ? ['tab-live-001'] : []);
    deps.hasSession = (path) => path === 'open.md';
    const report = await replayOrphanDrafts(deps);
    expect(report).toEqual({ synced: [], review: [], interrupted: false });
    expect(deps.saveFile).not.toHaveBeenCalled();
    expect(drafts.drafts.size).toBe(4);
  });

  it('saves the newest draft and keeps older ones recoverable instead of restoring them later', async () => {
    const { vault, drafts, deps, draft } = setup();
    await drafts.put(draft({ clientId: 'tab-old-0001', text: 'older', at: 500 }));
    await drafts.put(draft({ text: 'newest', at: 900 }));
    await replayOrphanDrafts(deps);
    expect(vault.readFile('a.md').content).toBe('newest');
    expect(drafts.drafts.size).toBe(0);
    expect(drafts.discarded).toMatchObject([{ path: 'a.md', text: 'older', reason: 'superseded-draft' }]);
  });
});
