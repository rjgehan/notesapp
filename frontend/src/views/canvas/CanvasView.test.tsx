import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, httpEndpoints, installEndpoints } from '../../api/endpoints';
import { createMockEndpoints } from '../../api/mock';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import type { FileEntry } from '../../api/types';
import CanvasEmbed from './CanvasEmbed';
import CanvasView from './CanvasView';
import { OBSIDIAN_SAMPLE } from './fixtures.test-data';

let vault: MockVault;

beforeAll(() => {
  // jsdom lays nothing out: give elements a size so the board fits and culls as in a browser.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  installEndpoints(httpEndpoints);
});

afterEach(() => {
  queryClient.clear();
});

function entry(path: string): FileEntry {
  return vault.getTree().files.find((f) => f.path === path)!;
}

function setupVault(): void {
  vault = new MockVault(false);
  vault.createFile({ path: 'Projects/Plan.md', content: '# Plan\n\nThe plan.\n' }, 'other-device-1');
  vault.createFile({ path: 'Board.canvas', content: OBSIDIAN_SAMPLE }, 'other-device-1');
  installEndpoints(createMockEndpoints(vault, { latency: 0, failures: [] }));
}

function renderWithApp(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/n/Board.canvas']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CanvasView', () => {
  it('draws the board, edits it and saves the file', async () => {
    setupVault();
    expect(api.readFile).toBeDefined();
    const { container } = renderWithApp(<CanvasView path="Board.canvas" entry={entry('Board.canvas')} mode="edit" />);
    await waitFor(() => expect(container.querySelectorAll('[data-node-id]')).toHaveLength(5));
    // Cards render Markdown, file nodes their note, groups their label; edges and their labels draw.
    expect(container.querySelector('[data-node-id="59e896bc8da20699"] .canvas-markdown')?.textContent).toContain('Learn more');
    await waitFor(() => expect(container.querySelector('[data-node-id="8132d4d894c80022"] .canvas-markdown')?.textContent).toContain('The plan.'));
    expect(screen.getByText('Project board')).toBeInTheDocument();
    expect(container.querySelectorAll('.canvas-edge')).toHaveLength(2);
    expect(screen.getByText('see also')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add card' }));
    await waitFor(() => expect(container.querySelectorAll('[data-node-id]')).toHaveLength(6));
    expect(container.querySelector('.canvas-card-editor')).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    const saved = JSON.parse(vault.readFile('Board.canvas').content) as { nodes: Array<{ type: string; text?: string }>; metadata: unknown };
    expect(saved.nodes).toHaveLength(6);
    expect(saved.nodes[5]).toMatchObject({ type: 'text', text: '' });
    // Unknown top-level data survived.
    expect(saved.metadata).toEqual({ version: '1.0-1.0', frontmatter: {} });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(vault.readFile('Board.canvas').content).toBe(OBSIDIAN_SAMPLE);
  });

  it('offers to edit the file as text when it is not a canvas', async () => {
    setupVault();
    vault.saveFile('Board.canvas', { content: '{ nope', baseVersion: vault.readFile('Board.canvas').version }, 'other-device-1');
    renderWithApp(<CanvasView path="Board.canvas" entry={entry('Board.canvas')} mode="edit" />);
    expect(await screen.findByText('This canvas could not be read.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit as text' }));
    expect(await screen.findByText('Editing the canvas file as text.')).toBeInTheDocument();
  });
});

describe('CanvasEmbed', () => {
  it('previews a canvas inside a note and links to it', async () => {
    setupVault();
    const { container } = renderWithApp(<CanvasEmbed path="Board.canvas" entry={entry('Board.canvas')} sourcePath="Projects/Plan.md" depth={1} />);
    await waitFor(() => expect(container.querySelectorAll('.canvas-preview .canvas-node')).toHaveLength(5));
    expect(container.querySelectorAll('.canvas-preview .canvas-edge')).toHaveLength(2);
    expect(container.querySelector('a.internal-link')?.getAttribute('data-href')).toBe('Board.canvas');
    expect(container.textContent).toContain('Learn more');
  });
});
