import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { FileText } from 'lucide-react';
import { useEffect } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry } from '../api/types';
import { navigateTo, setNavigator } from '../features/navigation';
import { moveMap } from '../sync/instance';
import { moveEntry } from '../sync/treePatch';
import { FileView } from './FileView';
import { registerView, type FileViewProps } from './registry';

let mounts = 0;

function ProbeView({ path }: FileViewProps) {
  useEffect(() => {
    mounts++;
  }, []);
  return <div data-testid="probe">{path}</div>;
}

registerView({
  id: 'probe',
  match: (e) => (e.path.endsWith('.probe') ? 10 : 0),
  icon: FileText,
  textual: false,
  modes: ['read'],
  load: () => Promise.resolve({ default: ProbeView }),
});

function entry(path: string): FileEntry {
  return { path, name: path, basename: path, extension: 'probe', kind: 'other', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: null, aliases: [] };
}

function Bridge() {
  const navigate = useNavigate();
  useEffect(() => setNavigator((to, opts) => void navigate(to, opts)), [navigate]);
  return null;
}

afterEach(() => {
  queryClient.clear();
});

describe('FileView (FE-2, ux)', () => {
  it('keeps the view mounted when the open file is renamed, and mounts a new one for another file', async () => {
    queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [entry('a.probe'), entry('other.probe')] });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/n/a.probe']}>
          <Bridge />
          <FileView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('probe')).toHaveTextContent('a.probe');
    expect(mounts).toBe(1);
    // A rename of the open file (own MoveResult or entry.moved): tree, move map, then the route.
    act(() => {
      moveEntry(queryClient, 'a.probe', 'b.probe', 'file');
      moveMap.record('a.probe', 'b.probe', 'file');
      navigateTo('/n/b.probe', { replace: true });
    });
    expect(await screen.findByText('b.probe')).toBeInTheDocument();
    expect(mounts).toBe(1);
    act(() => navigateTo('/n/other.probe'));
    expect(await screen.findByText('other.probe')).toBeInTheDocument();
    expect(mounts).toBe(2);
  });
});
