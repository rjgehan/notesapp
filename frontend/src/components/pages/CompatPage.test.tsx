import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import type { CompatReport, SettingsResponse } from '../../api/types';
import { registeredPages } from '../../extensions';
import { registerBuiltins } from '../../extensions/builtins';
import { DEFAULT_GRAPH_OPTIONS, DEFAULT_LOCAL_OPTIONS } from '../../features/graph/options';
import { useGraphOptions } from '../../features/graph/store';
import { navigateTo } from '../../features/navigation';
import { DEFAULT_SETTINGS } from '../../features/settings';
import CompatPage from './CompatPage';

vi.mock('../../features/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/navigation')>()),
  navigateTo: vi.fn(),
}));

const settings: SettingsResponse = { settings: DEFAULT_SETTINGS, version: 'v-settings', readOnly: false };

function report(overrides: Partial<CompatReport> = {}): CompatReport {
  const proposed = structuredClone(DEFAULT_SETTINGS);
  proposed.dailyNotes.folder = 'Journal';
  return {
    generatedAt: new Date().toISOString(),
    tookMs: 12,
    obsidian: { found: true, configFiles: ['app.json', 'daily-notes.json', 'graph.json'], problems: ['templates.json is not valid JSON'] },
    settings: [
      { source: 'daily-notes.json › folder', obsidianValue: '"Journal"', setting: 'dailyNotes.folder', current: 'Daily', proposed: 'Journal', status: 'different', note: null },
      { source: 'app.json › newLinkFormat', obsidianValue: '"shortest"', setting: 'files.newLinkFormat', current: 'shortest', proposed: 'shortest', status: 'same', note: null },
      { source: 'app.json › attachmentFolderPath', obsidianValue: '"./a/b"', setting: 'files.attachmentLocation', current: 'folder Attachments', proposed: null, status: 'unsupported', note: 'A single folder name' },
    ],
    proposedSettings: proposed,
    settingsVersion: 'v-settings',
    graph: { showArrow: true, colorGroups: [{ query: 'tag:#project', color: { a: 1, rgb: 14701138 } }], linkDistance: 180 },
    plugins: [
      { id: 'templater-obsidian', name: 'Templater', kind: 'community', status: 'unsupported', note: '<% %> stays as text.', roadmapItem: null },
      { id: 'dataview', name: 'Dataview', kind: 'community', status: 'planned', note: 'Queries show as code blocks.', roadmapItem: 40 },
    ],
    issues: [
      {
        id: 'dataview',
        category: 'syntax',
        severity: 'warning',
        title: 'Dataview queries',
        detail: 'Shown as code.',
        roadmapItem: 40,
        count: 3,
        noteCount: 2,
        occurrences: [
          { path: 'Home.md', line: 19, text: '`= this.file.ctime`' },
          { path: 'Projects/Plan.md', line: 6, text: '```dataview' },
        ],
        truncated: true,
      },
      { id: 'missing-notes', category: 'links', severity: 'info', title: 'Links to notes that do not exist yet', detail: 'Creates the note.', roadmapItem: null, count: 1, noteCount: 1, occurrences: [{ path: 'Home.md', line: 8, text: '[[Someday]]' }], truncated: false },
      { id: 'canvas', category: 'files', severity: 'info', title: 'Canvases', detail: 'Planned.', roadmapItem: 25, count: 1, noteCount: 1, occurrences: [{ path: 'Map.canvas', line: null, text: 'Map.canvas' }], truncated: false },
    ],
    totals: { notes: 9, files: 12, errors: 0, warnings: 3, infos: 2 },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CompatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, 'getSettings').mockResolvedValue(settings);
  useGraphOptions.setState({ global: { ...DEFAULT_GRAPH_OPTIONS }, local: { ...DEFAULT_LOCAL_OPTIONS } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(navigateTo).mockReset();
  queryClient.clear();
});

describe('CompatPage (ROADMAP item 24)', () => {
  it('is registered as a page', () => {
    registerBuiltins();
    expect(registeredPages().find((p) => p.route === 'compat')?.title).toBe('Compatibility report');
  });

  it('shows the summary, the settings, the plugins and the findings', async () => {
    vi.spyOn(api, 'getCompat').mockResolvedValue(report());
    renderPage();
    expect(await screen.findByText(/0 errors/)).toBeInTheDocument();
    expect(screen.getByText(/3 warnings/)).toBeInTheDocument();
    expect(screen.getByText(/never changes it/)).toBeInTheDocument();
    expect(screen.getByText('templates.json is not valid JSON')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('daily-notes.json › folder')).toBeInTheDocument();
    expect(within(table).getByText('Journal')).toBeInTheDocument();
    expect(within(table).getByText('In effect')).toBeInTheDocument();
    expect(within(table).getByText('Not used')).toBeInTheDocument();
    expect(screen.getByText(/1 setting of .obsidian\/ differs/)).toBeInTheDocument();

    const plugins = screen.getByRole('region', { name: 'Plugins' });
    expect(within(plugins).getByText('Templater')).toBeInTheDocument();
    expect(within(plugins).getByText('Not supported')).toBeInTheDocument();
    expect(within(plugins).getByText('Roadmap 40')).toBeInTheDocument();

    const syntax = screen.getByRole('region', { name: 'Syntax and plugins in notes' });
    expect(within(syntax).getByText('Dataview queries')).toBeInTheDocument();
    expect(within(syntax).getByText('3 in 2 files')).toBeInTheDocument();
    expect(within(syntax).getByText('The first 2 are listed.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Links' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Files' })).toBeInTheDocument();
  });

  it('opens a finding at its line', async () => {
    vi.spyOn(api, 'getCompat').mockResolvedValue(report());
    renderPage();
    fireEvent.click(await screen.findByText('[[Someday]]'));
    expect(navigateTo).toHaveBeenCalledWith('/n/Home.md?line=8');
    fireEvent.click(screen.getAllByText('Map.canvas')[0]!);
    expect(navigateTo).toHaveBeenLastCalledWith('/n/Map.canvas');
  });

  it("applies Obsidian's settings with the report's settings version", async () => {
    vi.spyOn(api, 'getCompat').mockResolvedValue(report());
    const put = vi.spyOn(api, 'putSettings').mockResolvedValue({ ...settings, version: 'v2' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: "Apply Obsidian's settings" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const request = put.mock.calls[0]![0];
    expect(request.baseVersion).toBe('v-settings');
    expect(request.settings.dailyNotes.folder).toBe('Journal');
  });

  it('says so when the settings changed meanwhile', async () => {
    const getCompat = vi.spyOn(api, 'getCompat').mockResolvedValue(report());
    vi.spyOn(api, 'putSettings').mockRejectedValue(
      new ApiError({ type: 'urn:notesapp:problem:version-conflict', title: 'Conflict', status: 409, code: 'version-conflict', detail: 'changed' }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: "Apply Obsidian's settings" }));
    await waitFor(() => expect(getCompat).toHaveBeenCalledTimes(2));
  });

  it("takes Obsidian's graph settings for this device", async () => {
    vi.spyOn(api, 'getCompat').mockResolvedValue(report());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Use them on this device' }));
    const global = useGraphOptions.getState().global;
    expect(global.showArrow).toBe(true);
    expect(global.linkDistance).toBe(180);
    expect(global.colorGroups).toEqual([{ query: 'tag:#project', color: '#e05252' }]);
  });

  it('reports a vault without .obsidian and without findings', async () => {
    vi.spyOn(api, 'getCompat').mockResolvedValue(
      report({ obsidian: { found: false, configFiles: [], problems: [] }, settings: [], proposedSettings: null, graph: null, plugins: [], issues: [] }),
    );
    renderPage();
    expect(await screen.findByText(/no .obsidian\/ folder/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing to report/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('works against the mock API', async () => {
    const vault = new MockVault();
    const mock = vault.getCompat();
    expect(mock.obsidian.found).toBe(false);
    expect(mock.issues.every((i) => i.category === 'links')).toBe(true);
  });
});
