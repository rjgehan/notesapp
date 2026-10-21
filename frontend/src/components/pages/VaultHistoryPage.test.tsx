import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { ChangesResponse, DeletedFilesResponse, FileEntry, TimelineResponse } from '../../api/types';
import { setNavigator } from '../../features/navigation';
import { Dialogs } from '../overlays/Dialogs';
import VaultHistoryPage from './VaultHistoryPage';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

const LOG: TimelineResponse = {
  hasMore: false,
  entries: [
    {
      commitId: C2,
      shortId: 'bbbbbbb',
      parentCommitId: C1,
      time: '2026-10-21T14:00:00.000Z',
      authorName: 'Alice',
      authorLogin: 'alice@github',
      message: 'Delete Old.md',
      files: [{ path: 'Old.md', change: 'deleted', renamedFrom: null }],
      filesTotal: 1,
    },
    {
      commitId: C1,
      shortId: 'aaaaaaa',
      parentCommitId: null,
      time: '2026-10-21T10:00:00.000Z',
      authorName: 'Alice',
      authorLogin: 'alice@github',
      message: 'Import existing vault (120 files)',
      files: [{ path: 'Plan.md', change: 'added', renamedFrom: null }],
      filesTotal: 120,
    },
  ],
};

const CHANGES: ChangesResponse = {
  since: '2026-10-19T00:00:00.000Z',
  until: null,
  fromCommitId: null,
  toCommitId: C2,
  commits: 2,
  authors: ['Alice'],
  files: [{ path: 'Plan.md', change: 'added', renamedFrom: null }],
  truncated: false,
};

const DELETED: DeletedFilesResponse = {
  total: 1,
  hasMore: false,
  entries: [
    {
      path: 'Old.md',
      deletedAt: '2026-10-21T14:00:00.000Z',
      commitId: C2,
      shortId: 'bbbbbbb',
      parentCommitId: C1,
      authorName: 'Alice',
      authorLogin: 'alice@github',
      message: 'Delete Old.md',
    },
  ],
};

const restored: FileEntry = {
  path: 'Old.md',
  name: 'Old.md',
  basename: 'Old',
  extension: 'md',
  kind: 'note',
  size: 4,
  mtime: '2026-10-21T15:00:00.000Z',
  version: 'v'.repeat(40),
  aliases: [],
};

beforeEach(() => {
  setNavigator(vi.fn());
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [{ ...restored, path: 'Plan.md', name: 'Plan.md', basename: 'Plan' }] });
  vi.spyOn(api, 'getHistoryLog').mockResolvedValue(LOG);
  vi.spyOn(api, 'getHistoryChanges').mockResolvedValue(CHANGES);
  vi.spyOn(api, 'getDeletedFiles').mockResolvedValue(DELETED);
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <VaultHistoryPage />
        <Dialogs />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VaultHistoryPage', () => {
  it('lists commits with their files, and filters by author', async () => {
    renderPage();
    expect(await screen.findByText('Delete Old.md')).toBeInTheDocument();
    expect(screen.getByText('and 119 more')).toBeInTheDocument();
    expect(screen.getByText('deleted')).toBeInTheDocument();
    // Plan.md exists now: it can be opened.
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Filter by author'), { target: { value: 'alice' } });
    await waitFor(() => expect(api.getHistoryLog).toHaveBeenLastCalledWith({ author: 'alice', path: undefined, since: undefined }, { limit: 50, offset: 0 }));
  });

  it('summarizes the changes of a period', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(await screen.findByText(/This week: 1 file changed in 2 commits by Alice/)).toBeInTheDocument();
    expect(api.getHistoryChanges).toHaveBeenCalledWith(expect.objectContaining({ since: expect.any(String) }));
  });

  it('restores a deleted file from git', async () => {
    const restore = vi.spyOn(api, 'restoreHistory').mockResolvedValue({ file: restored, created: true, createdFolders: [], commitId: C2 });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Deleted files' }));
    fireEvent.click(await screen.findByRole('button', { name: /Restore/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ path: 'Old.md', commit: C1, sourcePath: 'Old.md', baseVersion: null }));
  });
});
