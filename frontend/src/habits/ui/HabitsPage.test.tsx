import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { HabitsResponse, SaveFileRequest, TextFile, WriteResult } from '../../api/types';
import { EMPTY_TREE } from '../../api/vaultTree';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { habitApi } from '../api';
import { getProperty } from '../frontmatterEdit';
import { todayString } from '../progress';
import { editNote } from '../write';
import HabitsPage from './HabitsPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  habitApi: { list: vi.fn() },
}));

const today = todayString();
const files = new Map<string, string>();
let version = 0;

function textFile(path: string): TextFile {
  return { path, content: files.get(path)!, version: `v${version}`, mtime: '2026-10-21T00:00:00.000Z', size: 1, lossy: false } as TextFile;
}

function response(): HabitsResponse {
  return {
    folder: 'Habits',
    tag: 'habit',
    habits: [
      { path: 'Habits/Exercise.md', version: 'v1', properties: { entries: getProperty(files.get('Habits/Exercise.md')!, 'entries') } },
      { path: 'Habits/Read.md', version: 'v1', properties: { title: 'Read 20 pages', property: 'read', entries: getProperty(files.get('Habits/Read.md')!, 'entries') } },
    ],
    dailyFolder: 'Daily',
    daily: [{ path: `Daily/${today}.md`, values: { read: getProperty(files.get(`Daily/${today}.md`)!, 'read') as boolean } }],
  };
}

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <HabitsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), EMPTY_TREE);
  queryClient.setQueryData(queryKeys.settings(), { settings: DEFAULT_SETTINGS, version: 'v', readOnly: false });
  files.set('Habits/Exercise.md', '---\nentries: []\n---\nWhy.\n');
  files.set('Habits/Read.md', '---\ntitle: Read 20 pages\nproperty: read\nentries: []\n---\n');
  files.set(`Daily/${today}.md`, '---\nread: true\nmood: 3\n---\nNotes.\n');
  vi.mocked(habitApi.list).mockImplementation(async () => response());
  vi.spyOn(api, 'readFile').mockImplementation(async (path: string) => textFile(path));
  vi.spyOn(api, 'saveFile').mockImplementation(async (path: string, req: SaveFileRequest) => {
    if (req.baseVersion !== `v${version}`) throw new ApiError({ type: 'urn:notesapp:problem:version-conflict', title: 'Version conflict', status: 409, code: 'version-conflict' } as never);
    files.set(path, req.content);
    version++;
    return { file: { path, version: `v${version}` }, created: false, createdFolders: [] } as unknown as WriteResult;
  });
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe('HabitsPage', () => {
  it('lists the habits and checks one in with a tap', async () => {
    renderAt('/x/habits');
    const exercise = await screen.findByRole('button', { name: 'Exercise, today' });
    expect(exercise).toHaveAttribute('aria-pressed', 'false');
    // Read 20 pages is checked in by today's daily note.
    expect(screen.getByRole('button', { name: 'Read 20 pages, today' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Today: 1 of 2 done')).toBeInTheDocument();
    fireEvent.click(exercise);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exercise, today' })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(files.get('Habits/Exercise.md')).toBe(`---\nentries:\n  - ${today}\n---\nWhy.\n`));
  });

  it('unchecks a daily-note check-in in the daily note', async () => {
    renderAt('/x/habits');
    fireEvent.click(await screen.findByRole('button', { name: 'Read 20 pages, today' }));
    await waitFor(() => expect(files.get(`Daily/${today}.md`)).toBe('---\nread: false\nmood: 3\n---\nNotes.\n'));
    expect(files.get('Habits/Read.md')).toBe('---\ntitle: Read 20 pages\nproperty: read\nentries: []\n---\n');
  });

  it('shows how to start without habits', async () => {
    vi.mocked(habitApi.list).mockResolvedValue({ ...response(), habits: [] });
    renderAt('/x/habits');
    expect(await screen.findByText('No habits yet')).toBeInTheDocument();
  });

  it('shows one habit with its calendar', async () => {
    renderAt('/x/habits?habit=Habits%2FRead.md');
    expect(await screen.findByText('Done today')).toBeInTheDocument();
    expect(screen.getByText('Current streak')).toBeInTheDocument();
    const grid = screen.getAllByRole('grid')[0];
    expect(within(grid).getAllByRole('row')).toHaveLength(53);
  });
});

describe('editNote', () => {
  it('re-applies an edit to the newer text after a conflict', async () => {
    let first = true;
    vi.mocked(api.readFile).mockImplementation(async (path: string) => {
      const file = textFile(path);
      if (first) {
        first = false;
        // Another device saves between this read and the save.
        files.set(path, files.get(path)!.replace('Why.', 'Why: energy.'));
        version++;
      }
      return file;
    });
    await editNote('Habits/Exercise.md', (t) => t.replace('entries: []', 'entries:\n  - 2026-10-20'));
    expect(files.get('Habits/Exercise.md')).toBe('---\nentries:\n  - 2026-10-20\n---\nWhy: energy.\n');
    expect(api.saveFile).toHaveBeenCalledTimes(2);
  });
});
