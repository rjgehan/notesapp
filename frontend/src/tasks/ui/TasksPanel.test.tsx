import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import type { FileEntry, TreeResponse } from '../../api/types';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';
import TasksPanel from './TasksPanel';

function file(path: string, kind: FileEntry['kind'] = 'note'): FileEntry {
  const name = path.split('/').pop()!;
  return { path, name, basename: name.replace(/\.[^.]+$/, ''), extension: name.split('.').pop()!, kind, size: 1, mtime: '2026-10-17T10:00:00.000Z', version: 'v', aliases: [] };
}

const tree: TreeResponse = { eventId: 'b.1', folders: [{ path: 'Tasks', name: 'Tasks' }], files: [file('Apartment.md'), file('Other.md'), file('Tasks/Home.tasks', 'text'), file('Tasks/Work.tasks', 'text')] };
const home = makeList();
const work = makeList({ id: 'L2', name: 'Work', path: 'Tasks/Work.tasks', order: 'a1' });

beforeEach(() => {
  taskStore.reset();
  queryClient.setQueryData(['tree'], tree);
  useTaskUi.setState({ quickAdd: null, detailId: null });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [home, work], problems: [] });
});

afterEach(() => queryClient.clear());

describe('Tasks linking to this note (registerPanel)', () => {
  it('lists the tasks that link to the note, loading only the lists that do', async () => {
    vi.spyOn(api, 'getBacklinks').mockResolvedValue({ path: 'Apartment.md', linked: [{ source: 'Tasks/Home.tasks', sourceVersion: 'v', mentions: [] }], unlinked: null });
    const query = vi.spyOn(taskApi, 'query').mockResolvedValue({
      view: 'list',
      lists: [home, work],
      tasks: [
        makeTask({ id: 'A', title: 'Pay rent [[Apartment]]' }),
        makeTask({ id: 'B', title: 'Fix the tap', links: ['Apartment.md'] }),
        makeTask({ id: 'C', title: 'Unrelated' }),
        makeTask({ id: 'D', title: 'Old [[Apartment]]', status: 'done', completedAt: '2026-10-01T00:00:00.000Z' }),
      ],
      total: 4,
      problems: [],
    });
    renderWithApp(<TasksPanel activePath="Apartment.md" />);
    expect(await screen.findByText('Fix the tap')).toBeInTheDocument();
    expect(screen.getByText('Pay rent')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated')).not.toBeInTheDocument();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ view: 'list', list: 'L1', status: 'all' });
    fireEvent.click(screen.getByRole('button', { name: 'Show completed (1)' }));
    expect(screen.getByText('Old')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add task for this note/ }));
    expect(useTaskUi.getState().quickAdd).toEqual({ links: ['Apartment.md'] });
  });

  it('costs no task request for a note nothing links to', async () => {
    vi.spyOn(api, 'getBacklinks').mockResolvedValue({ path: 'Other.md', linked: [], unlinked: null });
    const query = vi.spyOn(taskApi, 'query');
    renderWithApp(<TasksPanel activePath="Other.md" />);
    expect(await screen.findByText('No tasks link to this note.')).toBeInTheDocument();
    await waitFor(() => expect(taskApi.lists).toHaveBeenCalled());
    expect(query).not.toHaveBeenCalled();
  });

  it('asks for a note when none is open', () => {
    renderWithApp(<TasksPanel activePath={null} />);
    expect(screen.getByText(/Open a note/)).toBeInTheDocument();
  });
});
