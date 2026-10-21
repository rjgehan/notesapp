import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import type { HeadingRenameRequest, HeadingRenameResult } from '../../api/types';
import { useToasts } from '../../state/toasts';
import type { DocumentSession } from '../../sync/DocumentSession';
import { SETTLE_MS, useHeadingRenameOffers } from './useHeadingRenameOffers';

/** The parts of a session the hook reads. */
class FakeSession {
  path = 'Plan.md';
  editorState: EditorState;
  private listeners = new Set<() => void>();
  private changes = 0;
  private remote = 0;

  constructor(doc: string) {
    this.editorState = EditorState.create({ doc, extensions: [markdown()] });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getChangeCount = () => this.changes;
  getRemoteChangeCount = () => this.remote;
  getSnapshot = () => ({ loaded: true, status: 'clean' });

  edit(doc: string, remote = false): void {
    this.editorState = EditorState.create({ doc, extensions: [markdown()] });
    this.changes++;
    if (remote) this.remote++;
    for (const l of this.listeners) l();
  }
}

function response(req: HeadingRenameRequest, links: number): HeadingRenameResult {
  return { dryRun: !!req.dryRun, path: req.path, from: req.from, to: req.to, linkUpdates: links ? [{ path: 'Notes.md', links, version: req.dryRun ? null : 'v2' }] : [], failed: [], bookmarks: 0, commitId: null };
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useHeadingRenameOffers', () => {
  it('offers to update the links when a linked heading is renamed by typing, and updates them on request', async () => {
    const calls: HeadingRenameRequest[] = [];
    vi.spyOn(api, 'renameHeading').mockImplementation(async (req) => {
      calls.push(req);
      return response(req, 2);
    });
    const session = new FakeSession('# Plan\n## Goals\n');
    renderHook(() => useHeadingRenameOffers(session as unknown as DocumentSession, true));
    await settle();
    act(() => session.edit('# Plan\n## Aims\n'));
    await settle();
    expect(calls).toEqual([{ path: 'Plan.md', from: 'Goals', to: 'Aims', dryRun: true }]);
    const offer = useToasts.getState().toasts.at(-1)!;
    expect(offer.message).toBe('Heading renamed to “Aims”. Update 2 links in 1 note that pointed at “Goals”?');
    await act(async () => {
      offer.action!.run();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.at(-1)).toEqual({ path: 'Plan.md', from: 'Goals', to: 'Aims' });
  });

  it('accepts a rename nothing points at, and never treats a change from the server as a rename', async () => {
    const spy = vi.spyOn(api, 'renameHeading').mockImplementation(async (req) => response(req, 0));
    const session = new FakeSession('## Goals\n');
    renderHook(() => useHeadingRenameOffers(session as unknown as DocumentSession, true));
    await settle();
    act(() => session.edit('## Aims\n'));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toEqual([]);
    act(() => session.edit('## Other\n', true));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing while inactive (reading view)', async () => {
    const spy = vi.spyOn(api, 'renameHeading');
    const session = new FakeSession('## Goals\n');
    renderHook(() => useHeadingRenameOffers(session as unknown as DocumentSession, false));
    act(() => session.edit('## Aims\n'));
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });
});
