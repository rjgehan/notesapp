import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { FileEntry } from '../../api/types';
import { availableCommands, runCommand, setViewCommandSource } from '../../features/commands';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { FakeDocument, FakeViewer, fakePdfLib, type FakeLib } from '../../test/pdf';
import { activePdf } from './active';
import PdfView from './PdfView';
import { pdfCommands, registerPdfView } from './register';

const lib = vi.hoisted(() => ({ current: null as FakeLib | null, fail: false }));

vi.mock('./pdfLib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdfLib')>()),
  loadPdfLib: () => (lib.fail ? Promise.reject(new Error('chunk failed')) : Promise.resolve(lib.current!.lib)),
}));

function entry(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name.slice(0, -4), extension: 'pdf', kind: 'pdf', size: 1234, mtime: '2026-10-17T10:00:00.000Z', version: null, aliases: [] };
}

const MANUAL = entry('Docs/Manual.pdf');

function show(hash = '', e = MANUAL) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/n/${e.path}${hash}`]}>
        <PdfView path={e.path} entry={e} mode="read" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let opened = 0;

/** Lets the next document load and PDF.js lay out its pages. */
async function open(pages = 12) {
  await waitFor(() => expect(lib.current!.tasks.length).toBeGreaterThan(opened));
  const task = lib.current!.tasks[opened++];
  await act(async () => {
    task.resolve(new FakeDocument(pages));
    await task.promise;
  });
  const viewer = FakeViewer.instances.at(-1)!;
  act(() => viewer.initPages());
  return viewer;
}

beforeEach(() => {
  lib.current = fakePdfLib();
  lib.fail = false;
  opened = 0;
  document.documentElement.setAttribute('data-theme', 'dark');
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'e.1', folders: [{ path: 'Docs', name: 'Docs' }], files: [MANUAL] });
  queryClient.setQueryData(queryKeys.settings(), { settings: DEFAULT_SETTINGS, version: 'v1', readOnly: false });
});

afterEach(() => {
  queryClient.clear();
});

describe('PdfView', () => {
  it('opens the document at the page of a #page=N link and remembers the page read last', async () => {
    const { unmount } = show('#page%3D3');
    await open();
    expect(lib.current!.tasks[0].url).toBe(`/api/files/raw?path=Docs%2FManual.pdf&v=1234-${Date.parse(MANUAL.mtime)}`);
    expect(screen.getByRole('textbox', { name: 'Page (1–12)' })).toHaveValue('3');
    expect(screen.getByText('/ 12')).toBeInTheDocument();
    act(() => {
      FakeViewer.instances[0].currentPageNumber = 8;
    });
    expect(screen.getByRole('textbox', { name: 'Page (1–12)' })).toHaveValue('8');
    unmount();
    expect(lib.current!.tasks[0].destroyed).toBe(true);

    show();
    const viewer = await open();
    expect(viewer.currentPageNumber).toBe(8);
  });

  it('goes to a typed page, zooms, and shows the zoom it is at', async () => {
    show();
    const viewer = await open();
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Page (1–12)' });
    await user.click(input);
    await user.clear(input);
    await user.type(input, '9x{Enter}');
    expect(viewer.currentPageNumber).toBe(9);
    // Out of range: ignored.
    await user.click(input);
    await user.clear(input);
    await user.type(input, '40{Enter}');
    expect(viewer.currentPageNumber).toBe(9);
    expect(input).toHaveValue('9');

    const zoom = screen.getByRole('combobox', { name: 'Zoom' });
    expect(zoom).toHaveValue('auto');
    await user.selectOptions(zoom, '1.5');
    expect(viewer.currentScaleValue).toBe('1.5');
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoom).toHaveValue('custom');
    expect(screen.getByRole('option', { name: '165 %' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(viewer.currentPageNumber).toBe(10);
  });

  it('finds in the PDF from the find bar and closes it with Escape', async () => {
    show();
    const viewer = await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Find in PDF' }));
    const field = screen.getByRole('searchbox', { name: 'Find in PDF' });
    expect(field).toHaveFocus();
    await user.type(field, 'needle');
    expect(viewer.eventBus.dispatched.filter((d) => d.name === 'find').at(-1)?.data).toMatchObject({ query: 'needle', type: '' });
    act(() => viewer.eventBus.dispatch('updatefindcontrolstate', { state: 0, matchesCount: { current: 1, total: 3 } }));
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(viewer.eventBus.dispatched.filter((d) => d.name === 'find').at(-1)?.data).toMatchObject({ type: 'again', findPrevious: true });
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(viewer.eventBus.dispatched.filter((d) => d.name === 'find').at(-1)?.data).toMatchObject({ type: 'again', findPrevious: false });
    act(() => viewer.eventBus.dispatch('updatefindcontrolstate', { state: 1, matchesCount: { current: 0, total: 0 } }));
    expect(screen.getByText('No results')).toBeInTheDocument();
    // Escape closes the bar from any of its controls.
    screen.getByRole('button', { name: 'Close find' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(viewer.eventBus.dispatched.at(-1)?.name).toBe('findbarclose');
  });

  it('shows page thumbnails that go to their page', async () => {
    show();
    const viewer = await open(5);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Page thumbnails' }));
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(pages.querySelectorAll('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(viewer.currentPageNumber).toBe(4);
    expect(screen.getByRole('button', { name: 'Page 4' })).toHaveAttribute('aria-current', 'page');
  });

  it('dims the pages in the dark theme until turned off, and offers nothing to dim in the light theme', async () => {
    const { container, unmount } = show();
    await open();
    const view = container.querySelector('.pdf-view')!;
    expect(view).toHaveAttribute('data-pdf-dark');
    fireEvent.click(screen.getByRole('button', { name: 'Dark pages' }));
    expect(view).not.toHaveAttribute('data-pdf-dark');
    expect(localStorage.getItem('notesapp:pdf-dark-pages')).toBe('off');
    unmount();
    document.documentElement.setAttribute('data-theme', 'light');
    const light = show();
    await open();
    expect(screen.queryByRole('button', { name: 'Dark pages' })).not.toBeInTheDocument();
    expect(light.container.querySelector('.pdf-view')).not.toHaveAttribute('data-pdf-dark');
  });

  it('says why a document could not be opened, with a download', async () => {
    show();
    await waitFor(() => expect(lib.current!.tasks).toHaveLength(1));
    await act(async () => {
      lib.current!.tasks[0].reject(Object.assign(new Error('bad'), { name: 'InvalidPDFException' }));
      await lib.current!.tasks[0].promise.catch(() => {});
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This file is not a valid PDF, or it is damaged.');
    expect(within(alert).getByRole('link', { name: /Download/ })).toHaveAttribute('href', expect.stringContaining('download=true'));
  });

  it('offers to try again when PDF.js itself cannot be loaded', async () => {
    lib.fail = true;
    show();
    expect(await screen.findByText('The PDF viewer could not be loaded.')).toBeInTheDocument();
    lib.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(lib.current!.tasks).toHaveLength(1));
  });
});

describe('PDF commands', () => {
  beforeEach(() => {
    registerPdfView();
    setViewCommandSource((path) => (path?.endsWith('.pdf') ? pdfCommands : []));
  });

  it('are available while a PDF view shows the open file', async () => {
    expect(availableCommands({ activePath: MANUAL.path }).some((c) => c.id === 'pdf.find')).toBe(false);
    const { unmount } = show();
    await open();
    const ids = availableCommands({ activePath: MANUAL.path }).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['pdf.find', 'pdf.goToPage', 'pdf.copyPageLink', 'pdf.zoomIn', 'pdf.zoomOut', 'pdf.fitWidth', 'pdf.fitPage', 'pdf.thumbnails', 'pdf.darkPages']));
    expect(pdfCommands.find((c) => c.id === 'pdf.find')?.hotkey).toBe('Mod-f');
    expect(availableCommands({ activePath: 'Other.pdf' }).some((c) => c.id === 'pdf.find')).toBe(false);
    unmount();
    expect(activePdf(MANUAL.path)).toBeNull();
  });

  it('find, zoom, toggle thumbnails and copy a link to the current page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show();
    const viewer = await open();
    act(() => {
      viewer.currentPageNumber = 4;
    });
    act(() => void runCommand('pdf.find', { activePath: MANUAL.path }));
    expect(screen.getByRole('searchbox', { name: 'Find in PDF' })).toHaveFocus();
    act(() => void runCommand('pdf.fitPage', { activePath: MANUAL.path }));
    expect(viewer.currentScaleValue).toBe('page-fit');
    act(() => void runCommand('pdf.thumbnails', { activePath: MANUAL.path }));
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument();
    act(() => void runCommand('pdf.copyPageLink', { activePath: MANUAL.path }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('[[Manual.pdf#page=4]]'));
  });
});
