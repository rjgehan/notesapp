import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { GraphResponse, TreeResponse } from '../../api/types';
import { registeredPages, registeredPanels } from '../../extensions';
import { registerBuiltins } from '../../extensions/builtins';
import { getCommand } from '../../features/commands';
import { DEFAULT_GRAPH_OPTIONS, DEFAULT_LOCAL_OPTIONS } from '../../features/graph/options';
import { useGraphOptions } from '../../features/graph/store';
import { fetchGraph, GRAPH_REFRESH_MS } from '../../features/graph/useGraphData';
import LocalGraphPanel from '../panels/LocalGraphPanel';
import GraphPage from './GraphPage';

const graph: GraphResponse = {
  version: 'v1',
  unchanged: false,
  nodes: [
    { path: 'Hub.md', type: 'note', tags: ['project'] },
    { path: 'A.md', type: 'note', tags: [] },
    { path: 'Daily/B.md', type: 'note', tags: ['daily'] },
    { path: 'pic.png', type: 'attachment', tags: [] },
    { path: 'Someday', type: 'unresolved', tags: [] },
  ],
  edges: [0, 1, 1, 1, 0, 1, 0, 2, 1, 2, 3, 1, 1, 4, 1],
};

function renderWithClient(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no canvas: the graph draws nothing, and everything else still runs.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  useGraphOptions.setState({ global: { ...DEFAULT_GRAPH_OPTIONS }, local: { ...DEFAULT_LOCAL_OPTIONS } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('graph view (ROADMAP item 16)', () => {
  it('registers the page, the local graph panel and their commands', () => {
    registerBuiltins();
    expect(registeredPages().find((p) => p.route === 'graph')?.title).toBe('Graph');
    expect(registeredPanels('right').some((p) => p.id === 'graph')).toBe(true);
    expect(getCommand('page.graph')?.name).toBe('Open Graph');
    expect(getCommand('view.localGraph')?.name).toBe('Open local graph');
  });

  it('shows the graph with its counts and applies the filters', async () => {
    vi.spyOn(api, 'getGraph').mockResolvedValue(graph);
    renderWithClient(<GraphPage />);
    const canvas = await screen.findByRole('img', { name: 'Graph of 3 notes and 3 links' });
    expect(canvas).toBeInTheDocument();
    expect(screen.getByText(/3 notes · 3 links/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Attachments' }));
    expect(await screen.findByRole('img', { name: 'Graph of 3 notes and 4 links' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Existing files only' }));
    expect(await screen.findByRole('img', { name: 'Graph of 3 notes and 3 links' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: /Search files/ }), { target: { value: 'tag:project' } });
    expect(await screen.findByRole('img', { name: 'Graph of 1 notes and 0 links' })).toBeInTheDocument();
    expect(useGraphOptions.getState().global.search).toBe('tag:project');

    fireEvent.change(screen.getByRole('searchbox', { name: /Search files/ }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Only notes in folder' }), { target: { value: 'Daily' } });
    expect(await screen.findByRole('img', { name: 'Graph of 1 notes and 1 links' })).toBeInTheDocument();
  });

  it('adds, edits and removes color groups, and closes the settings', async () => {
    vi.spyOn(api, 'getGraph').mockResolvedValue(graph);
    renderWithClient(<GraphPage />);
    await screen.findByRole('img', { name: /Graph of/ });
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Group 1 query' }), { target: { value: 'tag:#daily' } });
    expect(useGraphOptions.getState().global.colorGroups).toEqual([{ query: 'tag:#daily', color: expect.stringMatching(/^#[0-9a-f]{6}$/) }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove group 1' }));
    expect(useGraphOptions.getState().global.colorGroups).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close graph settings' }));
    expect(screen.queryByRole('complementary', { name: 'Graph settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Graph settings' }));
    expect(screen.getByRole('complementary', { name: 'Graph settings' })).toBeInTheDocument();
  });

  it('says when the vault has no notes', async () => {
    vi.spyOn(api, 'getGraph').mockResolvedValue({ version: 'e', unchanged: false, nodes: [], edges: [] });
    renderWithClient(<GraphPage />);
    expect(await screen.findByText(/No notes yet/)).toBeInTheDocument();
  });

  it('keeps the graph it has when the server says it is unchanged, and refreshes after tree changes', async () => {
    const getGraph = vi.spyOn(api, 'getGraph').mockResolvedValueOnce(graph).mockResolvedValue({ version: 'v1', unchanged: true, nodes: [], edges: [] });
    queryClient.setQueryData(queryKeys.graph(), await fetchGraph());
    const kept = await fetchGraph();
    expect(kept).toBe(graph);
    expect(getGraph).toHaveBeenLastCalledWith('v1');

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithClient(<GraphPage />);
    await screen.findByRole('img', { name: /Graph of 3 notes/ });
    const calls = getGraph.mock.calls.length;
    const tree: TreeResponse = { eventId: 'b.1', folders: [], files: [] };
    act(() => {
      queryClient.setQueryData(queryKeys.tree(), tree);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GRAPH_REFRESH_MS + 50);
    });
    await waitFor(() => expect(getGraph.mock.calls.length).toBe(calls + 1));
    expect(screen.getByRole('img', { name: /Graph of 3 notes/ })).toBeInTheDocument();
  });

  it('shows the local graph of the open note and changes its depth', async () => {
    vi.spyOn(api, 'getGraph').mockResolvedValue(graph);
    renderWithClient(<LocalGraphPanel activePath="Daily/B.md" />);
    expect(await screen.findByRole('img', { name: 'Local graph: 2 nodes, 1 links' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Depth/), { target: { value: '2' } });
    expect(await screen.findByRole('img', { name: 'Local graph: 3 nodes, 2 links' })).toBeInTheDocument();
    expect(useGraphOptions.getState().local.depth).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Local graph settings' }));
    fireEvent.click(screen.getByLabelText('Attachments'));
    expect(await screen.findByRole('img', { name: 'Local graph: 4 nodes, 3 links' })).toBeInTheDocument();
    // Outgoing links only: Daily/B.md links to pic.png, and Hub.md only links to it.
    fireEvent.click(screen.getByLabelText('Incoming links'));
    expect(await screen.findByRole('img', { name: 'Local graph: 2 nodes, 1 links' })).toBeInTheDocument();
  });

  it('explains an empty local graph', async () => {
    vi.spyOn(api, 'getGraph').mockResolvedValue(graph);
    const { rerender } = renderWithClient(<LocalGraphPanel activePath={null} />);
    expect(screen.getByText('Open a note to see its local graph.')).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LocalGraphPanel activePath="Elsewhere.md" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('This file is not in the graph.')).toBeInTheDocument();
  });
});
