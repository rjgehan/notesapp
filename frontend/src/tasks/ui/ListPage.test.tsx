import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import type { Task, TaskList, TaskWriteResult } from '../../api/types';
import { useToasts } from '../../state/toasts';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeSection, makeTask } from '../testing';
import ListPage from './ListPage';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';

const list = makeList({ sections: [makeSection('S1', 'Errands', 'a0')] });
const tasks = [
  makeTask({ id: 'A', title: 'Plan the move', order: 'a0' }),
  makeTask({ id: 'A1', title: 'Book the van', parentId: 'A', order: 'a0' }),
  makeTask({ id: 'B', title: 'Pay rent', order: 'a1', priority: 3, tags: ['bills'] }),
  makeTask({ id: 'D', title: 'Old chore', order: 'a2', status: 'done', completedAt: '2026-10-01T00:00:00.000Z' }),
  makeTask({ id: 'E', title: 'Buy milk', sectionId: 'S1', order: 'a0' }),
];

function serve(l: TaskList = list, t: Task[] = tasks) {
  return vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'list', lists: [l], tasks: t, total: t.length, problems: [] });
}

function result(task: Task | null, changed: Task[] = []): TaskWriteResult {
  return { task, changed, deleted: [], rolledForward: false, files: [], createdFolders: [], lists: [] };
}

const titles = () => [...document.querySelectorAll('.task-tree .task-row')].map((r) => `${(r as HTMLElement).style.getPropertyValue('--task-depth')}:${r.querySelector('.task-title')?.textContent ?? '(editing)'}`);

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
});

afterEach(() => queryClient.clear());

const renderList = () => renderWithApp(<ListPage />, { path: '/x/tasks/list/L1', route: '/x/tasks/list/:id' });

describe('List page (ROADMAP item 4)', () => {
  it('shows sections and subtasks, and completed tasks on request', async () => {
    const query = serve();
    renderList();
    await screen.findByText('Plan the move');
    expect(query).toHaveBeenCalledWith({ view: 'list', list: 'L1', status: 'all' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Home');
    expect(titles()).toEqual(['0:Plan the move', '1:Book the van', '0:Pay rent', '0:Buy milk']);
    expect(screen.getByRole('button', { name: /^Errands/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'List actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Show completed tasks \(1\)/ }));
    expect(titles()).toContain('0:Old chore');
  });

  it('hides and shows subtasks', async () => {
    serve();
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Hide subtasks of “Plan the move”' }));
    expect(titles()).toEqual(['0:Plan the move', '0:Pay rent', '0:Buy milk']);
    fireEvent.click(screen.getByRole('button', { name: /^Errands/ }));
    expect(titles()).toEqual(['0:Plan the move', '0:Pay rent']);
  });

  it('edits a title inline and sends it with the title it started from', async () => {
    serve();
    const update = vi.spyOn(taskApi, 'update').mockImplementation(async (_id, req) => result({ ...tasks[2], ...req.changes } as Task));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit “Pay rent”' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Pay the rent' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.blur(title);
    await waitFor(() => expect(update).toHaveBeenCalledWith('B', { changes: { title: 'Pay the rent' }, base: { title: 'Pay rent' } }, expect.any(String)));
    // Priority and the due date are inline too.
    fireEvent.click(screen.getByRole('radio', { name: /Low/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('B', { changes: { priority: 1 }, base: { priority: 3 } }, expect.any(String)));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('B', { changes: { due: '2026-11-01' }, base: { due: null } }, expect.any(String)));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  });

  it('adds tags inline, refusing invalid ones', async () => {
    serve();
    const update = vi.spyOn(taskApi, 'update').mockImplementation(async (_id, req) => result({ ...tasks[2], ...req.changes } as Task));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit “Pay rent”' }));
    const input = screen.getByRole('textbox', { name: 'Add tags' });
    fireEvent.change(input, { target: { value: '#home, 123' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('“123” is not a valid tag');
    fireEvent.change(input, { target: { value: '#home' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(update).toHaveBeenCalledWith('B', { changes: { tags: ['bills', 'home'] }, base: { tags: ['bills'] } }, expect.any(String)));
  });

  it('moves a task with Alt+arrows: down among siblings and into the task above', async () => {
    serve();
    const reorder = vi.spyOn(taskApi, 'reorder').mockImplementation(async (req) => result(null, [{ ...tasks[2], parentId: req.parentId }]));
    renderList();
    const row = await screen.findByRole('button', { name: 'Edit “Plan the move”' });
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(reorder).toHaveBeenCalledWith({ listId: 'L1', sectionId: null, parentId: null, ids: ['A'], after: 'B' }, expect.any(String)));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit “Pay rent”' }), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(reorder).toHaveBeenLastCalledWith(expect.objectContaining({ ids: ['B'], parentId: 'A' }), expect.any(String)));
  });

  it('moves a task into a section from its menu', async () => {
    serve();
    const reorder = vi.spyOn(taskApi, 'reorder').mockImplementation(async () => result(null, [{ ...tasks[2], sectionId: 'S1', order: 'Zz' }]));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'More for “Pay rent”' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to section “Errands”' }));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith({ listId: 'L1', sectionId: 'S1', parentId: null, ids: ['B'], after: null }, expect.any(String)));
    await waitFor(() => expect(titles()).toEqual(['0:Plan the move', '1:Book the van', '0:Pay rent', '0:Buy milk']));
    const errands = screen.getByRole('button', { name: /^Errands/ }).closest('li')!;
    expect(within(errands).getByText('2')).toBeInTheDocument();
  });

  it('opens quick add for the list and for a section', async () => {
    serve();
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Add task to Errands' }));
    expect(useTaskUi.getState().quickAdd).toEqual({ listId: 'L1', sectionId: 'S1' });
    fireEvent.click(screen.getAllByRole('button', { name: /Add task/ })[0]);
    expect(useTaskUi.getState().quickAdd).toEqual({ listId: 'L1' });
  });

  it('cancels a task from its menu, with Undo', async () => {
    serve();
    const update = vi.spyOn(taskApi, 'update').mockImplementation(async (_id, req) => result({ ...tasks[2], ...req.changes, completedAt: '2026-10-17T10:00:00.000Z' } as Task));
    const uncomplete = vi.spyOn(taskApi, 'uncomplete').mockResolvedValue(result({ ...tasks[2], status: 'open', completedAt: null }));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'More for “Pay rent”' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel task' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('B', { changes: { status: 'cancelled' }, base: { status: 'open' } }, expect.any(String)));
    await waitFor(() => expect(titles()).toEqual(['0:Plan the move', '1:Book the van', '0:Buy milk']));
    const toast = useToasts.getState().toasts.at(-1)!;
    expect(toast.message).toBe('Cancelled “Pay rent”');
    act(() => toast.action!.run());
    await waitFor(() => expect(uncomplete).toHaveBeenCalledWith('B', expect.any(String)));
    await waitFor(() => expect(titles()).toContain('0:Pay rent'));
  });

  it('moves a section up and down from its menu (they are the board’s columns too)', async () => {
    const two = { ...list, sections: [makeSection('S1', 'Errands', 'a0'), makeSection('S2', 'Calls', 'a1')] };
    serve(two);
    const reorder = vi.spyOn(taskApi, 'reorderSections').mockResolvedValue({ lists: [{ ...two, sections: [makeSection('S2', 'Calls', 'Zz'), makeSection('S1', 'Errands', 'a0')] }], files: [], createdFolders: [], moved: null, trash: null });
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'More for section Errands' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith('L1', { ids: ['S1'], after: 'S2' }, expect.any(String)));
    await waitFor(() => expect([...document.querySelectorAll('.task-section-toggle > span:first-of-type')].map((s) => s.textContent)).toEqual(['Calls', 'Errands']));
    fireEvent.click(screen.getByRole('button', { name: 'More for section Errands' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(reorder).toHaveBeenLastCalledWith('L1', { ids: ['S1'], after: null }, expect.any(String)));
  });

  it('shows a list written by a newer version read-only', async () => {
    serve({ ...list, writable: false });
    renderList();
    expect(await screen.findByText(/cannot be changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add task/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Complete “Pay rent”' })).toBeDisabled();
  });

  it('says so when the list no longer exists', async () => {
    vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'list', lists: [], tasks: [], total: 0, problems: [] });
    renderList();
    expect(await screen.findByText('This list no longer exists')).toBeInTheDocument();
  });
});

describe('the Kanban view of a list (ROADMAP item 4)', () => {
  const columnTitles = () => [...document.querySelectorAll('[data-board-column]')].map((c) => `${c.querySelector('.board-column-name')?.textContent}: ${[...c.querySelectorAll('.board-card .task-title')].map((t) => t.textContent).join(', ')}`);

  beforeEach(() => localStorage.clear());

  it('shows the sections as columns of top-level cards, and is remembered for the list', async () => {
    serve();
    const first = renderList();
    fireEvent.click(await screen.findByRole('radio', { name: /Board/ }));
    expect(columnTitles()).toEqual(['No section: Plan the move, Pay rent', 'Errands: Buy milk']);
    expect(screen.getByText('0/1')).toBeInTheDocument();
    first.unmount();
    renderList();
    expect(await screen.findByRole('region', { name: 'Home board' })).toBeInTheDocument();
  });

  it('moves a card to the next column with Alt+→, at the same height, as a reorder into that section', async () => {
    serve();
    const reorder = vi.spyOn(taskApi, 'reorder').mockImplementation(async () => result(null, [{ ...tasks[0], sectionId: 'S1', order: 'Zz' }]));
    renderList();
    fireEvent.click(await screen.findByRole('radio', { name: /Board/ }));
    const card = screen.getByText('Plan the move').closest('[data-board-card]') as HTMLElement;
    fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(reorder).toHaveBeenCalledWith({ listId: 'L1', sectionId: 'S1', parentId: null, ids: ['A'], after: null }, expect.any(String)));
    await waitFor(() => expect(columnTitles()).toEqual(['No section: Pay rent', 'Errands: Plan the move, Buy milk']));
  });

  it('by status: a card moved to Done completes the task, and one moved back reopens it', async () => {
    serve();
    const complete = vi.spyOn(taskApi, 'complete').mockResolvedValue(result({ ...tasks[2], status: 'done', completedAt: '2026-10-17T10:00:00.000Z' }));
    const uncomplete = vi.spyOn(taskApi, 'uncomplete').mockResolvedValue(result({ ...tasks[3], status: 'open', completedAt: null }));
    renderList();
    fireEvent.click(await screen.findByRole('radio', { name: /Board/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Columns' }), { target: { value: 'board-status' } });
    expect(columnTitles()).toEqual(['To do: Plan the move, Pay rent, Buy milk', 'Done: Old chore', 'Cancelled: ']);
    fireEvent.click(screen.getByRole('button', { name: 'More for “Pay rent”' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as done' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('B', expect.objectContaining({ base: { due: null, start: null } }), expect.any(String)));
    await waitFor(() => expect(columnTitles()).toEqual(['To do: Plan the move, Buy milk', 'Done: Pay rent, Old chore', 'Cancelled: ']));
    const old = screen.getByText('Old chore').closest('[data-board-card]') as HTMLElement;
    fireEvent.keyDown(old, { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(uncomplete).toHaveBeenCalledWith('D', expect.any(String)));
  });

  it('by status: a card dropped on the (always shown) Cancelled column cancels the task', async () => {
    serve();
    const update = vi.spyOn(taskApi, 'update').mockImplementation(async (_id, req) => result({ ...tasks[4], ...req.changes, completedAt: '2026-10-17T10:00:00.000Z' } as Task));
    renderList();
    fireEvent.click(await screen.findByRole('radio', { name: /Board/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Columns' }), { target: { value: 'board-status' } });
    fireEvent.click(screen.getByRole('button', { name: 'More for “Buy milk”' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as cancelled' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('E', { changes: { status: 'cancelled' }, base: { status: 'open' } }, expect.any(String)));
    await waitFor(() => expect(columnTitles()).toEqual(['To do: Plan the move, Pay rent', 'Done: Old chore', 'Cancelled: Buy milk']));
  });
});
