import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { BookmarkItem, BookmarksUpdateRequest, FileEntry, TreeResponse } from '../../api/types';
import { registerBuiltins } from '../../extensions/builtins';
import { bookmarkWriter } from '../../features/bookmarkStore';
import { setNavigator } from '../../features/navigation';
import { basenameOf, extensionOf, folderOf, lastSegment } from '../../features/paths';
import { useToasts } from '../../state/toasts';
import { useUi } from '../../state/ui';
import BookmarksPanel from './BookmarksPanel';

function entry(path: string): FileEntry {
  return { path, name: lastSegment(path), basename: basenameOf(path), extension: extensionOf(path), kind: extensionOf(path) === 'md' ? 'note' : 'other', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] };
}

function tree(paths: string[]): TreeResponse {
  const folders = new Set<string>();
  for (const p of paths) for (let f = folderOf(p); f; f = folderOf(f)) folders.add(f);
  return { eventId: 'b.1', folders: [...folders].sort().map((path) => ({ path, name: lastSegment(path) })), files: paths.map(entry) };
}

const ITEMS: BookmarkItem[] = [
  { type: 'file', ctime: 1, path: 'Projects/Plan.md' },
  { type: 'file', ctime: 2, path: 'projects/plan.md', subpath: '#Goals' },
  { type: 'folder', ctime: 3, path: 'Projects' },
  { type: 'search', ctime: 4, query: 'tag:#work' },
  { type: 'group', ctime: 5, title: 'Reading', items: [{ type: 'file', ctime: 6, path: 'Books/Dune.md' }] },
  { type: 'file', ctime: 7, path: 'Gone.md' },
];

const navigate = vi.fn();

function renderPanel(items: BookmarkItem[] = ITEMS, activePath: string | null = 'Projects/Plan.md') {
  queryClient.setQueryData(queryKeys.tree(), tree(['Projects/Plan.md', 'Books/Dune.md', 'Welcome.md']));
  queryClient.setQueryData(queryKeys.bookmarks(), { version: 'v1', items });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BookmarksPanel activePath={activePath} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getAllByRole('treeitem').find((r) => r.querySelector('.tree-name')?.textContent === name)!;
const labels = () => screen.getAllByRole('treeitem').map((r) => r.querySelector('.tree-name')?.textContent);

beforeEach(() => {
  registerBuiltins();
  queryClient.clear();
  navigate.mockReset();
  setNavigator(navigate);
  useUi.setState({ searchQuery: '', leftTab: 'bookmarks', expanded: {} });
  useToasts.setState({ toasts: [] });
});

afterEach(async () => {
  await bookmarkWriter.idle();
  vi.restoreAllMocks();
});

describe('BookmarksPanel', () => {
  it('lists files, headings, folders, searches and groups, and dims a missing target', () => {
    renderPanel();
    expect(labels()).toEqual(['Plan', 'Goals', 'Projects', 'tag:#work', 'Reading', 'Dune', 'Gone']);
    expect(row('Plan')).toHaveAttribute('aria-current', 'page');
    expect(row('Goals')).not.toHaveAttribute('aria-current');
    expect(row('Goals').querySelector('.bookmark-detail')).toHaveTextContent('plan');
    expect(row('Reading')).toHaveAttribute('aria-expanded', 'true');
    expect(row('Dune')).toHaveAttribute('aria-level', '2');
    expect(row('Gone')).toHaveClass('is-missing');
    expect(row('Plan')).not.toHaveClass('is-missing');
  });

  it('opens a file, a heading (matched ignoring case) and a search', () => {
    renderPanel();
    fireEvent.click(row('Plan'));
    expect(navigate).toHaveBeenLastCalledWith('/n/Projects/Plan.md', undefined);
    fireEvent.click(row('Goals'));
    expect(navigate).toHaveBeenLastCalledWith('/n/Projects/Plan.md#Goals', undefined);
    fireEvent.click(row('tag:#work'));
    expect(useUi.getState().searchQuery).toBe('tag:#work');
    expect(useUi.getState().leftTab).toBe('search');
  });

  it('offers to remove a bookmark whose target is gone', async () => {
    const put = vi.spyOn(api, 'putBookmarks').mockImplementation(async (req: BookmarksUpdateRequest) => ({ version: 'v2', items: req.items }));
    renderPanel();
    fireEvent.click(row('Gone'));
    expect(navigate).not.toHaveBeenCalled();
    const toast = useToasts.getState().toasts.at(-1)!;
    expect(toast.message).toContain('is not in the vault');
    act(() => toast.action!.run());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0].items.map((i) => i.path ?? i.title ?? i.query)).not.toContain('Gone.md');
  });

  it('collapses a group and remembers it on this device', () => {
    renderPanel();
    fireEvent.click(row('Reading'));
    expect(labels()).not.toContain('Dune');
    expect(row('Reading')).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem('notesapp:bookmarkGroupsCollapsed')!)).toEqual(['5:Reading']);
  });

  it('removes a bookmark from its menu and saves the list with its version', async () => {
    const put = vi.spyOn(api, 'putBookmarks').mockImplementation(async (req: BookmarksUpdateRequest) => ({ version: 'v2', items: req.items }));
    renderPanel();
    fireEvent.contextMenu(row('Projects'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove bookmark' }));
    expect(labels()).not.toContain('Projects');
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0].baseVersion).toBe('v1');
    expect(put.mock.calls[0][0].items).toHaveLength(ITEMS.length - 1);
    await bookmarkWriter.idle();
    expect(queryClient.getQueryData(queryKeys.bookmarks())).toMatchObject({ version: 'v2' });
  });

  it('moves a bookmark into a group from its menu', async () => {
    const put = vi.spyOn(api, 'putBookmarks').mockImplementation(async (req: BookmarksUpdateRequest) => ({ version: 'v2', items: req.items }));
    renderPanel();
    fireEvent.contextMenu(row('tag:#work'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to “Reading”' }));
    expect(labels()).toEqual(['Plan', 'Goals', 'Projects', 'Reading', 'Dune', 'tag:#work', 'Gone']);
    await waitFor(() => expect(put).toHaveBeenCalled());
  });

  it('bookmarks a file dropped from the explorer', async () => {
    const put = vi.spyOn(api, 'putBookmarks').mockImplementation(async (req: BookmarksUpdateRequest) => ({ version: 'v2', items: req.items }));
    renderPanel([]);
    expect(screen.getByText(/No bookmarks yet/)).toBeInTheDocument();
    const data = new Map([['application/x-notesapp-path', 'Welcome.md']]);
    const dataTransfer = { types: [...data.keys()], getData: (t: string) => data.get(t) ?? '', dropEffect: 'none' };
    fireEvent.drop(document.querySelector('.bookmarks')!, { dataTransfer });
    expect(labels()).toEqual(['Welcome']);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][0].items[0]).toMatchObject({ type: 'file', path: 'Welcome.md' });
  });
});
