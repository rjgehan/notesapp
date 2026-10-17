import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import type { FileEntry, TaskWriteResult } from '../../api/types';
import { hydrateEmbeds, unmountEmbeds } from '../../render/embeds';
import { taskApi } from '../api';
import { registerTasks } from '../register';
import { taskStore } from '../store';
import { makeList, makeSection, makeTask } from '../testing';
import { useTaskUi } from './state';

const list = makeList({ sections: [makeSection('S1', 'Errands', 'a0')] });
const tasks = [
  makeTask({ id: 'A', title: 'Plan the move', order: 'a0' }),
  makeTask({ id: 'A1', title: 'Book the van', parentId: 'A', order: 'a0' }),
  makeTask({ id: 'B', title: 'Buy milk', sectionId: 'S1', order: 'a0' }),
  makeTask({ id: 'D', title: 'Old chore', order: 'a1', status: 'done', completedAt: '2026-10-01T00:00:00.000Z' }),
];
const entry: FileEntry = { path: 'Tasks/Home.tasks', name: 'Home.tasks', basename: 'Home', extension: 'tasks', kind: 'text', size: 10, mtime: '2026-10-17T10:00:00Z', version: 'v1', aliases: [] };

let container: HTMLElement;

/** An embed placeholder as the reading view renders `![[Home.tasks…]]`, hydrated through the view registry. */
function embed(subpath?: string): HTMLElement {
  container = document.createElement('div');
  container.innerHTML = `<span class="internal-embed file-embed" data-embed-kind="file" data-embed-path="Tasks/Home.tasks"${subpath ? ` data-embed-subpath="${subpath}"` : ''}></span>`;
  document.body.append(container);
  act(() => hydrateEmbeds(container, { sourcePath: 'Weekend.md', depth: 0, entry: (p) => (p === entry.path ? entry : undefined), rawUrl: () => '' }));
  return container;
}

beforeEach(() => {
  registerTasks();
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [list], problems: [] });
  vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'list', lists: [list], tasks, total: tasks.length, problems: [] });
});

afterEach(() => {
  act(() => unmountEmbeds(container));
  container.remove();
  queryClient.clear();
});

describe('![[List.tasks]] embeds (ROADMAP item 4)', () => {
  it('show the list, live, through the view registry’s loadEmbed', async () => {
    const el = embed();
    const box = within(el);
    expect(await box.findByText('Plan the move')).toBeInTheDocument();
    expect(box.getByText('Book the van').closest('li')).toHaveStyle({ '--task-depth': '1' });
    expect(box.getByText('Errands')).toHaveClass('task-embed-section');
    expect(box.queryByText('Old chore')).not.toBeInTheDocument();
    fireEvent.click(box.getByRole('button', { name: 'Show completed (1)' }));
    expect(box.getByText('Old chore')).toBeInTheDocument();
    // A change from anywhere (here: the store, as an event would) shows at once.
    act(() => taskStore.upsert([{ ...tasks[2], title: 'Buy oat milk' }]));
    expect(box.getByText('Buy oat milk')).toBeInTheDocument();
  });

  it('complete a task when it is checked, and open its details from its title', async () => {
    const complete = vi.spyOn(taskApi, 'complete').mockResolvedValue({ task: { ...tasks[2], status: 'done', completedAt: '2026-10-17T10:00:00.000Z' }, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [] } satisfies TaskWriteResult);
    const box = within(embed());
    fireEvent.click(await box.findByRole('checkbox', { name: 'Complete “Buy milk”' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('B', expect.objectContaining({ base: { due: null, start: null } }), expect.any(String)));
    await waitFor(() => expect(box.queryByText('Buy milk')).not.toBeInTheDocument());
    fireEvent.click(box.getByText('Plan the move'));
    expect(useTaskUi.getState().detailId).toBe('A');
  });

  it('add a task to the list, or to the section shown', async () => {
    const create = vi.spyOn(taskApi, 'create').mockResolvedValue({ task: makeTask({ id: 'N', title: 'Eggs', sectionId: 'S1' }), changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [] });
    const box = within(embed('Errands'));
    expect(await box.findByText('Buy milk')).toBeInTheDocument();
    expect(box.queryByText('Plan the move')).not.toBeInTheDocument();
    expect(box.getByText('Home › Errands')).toBeInTheDocument();
    const input = box.getByRole('textbox', { name: 'Add task' });
    fireEvent.change(input, { target: { value: ' Eggs ' } });
    fireEvent.submit(input);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Eggs', listId: 'L1', sectionId: 'S1' }, expect.any(String)));
  });

  it('show one task and its subtasks for a #^id subpath, and say when it is gone', async () => {
    const box = within(embed('^A'));
    expect(await box.findByText('Plan the move')).toBeInTheDocument();
    expect(box.getByText('Book the van')).toBeInTheDocument();
    expect(box.queryByText('Buy milk')).not.toBeInTheDocument();
    expect(box.getByRole('textbox', { name: 'Add subtask' })).toBeInTheDocument();
    act(() => unmountEmbeds(container));
    container.remove();
    const gone = within(embed('^NOPE'));
    expect(await gone.findByText('This task is not in this list any more.')).toBeInTheDocument();
  });

  it('say why a file cannot be shown', async () => {
    vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [], problems: [{ path: 'Tasks/Home.tasks', taskId: null, reason: 'not valid JSON (line 1, column 3)' }] });
    const box = within(embed());
    expect(await box.findByText(/cannot be read: not valid JSON/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
