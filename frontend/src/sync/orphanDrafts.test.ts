import { describe, expect, it } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { MemoryDraftStore } from '../test/fakes';
import { DRAFT_MAX_AGE_MS, type DraftRecord } from './drafts';
import { findOrphanDrafts } from './orphanDrafts';

const draft = (over: Partial<DraftRecord>): DraftRecord => ({
  path: 'a.md',
  clientId: 'dead-tab-1',
  baseVersion: null,
  text: 'unsaved text',
  eol: 'lf',
  at: Date.now(),
  ...over,
});

function filesOf(vault: MockVault) {
  return new Map(vault.getTree().files.map((f) => [f.path, f]));
}

describe('findOrphanDrafts (FE-3, DESIGN §6.9)', () => {
  it('finds the draft of a note whose folder was renamed while no tab was open, and where it went', async () => {
    const vault = new MockVault(false);
    const base = vault.createFile({ path: 'Projects/Plan.md', content: 'plan' }, 'o').file.version;
    const drafts = new MemoryDraftStore();
    // The phone edited offline and iOS killed the tab.
    await drafts.put(draft({ path: 'Projects/Plan.md', baseVersion: base, text: 'plan + offline edits' }));
    // The desktop renames the folder.
    vault.move({ from: 'Projects', to: 'Work' }, 'desktop');
    const found = await findOrphanDrafts({ drafts, clientId: 'new-tab-1', files: filesOf(vault), liveOwners: async () => new Set() });
    expect(found).toEqual([expect.objectContaining({ path: 'Projects/Plan.md', text: 'plan + offline edits', likelyPath: 'Work/Plan.md' })]);
  });

  it('finds the draft of a deleted note (no likely path)', async () => {
    const vault = new MockVault(false);
    const base = vault.createFile({ path: 'Gone.md', content: 'x' }, 'o').file.version;
    const drafts = new MemoryDraftStore();
    await drafts.put(draft({ path: 'Gone.md', baseVersion: base }));
    vault.externalDelete('Gone.md');
    const found = await findOrphanDrafts({ drafts, clientId: 'new-tab-1', files: filesOf(vault), liveOwners: async () => new Set() });
    expect(found.map((d) => [d.path, d.likelyPath])).toEqual([['Gone.md', null]]);
  });

  it('ignores drafts of existing notes, of this tab, of live tabs, and expired ones', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Here.md', content: 'x' }, 'o');
    const drafts = new MemoryDraftStore();
    await drafts.put(draft({ path: 'Here.md' }));
    await drafts.put(draft({ path: 'Mine.md', clientId: 'new-tab-1' }));
    await drafts.put(draft({ path: 'Live.md', clientId: 'live-tab-1' }));
    await drafts.put(draft({ path: 'Old.md', at: Date.now() - DRAFT_MAX_AGE_MS - 1 }));
    const found = await findOrphanDrafts({
      drafts,
      clientId: 'new-tab-1',
      files: filesOf(vault),
      liveOwners: async (p) => new Set(p === 'Live.md' ? ['live-tab-1'] : []),
    });
    expect(found).toEqual([]);
  });
});
