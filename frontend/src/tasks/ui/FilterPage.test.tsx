import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { Task, TasksResponse } from '../../api/types';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import FilterPage from './FilterPage';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';

const home = makeList();
const work = makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks' });
const tasks = [
  makeTask({ id: 'A', title: 'Mow the lawn #garden', priority: 1 }),
  makeTask({ id: 'B', title: 'Pay rent', tags: ['bills'], priority: 3, due: '2026-11-01' }),
  makeTask({ id: 'C', title: 'Report', listId: 'L2', priority: 3, tags: ['work/q4'] }),
  makeTask({ id: 'D', title: 'Filed taxes', priority: 3, status: 'done', completedAt: '2026-10-01T00:00:00.000Z' }),
];

/** The server's list view by status and list; the tag and priority filters are left to the page. */
function serve(all: Task[] = tasks) {
  return vi.spyOn(taskApi, 'query').mockImplementation(async (q): Promise<TasksResponse> => {
    const shown = all.filter((t) => (q.status === 'all' || t.status === 'open') && (!q.list || t.listId === q.list));
    return { view: 'list', lists: [home, work], tasks: shown, total: shown.length, problems: [] };
  });
}

const where = { current: '' };
function Where() {
  const l = useLocation();
  useEffect(() => {
    where.current = l.pathname + l.search;
  });
  return null;
}

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  queryClient.setQueryData(queryKeys.tags(), { tags: [{ tag: 'garden', count: 1, total: 1 }, { tag: 'reading', count: 2, total: 2 }] });
});

afterEach(() => queryClient.clear());

const page = (path = '/x/tasks/filter') =>
  renderWithApp(
    <>
      <FilterPage />
      <Where />
    </>,
    { path },
  );

describe('Filter page (ROADMAP item 4)', () => {
  it('shows the open tasks of every active list, grouped by list', async () => {
    const query = serve();
    page();
    await screen.findByText('Report');
    expect(query).toHaveBeenCalledWith({ view: 'list' });
    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual([expect.stringContaining('Home'), expect.stringContaining('Work')]);
    expect(screen.queryByText('Filed taxes')).not.toBeInTheDocument();
  });

  it('filters by priority and tag, kept in the address', async () => {
    const query = serve();
    page();
    await screen.findByText('Report');
    fireEvent.click(screen.getByRole('button', { name: /High/ }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith({ view: 'list', priority: '3' }));
    expect(where.current).toBe('/x/tasks/filter?priority=3');
    expect(screen.queryByText(/Mow the lawn/)).not.toBeInTheDocument();
    expect(screen.getByText('Pay rent')).toBeInTheDocument();
    const tag = screen.getByPlaceholderText('#tag');
    fireEvent.change(tag, { target: { value: '#work' } });
    fireEvent.keyDown(tag, { key: 'Enter' });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith({ view: 'list', tag: 'work', priority: '3' }));
    // Nested tags match: #work/q4.
    expect(screen.getByText('Report')).toBeInTheDocument();
    expect(screen.queryByText('Pay rent')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    await waitFor(() => expect(where.current).toBe('/x/tasks/filter'));
  });

  it('opens a filter from the address, by list and with closed tasks', async () => {
    const query = serve();
    page('/x/tasks/filter?list=L1&status=all&priority=3');
    await screen.findByText('Filed taxes');
    expect(query).toHaveBeenCalledWith({ view: 'list', list: 'L1', priority: '3', status: 'all' });
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('L1');
    expect(screen.queryByText('Report')).not.toBeInTheDocument();
    expect(document.querySelector('datalist option[value="#reading"]')).not.toBeNull();
  });
});
