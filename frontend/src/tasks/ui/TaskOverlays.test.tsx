import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { taskApi } from '../api';
import { taskStore } from '../store';
import { makeList, makeTask } from '../testing';
import { renderWithApp } from './renderWithApp';
import { openQuickAdd, openTaskDetail, useTaskUi } from './state';
import { TaskOverlays } from './TaskOverlays';

beforeEach(() => {
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [makeList()], problems: [] });
});

afterEach(() => queryClient.clear());

describe('the tasks overlay host (registerOverlay)', () => {
  it('shows nothing until quick add or a task is opened', async () => {
    renderWithApp(<TaskOverlays />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => openQuickAdd({ text: 'Buy milk' }));
    expect(screen.getByRole('dialog', { name: 'Add task' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Buy milk');
    // Opened again with other text, the dialog starts afresh.
    act(() => openQuickAdd({ text: 'Call Bob' }));
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Call Bob');
    taskStore.upsert([makeTask({ id: 'A', title: 'Pay rent' })]);
    act(() => openTaskDetail('A'));
    expect(await screen.findByRole('dialog', { name: 'Task: Pay rent' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add task' })).not.toBeInTheDocument();
  });
});
