import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import type { Problem, Task, TaskWriteResult, TreeResponse } from '../../api/types';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';
import TaskDetail from './TaskDetail';

function result(task: Task): TaskWriteResult {
  return { task, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [] };
}

const list = makeList();
const tree: TreeResponse = { eventId: 'b.1', folders: [], files: [] };

beforeEach(() => {
  taskStore.reset();
  taskStore.setLists([list, makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks' })], [], taskStore.generation());
  queryClient.setQueryData(['tree'], tree);
  useTaskUi.setState({ quickAdd: null, detailId: 'A' });
});

afterEach(() => queryClient.clear());

const update = () => vi.spyOn(taskApi, 'update').mockImplementation(async (id, req) => result({ ...taskStore.task(id)!, ...req.changes } as Task));

describe('task detail sheet', () => {
  it('edits fields one by one with their bases', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Pay rent', due: '2026-11-01' })]);
    const patch = update();
    renderWithApp(<TaskDetail id="A" />);
    expect(screen.getByRole('dialog', { name: 'Task: Pay rent' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '09:30' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('A', { changes: { due: '2026-11-01T09:30' }, base: { due: '2026-11-01' } }, expect.any(String)));
    fireEvent.click(screen.getByRole('radio', { name: /High/ }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { priority: 3 }, base: { priority: 0 } }, expect.any(String)));
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'daily' } });
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { recurrence: { rrule: 'FREQ=DAILY', from: 'due' } }, base: { recurrence: null } }, expect.any(String)));
    fireEvent.click(screen.getByRole('button', { name: /Add reminder/ }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { reminders: [{ at: '2026-11-01T09:30' }] }, base: { reminders: [] } }, expect.any(String)));
    fireEvent.change(screen.getByRole('combobox', { name: 'List' }), { target: { value: 'L2' } });
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { listId: 'L2' }, base: { listId: 'L1' } }, expect.any(String)));
  });

  it('reads a custom rule as an RRULE', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Water plants', due: '2026-10-19' })]);
    const patch = update();
    renderWithApp(<TaskDetail id="A" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'custom' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom repeat' }), { target: { value: 'every 2 weeks on monday' } });
    expect(screen.getByText('every 2 weeks on Monday')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('A', { changes: { recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', from: 'due' } }, base: { recurrence: null } }, expect.any(String)));
  });

  it('renders notes as sanitized Markdown and saves edits made in them', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Read', notes: '**Bold** <img src=x onerror="alert(1)"><script>alert(2)</script>' })]);
    const patch = update();
    renderWithApp(<TaskDetail id="A" />);
    const preview = screen.getByRole('button', { name: 'Edit notes' });
    expect(preview.querySelector('strong')?.textContent).toBe('Bold');
    expect(preview.innerHTML).not.toContain('script');
    expect(preview.innerHTML).not.toContain('onerror');
    fireEvent.click(preview);
    const area = screen.getByRole('textbox', { name: 'Notes' });
    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: 'New notes' } });
    fireEvent.blur(area);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('A', { changes: { notes: 'New notes' }, base: { notes: '**Bold** <img src=x onerror="alert(1)"><script>alert(2)</script>' } }, expect.any(String)),
    );
  });

  it('saves a title still being typed when the sheet closes', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Pay rent' })]);
    const patch = update();
    const view = renderWithApp(<TaskDetail id="A" />);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Pay the rent' } });
    view.unmount();
    await waitFor(() => expect(patch).toHaveBeenCalledWith('A', { changes: { title: 'Pay the rent' }, base: { title: 'Pay rent' } }, expect.any(String)));
  });

  it('adds subtasks and opens them', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Move' }), makeTask({ id: 'C', title: 'Book the van', parentId: 'A' })]);
    const create = vi.spyOn(taskApi, 'create').mockImplementation(async (req) => result(makeTask({ ...req, id: 'N' } as Partial<Task>)));
    renderWithApp(<TaskDetail id="A" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Add subtask' }), { target: { value: 'Pack books' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Add subtask' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Pack books', parentId: 'A' }, expect.any(String)));
    fireEvent.click(screen.getByText('Book the van'));
    expect(useTaskUi.getState().detailId).toBe('C');
  });

  it('is read-only for an archived task', () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Old', status: 'done', archived: true, completedAt: '2026-01-01T00:00:00.000Z' })]);
    renderWithApp(<TaskDetail id="A" />);
    expect(screen.getByText(/archived/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    // Reopening stays possible.
    expect(screen.getByRole('checkbox', { name: 'Reopen “Old”' })).toBeEnabled();
  });

  it('fetches a task it does not know, and says when it is gone', async () => {
    const problem: Problem = { type: 'x', title: 'Not found', status: 404, code: 'not-found' };
    vi.spyOn(taskApi, 'get').mockRejectedValue(new ApiError(problem));
    renderWithApp(<TaskDetail id="Z" />);
    expect(await screen.findByText('This task no longer exists')).toBeInTheDocument();
  });
});
