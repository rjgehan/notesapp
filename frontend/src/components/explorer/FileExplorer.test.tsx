import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEntry, TreeResponse } from '../../api/types';
import { effectAllows, INTERNAL_PATH_TYPE } from '../../editor/pasteAndDrop';
import { registerBuiltins } from '../../extensions/builtins';
import { basenameOf, extensionOf, folderOf, lastSegment } from '../../features/paths';
import { useUi } from '../../state/ui';
import { FileExplorer } from './FileExplorer';

function file(path: string): FileEntry {
  return {
    path,
    name: lastSegment(path),
    basename: basenameOf(path),
    extension: extensionOf(path),
    kind: extensionOf(path) === 'md' ? 'note' : 'other',
    size: 1,
    mtime: '2026-10-16T10:00:00.000Z',
    version: null,
    aliases: [],
  };
}

function tree(paths: string[]): TreeResponse {
  const folders = new Set<string>();
  for (const p of paths) for (let f = folderOf(p); f; f = folderOf(f)) folders.add(f);
  return {
    eventId: 'b.1',
    folders: [...folders].sort().map((path) => ({ path, name: lastSegment(path) })),
    files: paths.sort().map(file),
  };
}

function renderExplorer(data: TreeResponse) {
  const qc = new QueryClient();
  qc.setQueryData(['tree'], data);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/n/Welcome.md']}>
        <FileExplorer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rows = () => screen.getAllByRole('treeitem');
const names = () => rows().map((r) => r.getAttribute('data-path'));

beforeEach(() => {
  registerBuiltins();
  useUi.setState({ expanded: {}, explorerSort: 'name', revealPath: null });
});

describe('FileExplorer', () => {
  it('lets a dragged row drop on folders (move) and into a note editor (link) (FE-10)', () => {
    renderExplorer(tree(['Welcome.md', 'Plan.md']));
    const row = rows().find((r) => r.getAttribute('data-path') === 'Plan.md')!;
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: 'uninitialized', dropEffect: 'none', setData: (t: string, v: string) => data.set(t, v), types: [] as string[] };
    fireEvent.dragStart(row, { dataTransfer });
    expect(data.get(INTERNAL_PATH_TYPE)).toBe('Plan.md');
    // The editor's dragover asks for 'link' (it inserts a link); explorer folders ask for 'move'.
    expect(effectAllows(dataTransfer.effectAllowed as DataTransfer['effectAllowed'], 'link')).toBe(true);
    expect(effectAllows(dataTransfer.effectAllowed as DataTransfer['effectAllowed'], 'move')).toBe(true);
    expect(effectAllows('copyMove', 'link')).toBe(false);
  });

  it('lists folders first, then files, with natural ordering', () => {
    renderExplorer(tree(['b.md', 'Welcome.md', 'a10.md', 'a2.md', 'Zed/x.md', 'alpha/y.md']));
    expect(names()).toEqual(['alpha', 'Zed', 'a2.md', 'a10.md', 'b.md', 'Welcome.md']);
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(rows()[5]).toHaveAttribute('aria-selected', 'true');
  });

  it('supports keyboard navigation with a roving tabindex', () => {
    renderExplorer(tree(['Welcome.md', 'Projects/Plan.md', 'Projects/Spec.md']));
    const treeEl = screen.getByRole('tree');
    // The active note holds the tab stop.
    expect(rows().filter((r) => r.tabIndex === 0).map((r) => r.getAttribute('data-path'))).toEqual(['Welcome.md']);

    act(() => rows()[0].focus());
    fireEvent.keyDown(treeEl, { key: 'ArrowRight' });
    expect(names()).toEqual(['Projects', 'Projects/Plan.md', 'Projects/Spec.md', 'Welcome.md']);
    expect(rows()[0]).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(treeEl, { key: 'ArrowDown' });
    fireEvent.keyDown(treeEl, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-path')).toBe('Projects/Spec.md');

    fireEvent.keyDown(treeEl, { key: 'ArrowLeft' });
    expect(document.activeElement?.getAttribute('data-path')).toBe('Projects');

    fireEvent.keyDown(treeEl, { key: 'ArrowLeft' });
    expect(names()).toEqual(['Projects', 'Welcome.md']);

    fireEvent.keyDown(treeEl, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-path')).toBe('Welcome.md');
  });

  it('opens a file with Enter', () => {
    renderExplorer(tree(['Welcome.md', 'Other note.md']));
    const treeEl = screen.getByRole('tree');
    act(() => rows()[0].focus());
    fireEvent.keyDown(treeEl, { key: 'Enter' });
    expect(window.location.pathname).toBe('/n/Other%20note.md');
  });

  it('virtualizes large folders', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `Daily/${String(i).padStart(4, '0')}.md`);
    useUi.setState({ expanded: { Daily: true } });
    renderExplorer(tree(['Welcome.md', ...many]));
    expect(rows().length).toBeLessThan(100);
    const spacer = screen.getByRole('tree').firstElementChild as HTMLElement;
    expect(parseInt(spacer.style.height, 10)).toBeGreaterThan(2000 * 28);
  });
});
