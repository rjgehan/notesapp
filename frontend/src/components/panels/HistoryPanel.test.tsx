import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import type { HistoryResponse } from '../../api/types';
import HistoryPanel from './HistoryPanel';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

function renderPanel(path: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <HistoryPanel activePath={path} />
    </QueryClientProvider>,
  );
}

const STOPPED: HistoryResponse['entries'][number] = {
  commitId: 'c'.repeat(40),
  shortId: 'ccccccc',
  parentCommitId: 'a'.repeat(40),
  path: 'Attachments/Holiday.mp4',
  time: '2026-10-17T10:00:00.000Z',
  authorName: 'Owner',
  authorLogin: 'owner@notes',
  message: 'Stop versioning Attachments/Holiday.mp4 (larger than 25 MB)',
  change: 'deleted',
  renamedFrom: null,
};

describe('HistoryPanel and the large-file policy (DESIGN §6.11)', () => {
  it('explains why a large file has no history instead of saying there is none yet', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({
      path: 'Attachments/Holiday.mp4',
      pending: false,
      hasMore: false,
      entries: [],
      excluded: { reason: 'large-file', size: 80 * 1024 * 1024, limitBytes: 25 * 1024 * 1024 },
    });
    renderPanel('Attachments/Holiday.mp4');
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('This file is 80.0 MB, larger than the 25 MB limit for history');
    expect(note).toHaveTextContent('stays in the vault and in backups');
    expect(screen.queryByText('No history for this file yet.')).not.toBeInTheDocument();
  });

  it('still lists the versions from before the file grew past the limit', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({
      path: 'Attachments/Holiday.mp4',
      pending: false,
      hasMore: false,
      entries: [STOPPED, { ...STOPPED, commitId: 'a'.repeat(40), message: 'Create Attachments/Holiday.mp4', change: 'added', parentCommitId: null }],
      excluded: { reason: 'large-file', size: 30 * 1024 * 1024, limitBytes: 25 * 1024 * 1024 },
    });
    renderPanel('Attachments/Holiday.mp4');
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.getByText('Stop versioning Attachments/Holiday.mp4 (larger than 25 MB)')).toBeInTheDocument();
    expect(screen.getByText('Create Attachments/Holiday.mp4')).toBeInTheDocument();
  });

  it('shows no note for an ordinary file', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ path: 'Plan.md', pending: false, hasMore: false, entries: [], excluded: null });
    renderPanel('Plan.md');
    expect(await screen.findByText('No history for this file yet.')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
