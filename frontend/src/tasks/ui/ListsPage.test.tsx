import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { Dialogs } from '../../components/overlays/Dialogs';
import { useDialogs } from '../../state/dialogs';
import { taskApi } from '../api';
import { addDays, localToday } from '../dates';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import ListsPage from './ListsPage';
import { TaskOverlays } from './TaskOverlays';
import { renderWithApp } from './renderWithApp';

const today = localToday();
const home = makeList();
const work = makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks', writable: false });
const old = makeList({ id: 'L3', name: 'Old', order: 'a2', path: 'Tasks/Old.tasks', archived: true });

beforeEach(() => {
  taskStore.reset();
  useDialogs.setState({ stack: [] });
  vi.spyOn(taskApi, 'query').mockResolvedValue({
    view: 'list',
    lists: [home, work, old],
    tasks: [makeTask({ id: 'A', due: addDays(today, -1) }), makeTask({ id: 'B', due: today }), makeTask({ id: 'C' }), makeTask({ id: 'D', listId: 'L2' })],
    total: 4,
    problems: [],
  });
});

afterEach(() => queryClient.clear());

describe('task list index', () => {
  it('lists the active lists with open and overdue counts, and archived ones on request', async () => {
    renderWithApp(<ListsPage />);
    const lists = await screen.findByRole('list', { name: 'Lists' });
    const rows = within(lists).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.tasks-list-name')?.textContent)).toEqual(['Home', 'Work']);
    expect(rows[0].querySelector('.tasks-count')?.textContent).toBe('3');
    expect(rows[0].querySelector('.tasks-badge.tone-overdue')?.textContent).toBe('1');
    expect(within(rows[1]).getByText('read-only')).toBeInTheDocument();
    // Today counts the overdue task and today's.
    const todayRow = screen.getAllByRole('button', { name: /^Today/ }).find((b) => b.classList.contains('tasks-list-link'));
    expect(todayRow?.querySelector('.tasks-count')?.textContent).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Show archived lists (1)' }));
    expect(within(screen.getByRole('list', { name: 'Archived lists' })).getByText('Old')).toBeInTheDocument();
  });

  it('creates a list from its name', async () => {
    const created = makeList({ id: 'L9', name: 'Garden', order: 'a5', path: 'Tasks/Garden.tasks' });
    const createList = vi.spyOn(taskApi, 'createList').mockResolvedValue({ lists: [created], files: [], createdFolders: [], moved: null, trash: null });
    renderWithApp(
      <>
        <ListsPage />
        <Dialogs />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /New list/ }));
    const input = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'Garden' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(createList).toHaveBeenCalledWith({ name: 'Garden' }, expect.any(String)));
    await waitFor(() => expect(taskStore.list('L9')?.name).toBe('Garden'));
  });

  it('archives a list from its menu, with the name it had as base', async () => {
    const updateList = vi.spyOn(taskApi, 'updateList').mockResolvedValue({ lists: [{ ...home, archived: true }], files: [], createdFolders: [], moved: null, trash: null });
    renderWithApp(<ListsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Home' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(updateList).toHaveBeenCalledWith('L1', { changes: { archived: true }, base: { archived: false } }, expect.any(String)));
  });

  it('sets a list’s color from its menu', async () => {
    const updateList = vi.spyOn(taskApi, 'updateList').mockResolvedValue({ lists: [{ ...home, color: '#2f9e44' }], files: [], createdFolders: [], moved: null, trash: null });
    renderWithApp(
      <>
        <ListsPage />
        <TaskOverlays />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'More for Home' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Color…' }));
    const colors = await screen.findByRole('radiogroup', { name: 'Color' });
    expect(within(colors).getByRole('radio', { name: 'No color' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(colors).getByRole('radio', { name: 'Green' }));
    await waitFor(() => expect(updateList).toHaveBeenCalledWith('L1', { changes: { color: '#2f9e44' }, base: { color: null } }, expect.any(String)));
    await waitFor(() => expect(taskStore.list('L1')?.color).toBe('#2f9e44'));
    expect(screen.queryByRole('radiogroup', { name: 'Color' })).not.toBeInTheDocument();
    const dot = within(screen.getByRole('list', { name: 'Lists' })).getAllByRole('listitem')[0].querySelector('.task-list-dot') as HTMLElement;
    expect(dot.style.background).toBe('rgb(47, 158, 68)');
  });
});
