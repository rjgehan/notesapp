// Spreadsheet embeds (DESIGN §6.21.7): the table, sheet, range and named-range targets, number
// formats, charts and clicks, from the file's cached values. HyperFormula and Glide are replaced
// by modules that fail to load, so a test fails if an embed ever pulls them in.
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { httpEndpoints, installEndpoints } from '../../api/endpoints';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import type { FileEntry } from '../../api/types';
import { openPath } from '../../features/navigation';
import { hydrateEmbeds, unmountEmbeds } from '../../render/embeds';
import { renderNoteHtml } from '../../render/render';
import { fakeApi } from '../../test/fakes';
import { registerSheetView } from './register';
import SheetEmbed, { EMBED_ROWS } from './SheetEmbed';

vi.mock('hyperformula', () => {
  throw new Error('An embed must not load the formula engine.');
});
vi.mock('@glideapps/glide-data-grid', () => {
  throw new Error('An embed must not load the grid.');
});
vi.mock('../../features/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/navigation')>()),
  openPath: vi.fn(),
}));

const BUDGET = {
  type: 'notesapp-sheet',
  version: 1,
  engine: 'hyperformula@3.4.0',
  sheets: [
    {
      id: 's1',
      name: 'Budget',
      cells: {
        A1: { v: 'Item' },
        B1: { v: 'Cost' },
        A2: { v: 'Rent' },
        B2: { v: 1450 },
        A3: { v: 'Food' },
        B3: { v: 487.5 },
        A4: { v: 'Total' },
        B4: { f: '=SUM(B2:B3)', c: 1937.5 },
        C4: { f: '=1/0', c: { e: '#DIV/0!' } },
      },
      cols: { B: { w: 110, fmt: '$#,##0.00' } },
      rows: { '1': { bold: true } },
      charts: { c1: { type: 'bar', range: 'A1:B3', title: 'Costs', headers: true, labels: true } },
    },
    { id: 's2', name: 'Summary', cells: { A1: { v: 'Share' }, B1: { v: 0.75, fmt: '0%' } } },
  ],
  named: { Total: 'Budget!$B$4' },
};

const vault = new MockVault(false);
let count = 0;

beforeAll(() => {
  const fake = fakeApi(vault);
  installEndpoints({ ...httpEndpoints, readFile: fake.api.readFile });
  registerSheetView();
});

afterEach(() => {
  queryClient.clear();
  vi.mocked(openPath).mockClear();
});

function entry(path: string): FileEntry {
  const f = vault.readFile(path);
  return { path, name: path, basename: path.replace(/\.sheet$/, ''), extension: 'sheet', kind: 'text', size: f.content.length, mtime: '2026-10-17T10:00:00.000Z', version: f.version, aliases: [] };
}

function create(content: unknown = BUDGET): string {
  const path = `Money/Budget ${++count}.sheet`;
  vault.createFile({ path, content: typeof content === 'string' ? content : JSON.stringify(content) }, 'other-device-1');
  return path;
}

function show(path: string, subpath?: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SheetEmbed path={path} entry={entry(path)} subpath={subpath} sourcePath="Notes/Plan.md" depth={1} />
    </QueryClientProvider>,
  );
}

const rows = (el: HTMLElement) => [...el.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

describe('SheetEmbed', () => {
  it('shows the first sheet’s used range from the cached values, in its number formats', async () => {
    const view = show(create());
    const table = await screen.findByRole('table');
    expect(rows(table)).toEqual([
      ['Item', 'Cost', ''],
      ['Rent', '$1,450.00', ''],
      ['Food', '$487.50', ''],
      ['Total', '$1,937.50', '#DIV/0!'],
    ]);
    const cells = table.querySelectorAll('td');
    expect(cells[4].className).toContain('align-right');
    expect(cells[11].className).toContain('is-error');
    expect(table.querySelector('tr')?.className).toBe('is-bold');
    expect(table.querySelectorAll('col')[1].style.width).toBe('110px');
    // A whole sheet shows its charts.
    expect(view.container.querySelector('figure.sheet-chart')?.getAttribute('aria-label')).toBe('Bar chart: Costs');
  });

  it('shows a named sheet, a range and a named range', async () => {
    const path = create();
    const sheet = show(path, 'summary');
    expect(rows(await screen.findByRole('table'))).toEqual([['Share', '75%']]);
    sheet.unmount();
    const range = show(path, 'Budget!A2:B3');
    expect(rows(await screen.findByRole('table'))).toEqual([
      ['Rent', '$1,450.00'],
      ['Food', '$487.50'],
    ]);
    // A range shows no charts.
    expect(range.container.querySelector('figure')).toBeNull();
    range.unmount();
    show(path, 'Total');
    expect(rows(await screen.findByRole('table'))).toEqual([['$1,937.50']]);
  });

  it('says what it cannot show', async () => {
    const path = create();
    show(path, 'Nowhere');
    expect(await screen.findByText('“Nowhere” is not a sheet, named range or range in this spreadsheet.')).toBeInTheDocument();
    show(create('{"type": "something else"}'));
    expect(await screen.findByText(/cannot be shown as a spreadsheet/)).toBeInTheDocument();
    show(create({ ...BUDGET, sheets: [{ id: 's1', name: 'Empty', cells: {} }] }));
    expect(await screen.findByText('This sheet is empty.')).toBeInTheDocument();
  });

  it('shows at most 100 rows of a large sheet and says so', async () => {
    const cells: Record<string, unknown> = {};
    for (let i = 1; i <= 150; i++) cells[`A${i}`] = { v: i };
    show(create({ ...BUDGET, sheets: [{ id: 's1', name: 'Long', cells }] }));
    const table = await screen.findByRole('table');
    expect(table.querySelectorAll('tr')).toHaveLength(EMBED_ROWS);
    expect(screen.getByText('Showing A1:A100 of A1:A150. Open the spreadsheet for the rest.')).toBeInTheDocument();
  });

  it('opens the spreadsheet at its target on a click, and lets the host ignore the click', async () => {
    const path = create();
    // The host (the reading view) listens above the embed's own root.
    const outer = vi.fn();
    document.body.addEventListener('click', outer);
    show(path, 'Budget!A2:B3');
    const table = await screen.findByRole('table');
    fireEvent.click(table.querySelector('td')!);
    expect(openPath).toHaveBeenCalledWith(path, 'Budget!A2:B3');
    fireEvent.click(screen.getByRole('link'));
    expect(openPath).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
    // A modified click on the link is the browser's (a new tab).
    fireEvent.click(screen.getByRole('link'), { ctrlKey: true });
    expect(openPath).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/n/Money/Budget%20${count}.sheet#Budget!A2%3AB3`);
    document.body.removeEventListener('click', outer);
  });

  it('follows the file when another device changes it', async () => {
    const path = create();
    show(path);
    await screen.findByRole('table');
    const changed = structuredClone(BUDGET);
    changed.sheets[0].cells.A2 = { v: 'Mortgage' };
    vault.saveFile(path, { content: JSON.stringify(changed), baseVersion: vault.readFile(path).version }, 'other-device-1');
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['file', path] });
    });
    await waitFor(() => expect(rows(screen.getByRole('table'))[1][0]).toBe('Mortgage'));
  });
});

describe('embedding through the reading view', () => {
  it('renders ![[x.sheet#Sheet!range]] as a placeholder that the sheet view hydrates', async () => {
    const path = create();
    const e = entry(path);
    const html = renderNoteHtml(`Costs:\n\n![[${path}#Budget!A1:B2]]\n`, {
      sourcePath: 'Notes/Plan.md',
      resolve: (t) => (t === path ? e : null),
      rawUrl: () => '',
      strictLineBreaks: false,
      loadRemoteImages: false,
      depth: 0,
    });
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const placeholder = container.querySelector<HTMLElement>('[data-embed-kind]')!;
    expect(placeholder.dataset.embedKind).toBe('file');
    expect(placeholder.dataset.embedSubpath).toBe('Budget!A1:B2');
    act(() => hydrateEmbeds(container, { sourcePath: 'Notes/Plan.md', depth: 0, entry: (p) => (p === path ? e : undefined), rawUrl: () => '' }));
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull(), { timeout: 5000 });
    expect(rows(container.querySelector('table')!)).toEqual([
      ['Item', 'Cost'],
      ['Rent', '$1,450.00'],
    ]);
    act(() => unmountEmbeds(container));
    container.remove();
  });
});
