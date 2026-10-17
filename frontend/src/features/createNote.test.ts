import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEndpoints } from '../api/endpoints';
import { createMockEndpoints } from '../api/mock';
import { MockVault } from '../api/mock/vault';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import { updatePendingTitle, usePendingNote } from '../state/pendingNote';
import { newDrawingContent } from '../views/excalidraw/format';
import { createNote } from './fileOps';
import { setNavigator } from './navigation';

let vault: MockVault;
let routes: string[];

beforeEach(() => {
  vault = new MockVault(false);
  installEndpoints(createMockEndpoints(vault, { latency: 0, failures: [] }));
  queryClient.setQueryData(queryKeys.tree(), vault.getTree());
  routes = [];
  setNavigator((to) => routes.push(to));
  usePendingNote.setState({ pending: null, handoff: null });
});

afterEach(() => {
  queryClient.clear();
});

const settle = () => vi.waitFor(() => expect(vault.getTree().files.length).toBeGreaterThan(0));

describe('createNote for files without an inline title (a new drawing, DESIGN §6.8.1)', () => {
  it('opens the drawing once the pending title is committed, under that name', async () => {
    createNote('', newDrawingContent(), 'excalidraw');
    const id = usePendingNote.getState().pending!.id;
    await settle();
    expect(vault.getTree().files.map((f) => f.path)).toEqual(['Untitled.excalidraw']);
    // Created, but the title is still being typed: nothing opens yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(routes).toEqual([]);
    updatePendingTitle(id, 'Architecture', false);
    updatePendingTitle(id, 'Architecture', true);
    await vi.waitFor(() => expect(routes).toEqual(['/n/Architecture.excalidraw']));
    expect(vault.getTree().files.map((f) => f.path)).toEqual(['Architecture.excalidraw']);
    expect(usePendingNote.getState()).toMatchObject({ pending: null, handoff: null });
  });

  it('keeps the free name when the title is committed untouched', async () => {
    createNote('', newDrawingContent(), 'excalidraw');
    const id = usePendingNote.getState().pending!.id;
    await settle();
    updatePendingTitle(id, 'Untitled', true);
    await vi.waitFor(() => expect(routes).toEqual(['/n/Untitled.excalidraw']));
  });

  it('a note still opens at once and hands its title over to the inline title', async () => {
    createNote('', '', 'md');
    const id = usePendingNote.getState().pending!.id;
    updatePendingTitle(id, 'Half typ', false);
    await vi.waitFor(() => expect(routes).toEqual(['/n/Untitled.md']));
    expect(usePendingNote.getState().handoff).toMatchObject({ path: 'Untitled.md', title: 'Half typ' });
  });
});
