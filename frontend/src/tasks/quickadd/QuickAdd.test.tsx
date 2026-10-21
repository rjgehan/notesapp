import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import type { Problem, Task, TaskList, TaskWriteResult } from '../../api/types';
import { taskApi } from '../api';
import { addDays, localToday } from '../dates';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from '../ui/renderWithApp';
import { useTaskUi } from '../ui/state';
import { QuickAddDialog } from './QuickAdd';

const today = localToday();
const bills = makeList({ id: 'B1', name: 'Bills', path: 'Tasks/Bills.tasks' });
const inbox = makeList({ id: 'IN', name: 'Inbox', order: 'Zz', path: 'Tasks/Inbox.tasks' });

function result(task: Task): TaskWriteResult {
  return { task, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [], lists: [] };
}

beforeEach(() => {
  taskStore.reset();
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [inbox, bills], problems: [] });
  useTaskUi.setState({ quickAdd: {}, detailId: null });
});

afterEach(() => queryClient.clear());

const input = () => screen.getByRole('textbox', { name: 'Task' });
const chips = () => [...document.querySelectorAll('.quick-add-chips .task-chip-label')].map((c) => c.textContent);

describe('quick add (ROADMAP item 4)', () => {
  it('focuses its field at once and shows parsed parts as chips', async () => {
    renderWithApp(<QuickAddDialog context={{}} />);
    expect(input()).toHaveFocus();
    fireEvent.change(input(), { target: { value: 'Pay rent tomorrow every month !high #home @Bills [[Apartment]]' } });
    await waitFor(() => expect(chips()).toHaveLength(6));
    expect(chips()).toEqual(['Tomorrow', 'every month', 'High priority', 'home', 'Bills', 'Apartment']);
  });

  it('creates the task from the parsed fields and closes', async () => {
    const create = vi.spyOn(taskApi, 'create').mockImplementation(async (req) => result(makeTask({ ...req, listId: 'B1', id: 'N' } as Partial<Task>)));
    renderWithApp(<QuickAddDialog context={{}} />);
    await waitFor(() => expect(taskStore.hasLists()).toBe(true));
    fireEvent.change(input(), { target: { value: 'Pay rent tomorrow every month !high #home @Bills [[Apartment]]' } });
    await waitFor(() => expect(chips()).toHaveLength(6));
    fireEvent.submit(input().closest('form')!);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        { title: 'Pay rent [[Apartment]]', listId: 'B1', due: addDays(today, 1), recurrence: { rrule: 'FREQ=MONTHLY', from: 'due' }, priority: 3, tags: ['home'] },
        expect.any(String),
      ),
    );
    expect(useTaskUi.getState().quickAdd).toBeNull();
  });

  it('keeps a dismissed part in the title', async () => {
    const create = vi.spyOn(taskApi, 'create').mockImplementation(async (req) => result(makeTask({ ...req, id: 'N' } as Partial<Task>)));
    renderWithApp(<QuickAddDialog context={{}} />);
    fireEvent.change(input(), { target: { value: 'Plan #work trip' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep “work” as text' }));
    expect(chips()).toEqual([]);
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Plan #work trip' }, expect.any(String)));
  });

  it('uses the context: today from the Today page (dismissable), the section of a list, a linked note', async () => {
    const create = vi.spyOn(taskApi, 'create').mockImplementation(async (req) => result(makeTask({ ...req, id: 'N' } as Partial<Task>)));
    renderWithApp(<QuickAddDialog context={{ listId: 'B1', sectionId: 'S1', due: today, links: ['Apartment.md'] }} />);
    await waitFor(() => expect(taskStore.hasLists()).toBe(true));
    expect(screen.getByText(/Adds to Bills/)).toBeInTheDocument();
    expect(chips()).toEqual(['Today', 'Linked to Apartment']);
    fireEvent.change(input(), { target: { value: 'Call the landlord' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Call the landlord', listId: 'B1', sectionId: 'S1', due: today, links: ['Apartment.md'] }, expect.any(String)));
  });

  it('creates a new list first for an unknown @List', async () => {
    const created: TaskList = makeList({ id: 'G1', name: 'groceries', path: 'Tasks/groceries.tasks', order: 'a5' });
    const createList = vi.spyOn(taskApi, 'createList').mockResolvedValue({ lists: [created], files: [], createdFolders: [], moved: null, trash: null });
    const create = vi.spyOn(taskApi, 'create').mockImplementation(async (req) => result(makeTask({ ...req, id: 'N' } as Partial<Task>)));
    renderWithApp(<QuickAddDialog context={{}} />);
    await waitFor(() => expect(taskStore.hasLists()).toBe(true));
    fireEvent.change(input(), { target: { value: 'Buy milk @groceries' } });
    await waitFor(() => expect(chips()).toEqual(['New list “groceries”']));
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Buy milk', listId: 'G1' }, expect.any(String)));
    expect(createList).toHaveBeenCalledWith({ name: 'groceries' }, expect.any(String));
  });

  it('gives the typed text back when the server refuses the task', async () => {
    const problem: Problem = { type: 'x', title: 'Bad request', status: 400, code: 'bad-request', detail: 'notes too long' };
    vi.spyOn(taskApi, 'create').mockRejectedValue(new ApiError(problem));
    renderWithApp(<QuickAddDialog context={{ listId: 'B1' }} />);
    fireEvent.change(input(), { target: { value: 'Something long' } });
    fireEvent.submit(input().closest('form')!);
    await waitFor(() => expect(useTaskUi.getState().quickAdd).toEqual({ listId: 'B1', text: 'Something long' }));
  });

  it('does not add an empty title', async () => {
    const create = vi.spyOn(taskApi, 'create');
    renderWithApp(<QuickAddDialog context={{}} />);
    fireEvent.change(input(), { target: { value: '#only-a-tag' } });
    await waitFor(() => expect(chips()).toEqual(['only-a-tag']));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.submit(input().closest('form')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(create).not.toHaveBeenCalled();
  });
});
