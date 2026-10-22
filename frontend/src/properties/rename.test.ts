import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyRenameRequest, PropertyRenameResult } from '../api/types';
import { useToasts } from '../state/toasts';
import { describeFailures, renameAcrossVault, type RenameDeps } from './rename';

function result(dryRun: boolean, over: Partial<PropertyRenameResult> = {}): PropertyRenameResult {
  return { dryRun, from: 'status', to: 'phase', updates: [{ path: 'a.md', version: dryRun ? null : 'v1' }], failed: [], typeMoved: false, commitId: dryRun ? null : 'c', ...over };
}

function deps(over: Partial<RenameDeps> = {}): RenameDeps & { calls: PropertyRenameRequest[] } {
  const calls: PropertyRenameRequest[] = [];
  return {
    calls,
    prompt: async () => 'phase',
    confirm: async () => true,
    flushAll: vi.fn(async () => {}),
    rename: async (req) => {
      calls.push(req);
      return result(!!req.dryRun, { failed: [{ path: 'c.md', reason: 'property-exists' }] });
    },
    apply: vi.fn(),
    ...over,
  };
}

afterEach(() => useToasts.setState({ toasts: [] } as never));

describe('renameAcrossVault', () => {
  it('saves open notes, previews, confirms, then renames and applies the result', async () => {
    const confirm = vi.fn<RenameDeps['confirm']>(async () => true);
    const d = deps({ confirm });
    const r = await renameAcrossVault('status', d);
    expect(d.calls).toEqual([{ from: 'status', to: 'phase', dryRun: true }, { from: 'status', to: 'phase' }]);
    expect(d.flushAll).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]![0].message).toMatch(/in 1 note\? 1 note keeps the old name: c \(it already has that property\)/);
    expect(d.apply).toHaveBeenCalledWith(r);
  });

  it('stops when cancelled, unchanged, or when nothing has the property', async () => {
    const same = deps({ prompt: async () => 'status' });
    expect(await renameAcrossVault('status', same)).toBeNull();
    expect(same.calls).toEqual([]);
    const declined = deps({ confirm: async () => false });
    expect(await renameAcrossVault('status', declined)).toBeNull();
    expect(declined.calls).toHaveLength(1);
    const none = deps({ rename: async () => result(true, { updates: [] }) });
    expect(await renameAcrossVault('status', none)).toBeNull();
    expect(none.apply).not.toHaveBeenCalled();
  });

  it('describes failures', () => {
    expect(describeFailures({ failed: [{ path: 'x/Y.md', reason: 'not-rewritable' }] })).toBe('Y (its properties are written in a way that cannot be changed in place)');
  });
});
