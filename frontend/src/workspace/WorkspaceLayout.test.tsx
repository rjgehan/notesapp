import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry } from '../api/types';
import { registerBuiltins } from '../extensions/builtins';
import { setNavigator } from '../features/navigation';
import { DEFAULT_SETTINGS } from '../features/settings';
import { basenameOf, extensionOf, lastSegment } from '../features/paths';
import { activeTabOf, createWorkspace, openTab, split } from './model';
import { resetWorkspace, workspace } from './store';
import { WorkspaceLayout } from './WorkspaceLayout';

function entry(path: string): FileEntry {
  return { path, name: lastSegment(path), basename: basenameOf(path), extension: extensionOf(path), kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] };
}

const navigate = vi.fn();

beforeEach(() => {
  registerBuiltins();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: ['Welcome.md'].map(entry) });
  queryClient.setQueryData(queryKeys.settings(), { version: 'v', settings: DEFAULT_SETTINGS });
  navigate.mockReset();
  setNavigator(navigate);
  // Desktop width: panes with tab strips.
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: q.includes('min-width: 1200px') || q.includes('min-width: 768px'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <WorkspaceLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WorkspaceLayout', () => {
  it('renders each pane’s shown tab; an inactive pane navigates its own tab, not the URL', async () => {
    let ws = createWorkspace('/nowhere');
    const left = ws.activePane;
    ws = split(ws, left, 'right');
    const right = ws.activePane;
    // The right pane shows `/`, which redirects to Welcome.md inside that pane.
    ws = { ...ws, panes: { ...ws.panes, [right]: { ...ws.panes[right], tabs: [{ ...activeTabOf(ws.panes[right]), route: '/' }] } }, activePane: left };
    ws = openTab(ws, '/n/Welcome.md', { pane: left, background: true });
    resetWorkspace(ws);
    renderAt('/nowhere');
    expect(document.querySelectorAll('.ws-pane')).toHaveLength(2);
    await waitFor(() => expect(activeTabOf(workspace().panes[right]).route).toBe('/n/Welcome.md'));
    expect(navigate).not.toHaveBeenCalled();
    // Only shown tabs mount: the left pane's Welcome tab has no view yet.
    expect(document.querySelectorAll('.ws-pane')[0].querySelector('.markdown-view')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['/nowhere', 'Welcome', 'Welcome']);
  });

  it('a pointer in another pane makes it active and puts its route in the URL', () => {
    let ws = createWorkspace('/zzz-left');
    const left = ws.activePane;
    ws = split(ws, left, 'right');
    resetWorkspace(ws);
    renderAt('/zzz-left');
    const panes = document.querySelectorAll('.ws-pane');
    act(() => {
      fireEvent.pointerDown(panes[0].querySelector('.workspace-scroll')!);
    });
    expect(workspace().activePane).toBe(left);
    expect(document.querySelectorAll('.ws-pane')[0].classList.contains('is-active')).toBe(true);
  });

  it('closes a tab from its × and selects its neighbour', () => {
    let ws = createWorkspace('/zzz-a');
    ws = openTab(ws, '/zzz-b');
    resetWorkspace(ws);
    renderAt('/zzz-b');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Close /zzz-b' }));
    });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['/zzz-a']);
    expect(navigate).toHaveBeenCalledWith('/zzz-a', { replace: true });
  });
});
