import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { BookmarksUpdateRequest, FileEntry } from '../../api/types';
import { registerBuiltins } from '../../extensions/builtins';
import { bookmarkWriter } from '../../features/bookmarkStore';
import { setNavigator } from '../../features/navigation';
import { basenameOf, extensionOf, lastSegment } from '../../features/paths';
import { recentPaths, recordOpened } from '../../features/recent';
import RecentPanel from './RecentPanel';

function entry(path: string): FileEntry {
  return { path, name: lastSegment(path), basename: basenameOf(path), extension: extensionOf(path), kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] };
}

const navigate = vi.fn();

function renderPanel() {
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [{ path: 'Projects', name: 'Projects' }], files: ['Welcome.md', 'Projects/Plan.md'].map(entry) });
  queryClient.setQueryData(queryKeys.bookmarks(), { version: 'v1', items: [{ type: 'file', ctime: 1, path: 'Welcome.md' }] });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RecentPanel activePath="Projects/Plan.md" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const names = () => [...document.querySelectorAll('.recent-row .tree-name')].map((n) => n.textContent);

beforeEach(() => {
  registerBuiltins();
  queryClient.clear();
  navigate.mockReset();
  setNavigator(navigate);
});

afterEach(async () => {
  await bookmarkWriter.idle();
  vi.restoreAllMocks();
});

describe('RecentPanel', () => {
  it('lists the files opened on this device that are still in the vault, newest first', () => {
    const now = Date.now();
    recordOpened('Welcome.md', now - 3 * 3600_000);
    recordOpened('Gone.md', now - 2 * 3600_000);
    recordOpened('Projects/Plan.md', now - 60_000);
    renderPanel();
    expect(names()).toEqual(['Plan', 'Welcome']);
    expect(document.querySelector('.recent-row.is-active .tree-name')).toHaveTextContent('Plan');
    expect(document.querySelector('.recent-row .recent-folder')).toHaveTextContent('Projects');
    expect(screen.getByLabelText('Bookmarked')).toBeInTheDocument();
  });

  it('opens a file, and updates when another file is opened', () => {
    recordOpened('Welcome.md', 1);
    renderPanel();
    fireEvent.click(screen.getByTitle(/^Welcome\.md/));
    expect(navigate).toHaveBeenLastCalledWith('/n/Welcome.md', undefined);
    act(() => recordOpened('Projects/Plan.md'));
    expect(names()).toEqual(['Plan', 'Welcome']);
  });

  it('removes a file from the list, and bookmarks one, from the row menu', async () => {
    const put = vi.spyOn(api, 'putBookmarks').mockImplementation(async (req: BookmarksUpdateRequest) => ({ version: 'v2', items: req.items }));
    recordOpened('Welcome.md', 1);
    recordOpened('Projects/Plan.md', 2);
    renderPanel();
    fireEvent.contextMenu(document.querySelectorAll('.recent-row')[1]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from recent files' }));
    expect(recentPaths()).toEqual(['Projects/Plan.md']);
    expect(names()).toEqual(['Plan']);
    fireEvent.contextMenu(document.querySelectorAll('.recent-row')[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bookmark' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0].items.map((i) => i.path)).toEqual(['Welcome.md', 'Projects/Plan.md']);
  });

  it('says so when nothing was opened yet', () => {
    renderPanel();
    expect(screen.getByText('No recently opened files on this device.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear recent files' })).toBeDisabled();
  });
});
