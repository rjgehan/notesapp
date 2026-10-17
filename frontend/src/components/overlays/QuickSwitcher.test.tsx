import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { FileEntry, TreeResponse, WriteResult } from '../../api/types';
import { buildVaultTree } from '../../api/vaultTree';
import { registerBuiltins } from '../../extensions/builtins';
import { setNavigator } from '../../features/navigation';
import { basenameOf, extensionOf, lastSegment } from '../../features/paths';
import { recordOpened } from '../../features/recent';
import { switcherItems } from '../../features/switcher';
import { useUi } from '../../state/ui';
import { QuickSwitcher } from './QuickSwitcher';

function entry(path: string, aliases: string[] = []): FileEntry {
  const ext = extensionOf(path);
  return {
    path,
    name: lastSegment(path),
    basename: basenameOf(path),
    extension: ext,
    kind: ext === 'md' ? 'note' : ext === 'png' ? 'image' : 'other',
    size: 1,
    mtime: '2026-10-16T10:00:00.000Z',
    version: ext === 'md' ? 'v' : null,
    aliases,
  };
}

const TREE: TreeResponse = {
  eventId: 'b.1',
  folders: [{ path: 'Projects', name: 'Projects' }, { path: 'Attachments', name: 'Attachments' }],
  files: [entry('Welcome.md'), entry('Plan.md'), entry('Projects/Plan.md', ['Roadmap']), entry('Projects/Plane trip.md'), entry('Attachments/plan.png')],
};

const navigate = vi.fn();

beforeEach(() => {
  registerBuiltins();
  queryClient.setQueryData(queryKeys.tree(), TREE);
  setNavigator(navigate);
  navigate.mockClear();
  useUi.setState({ overlay: 'switcher' });
});

afterEach(() => {
  queryClient.clear();
});

function renderSwitcher() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <QuickSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('switcherItems', () => {
  const tree = buildVaultTree(TREE);

  it('lists the recent files for an empty query', () => {
    expect(switcherItems(tree, '', ['Projects/Plan.md', 'Gone.md', 'Welcome.md']).map((i) => i.path)).toEqual(['Projects/Plan.md', 'Welcome.md']);
  });

  it('ranks notes, aliases and other files fuzzily and adds a Create row without an exact match', () => {
    const rows = switcherItems(tree, 'plan', []);
    expect(rows[0].kind).toBe('note');
    expect(rows.map((r) => r.path)).toEqual(expect.arrayContaining(['Plan.md', 'Projects/Plan.md', 'Projects/Plane trip.md', 'Attachments/plan.png']));
    // "Plan" is the exact name of a note: no Create row.
    expect(rows.some((r) => r.kind === 'create')).toBe(false);
    const alias = switcherItems(tree, 'roadmap', []);
    expect(alias[0]).toMatchObject({ kind: 'alias', path: 'Projects/Plan.md', detail: 'alias of Plan' });
    const missing = switcherItems(tree, 'Plans for 2027', []);
    expect(missing.at(-1)).toMatchObject({ kind: 'create', label: 'Create “Plans for 2027”' });
  });

  it('boosts notes above other files of equal match quality', () => {
    const rows = switcherItems(tree, 'plan', []).filter((r) => r.kind !== 'create');
    const note = rows.findIndex((r) => r.path === 'Plan.md');
    const image = rows.findIndex((r) => r.path === 'Attachments/plan.png');
    expect(note).toBeLessThan(image);
  });

  it('adds a "Search in notes" row on phones', () => {
    expect(switcherItems(tree, 'plan', [], true).at(-1)).toMatchObject({ kind: 'search', path: 'plan' });
  });
});

describe('QuickSwitcher', () => {
  it('focuses its input at once and shows recent files', () => {
    recordOpened('Welcome.md');
    renderSwitcher();
    const input = screen.getByRole('combobox', { name: 'Quick switcher' });
    expect(input).toHaveFocus();
    expect(options()).toEqual(['Welcome']);
  });

  it('filters fuzzily as you type and opens the selection with Enter', () => {
    renderSwitcher();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'plne trp' } });
    expect(options()[0]).toContain('Plane trip');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/n/Projects/Plane%20trip.md', undefined);
    expect(useUi.getState().overlay).toBeNull();
  });

  it('shows a Create row when nothing matches exactly, which creates the note', async () => {
    const create = vi.spyOn(api, 'createFile').mockResolvedValue({ file: entry('Someday.md'), created: true, createdFolders: [] } satisfies WriteResult);
    renderSwitcher();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Someday' } });
    const rows = screen.getAllByRole('option');
    expect(rows.at(-1)).toHaveTextContent('Create “Someday”');
    fireEvent.click(rows.at(-1)!);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ path: 'Someday.md', content: '', onConflict: 'fail' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/n/Someday.md', undefined));
  });

  it('Shift-Enter creates a note named exactly the query, even when another item matches', async () => {
    const create = vi.spyOn(api, 'createFile').mockResolvedValue({ file: entry('Plan.md'), created: true, createdFolders: [] });
    renderSwitcher();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Pla' } });
    expect(options()[0]).toContain('Plan');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ path: 'Pla.md', onConflict: 'fail' }), expect.anything()));
    expect(useUi.getState().overlay).toBeNull();
  });

  it('opens the existing note when the create answers 409 already-exists', async () => {
    const { ApiError } = await import('../../api/client');
    vi.spyOn(api, 'createFile').mockRejectedValue(
      new ApiError({ type: 'urn:notesapp:problem:already-exists', title: 'Already exists', status: 409, code: 'already-exists', existingPath: 'Ideas/Pla.md' }),
    );
    renderSwitcher();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Pla' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/n/Ideas/Pla.md', undefined));
  });
});
