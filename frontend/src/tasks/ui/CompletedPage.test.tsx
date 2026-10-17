import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import type { Task, TasksResponse, TaskWriteResult } from '../../api/types';
import { taskApi } from '../api';
import { COMPLETED_PAGE } from '../queries';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import CompletedPage from './CompletedPage';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';

const home = makeList();
const work = makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks' });
const at = (iso: string) => new Date(iso).toISOString();

function page(tasks: Task[], total = tasks.length): TasksResponse {
  return { view: 'completed', lists: [home, work], tasks, total, problems: [] };
}

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [home, work], problems: [] });
});

afterEach(() => queryClient.clear());

describe('Completed page (ROADMAP item 4)', () => {
  it('logs finished tasks newest first, by the day they were completed', async () => {
    const query = vi.spyOn(taskApi, 'query').mockResolvedValue(
      page([
        makeTask({ id: 'B', title: 'Pay rent', status: 'done', completedAt: at('2026-10-15T18:00:00') }),
        makeTask({ id: 'A', title: 'Old chore', status: 'cancelled', completedAt: at('2026-10-14T09:00:00'), listId: 'L2' }),
        makeTask({ id: 'C', title: 'Archived one', status: 'done', completedAt: at('2025-03-01T09:00:00'), archived: true }),
      ]),
    );
    renderWithApp(<CompletedPage />);
    await screen.findByText('Pay rent');
    expect(query).toHaveBeenCalledWith({ view: 'completed', limit: COMPLETED_PAGE });
    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual([
      expect.stringMatching(/October 15/),
      expect.stringMatching(/October 14/),
      expect.stringMatching(/March 1, 2025/),
    ]);
    expect(within(groups[1]).getByText('cancelled')).toBeInTheDocument();
    expect(within(groups[1]).getByText('Work')).toBeInTheDocument();
    expect(within(groups[2]).getByText('archived')).toBeInTheDocument();
    expect(screen.getByText('3 tasks completed')).toBeInTheDocument();
  });

  it('loads older tasks page by page, and narrows the log to one list', async () => {
    const query = vi
      .spyOn(taskApi, 'query')
      .mockResolvedValueOnce(page([makeTask({ id: 'B', title: 'Newest', status: 'done', completedAt: '2026-10-15T18:00:00.000Z' })], 2))
      .mockResolvedValueOnce(page([makeTask({ id: 'A', title: 'Older', status: 'done', completedAt: '2026-10-01T18:00:00.000Z' })], 1))
      .mockResolvedValue(page([], 0));
    renderWithApp(<CompletedPage />);
    await screen.findByText('Newest');
    expect(screen.queryByText('Older')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('Older')).toBeInTheDocument();
    expect(query).toHaveBeenLastCalledWith({ view: 'completed', limit: COMPLETED_PAGE, before: '2026-10-15T18:00:00.001Z' });
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox', { name: 'List' }), { target: { value: 'L2' } });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith({ list: 'L2', view: 'completed', limit: COMPLETED_PAGE }));
    expect(await screen.findByText('Nothing completed yet')).toBeInTheDocument();
  });

  it('reopens a task, which leaves the log', async () => {
    const done = makeTask({ id: 'B', title: 'Pay rent', status: 'done', completedAt: '2026-10-15T18:00:00.000Z' });
    vi.spyOn(taskApi, 'query').mockResolvedValue(page([done]));
    const reopen = vi.spyOn(taskApi, 'uncomplete').mockResolvedValue({ task: { ...done, status: 'open', completedAt: null }, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [] } satisfies TaskWriteResult);
    renderWithApp(<CompletedPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reopen “Pay rent”' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith('B', expect.any(String)));
    await waitFor(() => expect(screen.queryByText('Pay rent')).not.toBeInTheDocument());
  });
});
