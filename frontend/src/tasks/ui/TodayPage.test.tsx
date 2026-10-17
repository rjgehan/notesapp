import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import type { Task, TaskWriteResult } from '../../api/types';
import { taskApi } from '../api';
import { addDays, localToday } from '../dates';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';
import TodayPage from './TodayPage';

const today = localToday();
const home = makeList();
const work = makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks', color: '#2f9e44' });

function serve(tasks: Task[]) {
  return vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'today', lists: [home, work], tasks, total: tasks.length, problems: [] });
}

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
});

afterEach(() => queryClient.clear());

describe('Today page (ROADMAP item 4)', () => {
  it('groups overdue tasks before today’s, in the server’s order', async () => {
    const query = serve([
      makeTask({ id: 'O', title: 'Overdue report', due: addDays(today, -2), listId: 'L2' }),
      makeTask({ id: 'T', title: 'Call the plumber', due: `${today}T09:00` }),
      makeTask({ id: 'S', title: 'Start the essay', start: today, due: addDays(today, 5), priority: 3 }),
    ]);
    renderWithApp(<TodayPage />);
    const overdue = await screen.findByRole('region', { name: /Overdue/ });
    expect(query).toHaveBeenCalledWith({ view: 'today', date: today });
    expect(within(overdue).getByText('Overdue report')).toBeInTheDocument();
    expect(within(overdue).getByText('Work')).toBeInTheDocument();
    const todays = screen.getByRole('region', { name: /^Today/ });
    expect(within(todays).getAllByRole('listitem').map((li) => li.querySelector('.task-title')?.textContent)).toEqual(['Call the plumber', 'Start the essay']);
  });

  it('checks a task off at once and keeps it gone when the server agrees', async () => {
    serve([makeTask({ id: 'T', title: 'Call the plumber', due: today })]);
    let finish!: (r: TaskWriteResult) => void;
    const complete = vi.spyOn(taskApi, 'complete').mockReturnValue(new Promise((r) => (finish = r)));
    renderWithApp(<TodayPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete “Call the plumber”' }));
    expect(screen.queryByText('Call the plumber')).not.toBeInTheDocument();
    await waitFor(() => expect(complete).toHaveBeenCalledWith('T', expect.objectContaining({ base: { due: today, start: null } }), expect.any(String)));
    finish({ task: makeTask({ id: 'T', title: 'Call the plumber', due: today, status: 'done' }), changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [] });
    await waitFor(() => expect(screen.getByText('Nothing for today')).toBeInTheDocument());
  });

  it('brings a task back when completing it fails', async () => {
    serve([makeTask({ id: 'T', title: 'Call the plumber', due: today })]);
    vi.spyOn(taskApi, 'complete').mockRejectedValue(new Error('boom'));
    renderWithApp(<TodayPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete “Call the plumber”' }));
    expect(await screen.findByText('Call the plumber')).toBeInTheDocument();
  });

  it('opens quick add with today as the date, and the details of a task', async () => {
    serve([makeTask({ id: 'T', title: 'Call the plumber', due: today })]);
    renderWithApp(<TodayPage />);
    fireEvent.click(await screen.findByText('Call the plumber'));
    expect(useTaskUi.getState().detailId).toBe('T');
    fireEvent.click(screen.getAllByRole('button', { name: /Add task/ })[0]);
    expect(useTaskUi.getState().quickAdd).toEqual({ due: today });
  });

  it('shows files the server could not read', async () => {
    vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'today', lists: [home], tasks: [], total: 0, problems: [{ path: 'Tasks/Broken.tasks', taskId: null, reason: 'not valid JSON (line 1, column 3)' }] });
    renderWithApp(<TodayPage />);
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(screen.getByText('Nothing for today')).toBeInTheDocument();
  });
});
