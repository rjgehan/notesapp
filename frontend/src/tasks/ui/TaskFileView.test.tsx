import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { queryClient } from '../../api/queryClient';
import type { FileEntry } from '../../api/types';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { useTaskUi } from './state';
import TaskFileView from './TaskFileView';

// The source view is the text view with its session; its own tests cover it.
vi.mock('../../views/TextView', () => ({ default: ({ path }: { path: string }) => <div>JSON of {path}</div> }));
vi.mock('../../sync/useTextDocument', () => ({ useDocumentSession: () => ({}) }));
vi.mock('../../components/ConflictBanner', () => ({ ConflictBanner: () => null }));

const list = makeList({ id: 'INBOX', name: 'Inbox', path: 'Tasks/Inbox.tasks' });
const entry = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, basename: 'x', extension: 'tasks', kind: 'text', size: 1, mtime: '2026-10-17T10:00:00Z', version: 'v1', aliases: [] });

const where = { current: '' };
function Where() {
  const l = useLocation();
  useEffect(() => {
    where.current = l.pathname + l.search + l.hash;
  });
  return null;
}

const view = (path: string, at = `/n/${path}`) =>
  renderWithApp(
    <>
      <TaskFileView path={path} entry={entry(path)} mode="read" />
      <Where />
    </>,
    { path: at },
  );

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [list], problems: [{ path: 'Tasks/Broken.tasks', taskId: null, reason: 'not valid JSON (line 1, column 3)' }] });
  vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'list', lists: [list], tasks: [makeTask({ id: 'T1', listId: 'INBOX', title: 'Book the dentist' })], total: 1, problems: [] });
});

afterEach(() => queryClient.clear());

describe('the tasks file view', () => {
  it('shows a list file as its list, with its source a click away', async () => {
    view('Tasks/Inbox.tasks');
    expect(await screen.findByText('Book the dentist')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Show the file’s source' }));
    expect(screen.getByText('JSON of Tasks/Inbox.tasks')).toBeInTheDocument();
    expect(where.current).toBe('/n/Tasks/Inbox.tasks?view=source');
    fireEvent.click(screen.getByRole('button', { name: /Show as list/ }));
    expect(await screen.findByText('Book the dentist')).toBeInTheDocument();
  });

  it('opens the task a link points to (#^id) and points it out in the list', async () => {
    view('Tasks/Inbox.tasks', '/n/Tasks/Inbox.tasks#%5ET1');
    await waitFor(() => expect(useTaskUi.getState().detailId).toBe('T1'));
    expect((await screen.findByText('Book the dentist')).closest('li')).toHaveClass('is-highlighted');
  });

  it('shows a file that is not a usable list as its source, with the reason', async () => {
    view('Tasks/Broken.tasks');
    expect(await screen.findByText(/cannot be used as a task list: not valid JSON/)).toBeInTheDocument();
    expect(screen.getByText('JSON of Tasks/Broken.tasks')).toBeInTheDocument();
    view('Tasks/Archive/Inbox 2025.tasks');
    expect(await screen.findByText(/is not a task list/)).toBeInTheDocument();
  });
});
