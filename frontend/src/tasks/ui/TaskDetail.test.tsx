import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import type { Problem, Task, TaskWriteResult, TreeResponse } from '../../api/types';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';
import TaskDetail from './TaskDetail';
import { resetKeptDrafts } from './textField';

function result(task: Task): TaskWriteResult {
  return { task, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [], lists: [] };
}

const list = makeList();
const tree: TreeResponse = { eventId: 'b.1', folders: [], files: [] };

beforeEach(() => {
  taskStore.reset();
  taskStore.setLists([list, makeList({ id: 'L2', name: 'Work', order: 'a1', path: 'Tasks/Work.tasks' })], [], taskStore.generation());
  queryClient.setQueryData(['tree'], tree);
  useTaskUi.setState({ quickAdd: null, detailId: 'A' });
});

afterEach(() => {
  queryClient.clear();
  resetKeptDrafts();
});

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
    fireEvent.change(screen.getByRole('combobox', { name: 'Add reminder' }), { target: { value: 'custom' } });
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { reminders: [{ at: '2026-11-01T09:30' }] }, base: { reminders: [] } }, expect.any(String)));
    fireEvent.change(screen.getByRole('combobox', { name: 'List' }), { target: { value: 'L2' } });
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { listId: 'L2' }, base: { listId: 'L1' } }, expect.any(String)));
  });

  it('adds a reminder from a preset relative to the due time', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Flight', due: '2099-05-02T10:30' })]);
    const patch = update();
    renderWithApp(<TaskDetail id="A" />);
    const add = screen.getByRole('combobox', { name: 'Add reminder' });
    expect(within(add).getByRole('option', { name: /^1 hour before/ })).toHaveValue('2099-05-02T09:30');
    fireEvent.change(add, { target: { value: '2099-05-02T09:30' } });
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('A', { changes: { reminders: [{ at: '2099-05-02T09:30' }] }, base: { reminders: [] } }, expect.any(String)));
  });

  it('builds a custom rule from choices, read back as text', async () => {
    // Monday 19 October 2026.
    taskStore.upsert([makeTask({ id: 'A', title: 'Water plants', due: '2026-10-19' })]);
    const patch = update();
    renderWithApp(<TaskDetail id="A" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'custom' } });
    const editor = screen.getByRole('form', { name: 'Custom repeat' });
    expect(within(editor).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(within(editor).getByRole('spinbutton', { name: 'Interval' }), { target: { value: '2' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Thursday' }));
    fireEvent.change(within(editor).getByRole('spinbutton', { name: 'Times' }), { target: { value: '5' } });
    expect(within(editor).getByText('Every 2 weeks on Monday, Thursday, 5 more times')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Set' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('A', { changes: { recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5', from: 'due' } }, base: { recurrence: null } }, expect.any(String)),
    );
    expect(screen.queryByRole('form', { name: 'Custom repeat' })).not.toBeInTheDocument();
  });

  it('reads a rule typed in words, or a raw RRULE checked against the server’s subset', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Water plants', due: '2026-10-19' })]);
    const patch = update();
    renderWithApp(<TaskDetail id="A" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat' }), { target: { value: 'custom' } });
    const editor = screen.getByRole('form', { name: 'Custom repeat' });
    fireEvent.click(screen.getByRole('radio', { name: 'In words' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Repeat, in words' }), { target: { value: 'every 2 weeks on monday' } });
    expect(within(editor).getByText('Every 2 weeks on Monday')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'RRULE' }));
    const raw = screen.getByRole('textbox', { name: 'RRULE' });
    expect(raw).toHaveValue('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    fireEvent.change(raw, { target: { value: 'FREQ=HOURLY' } });
    expect(screen.getByText(/FREQ must be/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set' })).toBeDisabled();
    fireEvent.change(raw, { target: { value: 'freq=monthly;byday=-1fr' } });
    expect(within(editor).getByText('Every month on the last Friday')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('A', { changes: { recurrence: { rrule: 'FREQ=MONTHLY;BYDAY=-1FR', from: 'due' } }, base: { recurrence: null } }, expect.any(String)));
  });

  it('shows a rule it cannot offer as a choice by its text, with the next dates', () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Report', due: '2026-10-19', recurrence: { rrule: 'FREQ=MONTHLY;BYDAY=1MO', from: 'completion' } })]);
    renderWithApp(<TaskDetail id="A" />);
    const repeat = screen.getByRole('combobox', { name: 'Repeat' });
    expect(repeat).toHaveDisplayValue('Every month on the 1st Monday');
    expect(screen.getByRole('combobox', { name: 'Repeat from' })).toHaveValue('completion');
    expect(screen.getByText(/^Then /)).toHaveTextContent(/Nov 2/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit the rule' }));
    expect(screen.getByRole('radio', { name: 'Choose' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /^on the/ })).toBeChecked();
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

  it('keeps notes whose save failed in the field, and sends them again on blur', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Plan trip', notes: 'old notes' })]);
    const patch = vi
      .spyOn(taskApi, 'update')
      .mockRejectedValueOnce(new TransientError('Failed to fetch'))
      .mockImplementation(async (id, req) => result({ ...taskStore.task(id)!, ...req.changes } as Task));
    renderWithApp(<TaskDetail id="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    const area = screen.getByRole('textbox', { name: 'Notes' });
    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: 'old notes\nNew paragraph typed on the train' } });
    fireEvent.blur(area);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    // Not saved: the text stays, marked, in the textarea (not the rendered notes).
    const kept = await screen.findByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(kept).toHaveAttribute('data-unsaved', 'true'));
    expect(kept).toHaveValue('old notes\nNew paragraph typed on the train');
    expect(taskStore.task('A')?.notes).toBe('old notes');
    // Leaving the field again sends it, based on what the server still has.
    fireEvent.focus(kept);
    fireEvent.blur(kept);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).toEqual({ changes: { notes: 'old notes\nNew paragraph typed on the train' }, base: { notes: 'old notes' } });
    await waitFor(() => expect(taskStore.task('A')?.notes).toBe('old notes\nNew paragraph typed on the train'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit notes' })).toHaveTextContent('New paragraph typed on the train'));
  });

  it('keeps a title whose save failed after the sheet closed, for the next time it opens', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Pay rent' })]);
    const patch = vi
      .spyOn(taskApi, 'update')
      .mockRejectedValueOnce(new TransientError('Failed to fetch'))
      .mockImplementation(async (id, req) => result({ ...taskStore.task(id)!, ...req.changes } as Task));
    const view = renderWithApp(<TaskDetail id="A" />);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Pay the rent' } });
    view.unmount();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(taskStore.hasPending('A')).toBe(false));
    expect(taskStore.task('A')?.title).toBe('Pay rent');
    renderWithApp(<TaskDetail id="A" />);
    // Shown again, and sent again with the server's value as its base.
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Pay the rent');
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).toEqual({ changes: { title: 'Pay the rent' }, base: { title: 'Pay rent' } });
    await waitFor(() => expect(taskStore.task('A')?.title).toBe('Pay the rent'));
  });

  it('sets the status: cancelled, then back to To do', async () => {
    taskStore.upsert([makeTask({ id: 'A', title: 'Renew passport' })]);
    const patch = update();
    const reopen = vi.spyOn(taskApi, 'uncomplete').mockImplementation(async (id) => result({ ...taskStore.task(id)!, status: 'open', completedAt: null }));
    renderWithApp(<TaskDetail id="A" />);
    const status = screen.getByRole('radiogroup', { name: 'Status' });
    expect(within(status).getByRole('radio', { name: 'To do' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(status).getByRole('radio', { name: 'Cancelled' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('A', { changes: { status: 'cancelled' }, base: { status: 'open' } }, expect.any(String)));
    await waitFor(() => expect(within(status).getByRole('radio', { name: 'Cancelled' })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(within(status).getByRole('radio', { name: 'To do' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith('A', expect.any(String)));
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
