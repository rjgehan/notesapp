import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEndpoints } from '../../api/endpoints';
import { createMockEndpoints } from '../../api/mock';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { FileEntry } from '../../api/types';
import { el, scene } from '../../test/drawings';
import DrawingEmbed from './DrawingEmbed';
import type { DrawingSvg, DrawingSvgOptions } from './svg';

// The export itself needs a browser (svg.test.ts covers it); here it reports what it was asked.
const svgs = vi.hoisted(() => ({ calls: [] as Array<{ path: string; text: string; dark: boolean }>, next: null as DrawingSvg | null }));

vi.mock('./svg', () => ({
  DARK_FILTER: 'invert(93%) hue-rotate(180deg)',
  renderDrawingSvg: vi.fn(async (path: string, text: string, opts: DrawingSvgOptions): Promise<DrawingSvg> => {
    svgs.calls.push({ path, text, dark: opts.dark });
    return svgs.next ?? { kind: 'svg', svg: `<svg xmlns="http://www.w3.org/2000/svg" data-n="${svgs.calls.length}"/>`, width: 640.4, height: 320 };
  }),
}));

let vault: MockVault;
let urls: number;
const revoked: string[] = [];

function entry(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name, extension: 'excalidraw', kind: path.endsWith('.md') ? 'note' : 'text', size: 1, mtime: '2026-10-17T10:00:00.000Z', version: null, aliases: [] };
}

function show(path: string, content: string | null, props: { width?: number; height?: number; display?: string } = {}) {
  if (content !== null) vault.createFile({ path, content }, 'other-device-1');
  queryClient.setQueryData(queryKeys.tree(), vault.getTree());
  return render(
    <QueryClientProvider client={queryClient}>
      <DrawingEmbed path={path} entry={entry(path)} sourcePath="Notes/Plan.md" depth={1} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vault = new MockVault(false);
  installEndpoints(createMockEndpoints(vault, { latency: 0, failures: [] }));
  svgs.calls = [];
  svgs.next = null;
  urls = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:drawing-${++urls}`);
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  document.documentElement.setAttribute('data-theme', 'light');
});

afterEach(() => {
  queryClient.clear();
});

describe('DrawingEmbed', () => {
  it('shows the drawing as an SVG image that opens the editor', async () => {
    show('Diagrams/House.excalidraw', JSON.stringify(scene([el('a')])), { display: 'The house' });
    const img = await screen.findByRole('img', { name: 'The house' });
    expect(img).toHaveAttribute('src', 'blob:drawing-1');
    // Its own size, which CSS caps at the column width.
    expect(img).toHaveAttribute('width', '640');
    expect(img.style.filter).toBe('');
    const link = img.closest('a')!;
    expect(link).toHaveClass('internal-link', 'drawing-embed');
    expect(link).toHaveAttribute('data-href', 'Diagrams/House.excalidraw');
    expect(link).toHaveAttribute('href', '/n/Diagrams/House.excalidraw');
    expect(svgs.calls[0]).toMatchObject({ path: 'Diagrams/House.excalidraw', dark: false });
    expect(JSON.parse(svgs.calls[0].text).elements[0].id).toBe('a');
  });

  it('honours |W and |WxH', async () => {
    show('A.excalidraw', JSON.stringify(scene([el('a')])), { width: 400 });
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('width', '400');
    expect(img).not.toHaveAttribute('height');
    show('B.excalidraw', JSON.stringify(scene([el('b')])), { width: 300, height: 200 });
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    const fixed = screen.getAllByRole('img')[1];
    expect(fixed).toHaveAttribute('width', '300');
    expect(fixed).toHaveAttribute('height', '200');
    expect(fixed).toHaveClass('is-fixed');
    // The stylesheet's `height: auto` keeps a box of that shape (also when the column narrows it).
    expect(fixed.style.aspectRatio).toBe('300 / 200');
    expect(img.style.aspectRatio).toBe('');
  });

  it('follows the theme and the file, and releases replaced images', async () => {
    show('A.excalidraw', JSON.stringify(scene([el('a')])));
    await screen.findByRole('img');
    act(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:drawing-2'));
    expect(svgs.calls[1].dark).toBe(true);
    expect(screen.getByRole('img').style.filter).toBe('invert(93%) hue-rotate(180deg)');
    // The release runs in a passive effect's cleanup, which React may flush just after the new image is committed.
    await waitFor(() => expect(revoked).toEqual(['blob:drawing-1']));

    // Another device's change reaches the embed through the file query (live sync refreshes it).
    vault.externalWrite('A.excalidraw', JSON.stringify(scene([el('a'), el('b')])));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.file('A.excalidraw') }));
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:drawing-3'));
    expect(JSON.parse(svgs.calls[2].text).elements.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
    await waitFor(() => expect(revoked).toEqual(['blob:drawing-1', 'blob:drawing-2']));
  });

  it('says when a drawing is empty, unreadable or missing, and still links to it', async () => {
    svgs.next = { kind: 'empty' };
    show('Empty.excalidraw', '');
    expect(await screen.findByText('Empty.excalidraw is empty.')).toBeInTheDocument();
    expect(screen.getByText('Empty.excalidraw is empty.').closest('a')).toHaveAttribute('data-href', 'Empty.excalidraw');
    svgs.next = { kind: 'unreadable', message: 'x' };
    show('Bad.excalidraw', '{');
    expect(await screen.findByText('Bad.excalidraw could not be read as a drawing.')).toBeInTheDocument();
    show('Gone.excalidraw', null);
    expect(await screen.findByText('Could not load this drawing.', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
