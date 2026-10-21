import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import type { Task } from '../../api/types';
import { taskApi } from '../api';
import { addDays, localToday } from '../dates';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';
import UpcomingPage from './UpcomingPage';

const today = localToday();
const home = makeList();

function serve(tasks: Task[]) {
  return vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'upcoming', lists: [home], tasks, total: tasks.length, problems: [] });
}

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => queryClient.clear());

describe('Upcoming page (ROADMAP item 4)', () => {
  it('loads the next 14 days and groups the tasks by day, in schedule order', async () => {
    const query = serve([
      makeTask({ id: 'B', title: 'Dentist', due: `${addDays(today, 2)}T09:00` }),
      makeTask({ id: 'A', title: 'Pay rent', due: addDays(today, 2), priority: 3 }),
      makeTask({ id: 'C', title: 'Call Bob', due: today }),
      makeTask({ id: 'D', title: 'Garden', start: addDays(today, 13) }),
    ]);
    renderWithApp(<UpcomingPage />);
    await screen.findByText('Dentist');
    expect(query).toHaveBeenCalledWith({ view: 'upcoming', date: today, days: 14 });
    const dayAfter = document.getElementById(`tasks-day-${addDays(today, 2)}`)!;
    expect([...dayAfter.querySelectorAll('.task-title')].map((e) => e.textContent)).toEqual(['Pay rent', 'Dentist']);
    expect(within(document.getElementById(`tasks-day-${today}`)!).getByText('Call Bob')).toBeInTheDocument();
    expect(within(document.getElementById(`tasks-day-${addDays(today, 13)}`)!).getByText('Garden')).toBeInTheDocument();
    expect(document.querySelectorAll('.tasks-day')).toHaveLength(14);
  });

  it('shows how busy each day of the week is, and jumps to a day', async () => {
    serve([makeTask({ id: 'A', title: 'Pay rent', due: addDays(today, 1) }), makeTask({ id: 'B', title: 'Bins', due: addDays(today, 1) })]);
    renderWithApp(<UpcomingPage />);
    await screen.findByText('Pay rent');
    const strip = screen.getByRole('group', { name: 'This week' });
    const tomorrow = within(strip).getByRole('button', { name: /^Tomorrow, .*: 2 tasks$/ });
    fireEvent.click(tomorrow);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(tomorrow).toHaveClass('is-selected');
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByRole('group', { name: 'Next week' })).toBeInTheDocument();
  });

  it('adds a task on a chosen day, and keeps a completed task out', async () => {
    serve([makeTask({ id: 'A', title: 'Pay rent', due: addDays(today, 3) }), makeTask({ id: 'Z', title: 'Done already', due: addDays(today, 3), status: 'done' })]);
    renderWithApp(<UpcomingPage />);
    await screen.findByText('Pay rent');
    expect(screen.queryByText('Done already')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Add task on / })[3]);
    expect(useTaskUi.getState().quickAdd).toEqual({ due: addDays(today, 3) });
  });

  it('says when nothing is scheduled', async () => {
    serve([]);
    renderWithApp(<UpcomingPage />);
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
  });
});
