import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../../api/types';
import { FakeDocument, FakeViewer, fakePdfLib, type FakeLib } from '../../test/pdf';
import PdfEmbed from './PdfEmbed';

const lib = vi.hoisted(() => ({ current: null as FakeLib | null, loads: 0 }));

vi.mock('./pdfLib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdfLib')>()),
  loadPdfLib: () => {
    lib.loads++;
    return Promise.resolve(lib.current!.lib);
  },
}));

const BOOK: FileEntry = { path: 'Library/Book.pdf', name: 'Book.pdf', basename: 'Book', extension: 'pdf', kind: 'pdf', size: 99, mtime: '2026-10-17T10:00:00.000Z', version: null, aliases: [] };

function show(props: { subpath?: string; width?: number; height?: number } = {}) {
  return render(<PdfEmbed path={BOOK.path} entry={BOOK} sourcePath="Notes/Reading.md" depth={1} {...props} />);
}

async function open(pages: number) {
  await waitFor(() => expect(lib.current!.tasks).toHaveLength(1));
  await act(async () => {
    lib.current!.tasks[0].resolve(new FakeDocument(pages));
    await lib.current!.tasks[0].promise;
  });
  act(() => FakeViewer.instances[0].initPages());
  return FakeViewer.instances[0];
}

const RealObserver = window.IntersectionObserver;

beforeEach(() => {
  lib.current = fakePdfLib();
  lib.loads = 0;
  document.documentElement.setAttribute('data-theme', 'light');
});

afterEach(() => {
  window.IntersectionObserver = RealObserver;
});

describe('PdfEmbed', () => {
  it('shows the PDF at the page of ![[file.pdf#page=N]] at page width, with a header that opens it there', async () => {
    const { container } = show({ subpath: 'page=3' });
    const viewer = await open(10);
    expect(viewer.currentPageNumber).toBe(3);
    expect(viewer.currentScaleValue).toBe('page-width');
    expect(container.querySelector('.pdf-embed-box')).toHaveStyle({ height: '600px' });
    expect(screen.getByText('Page 3 of 10')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Book.pdf' });
    expect(link).toHaveClass('internal-link');
    expect(link).toHaveAttribute('data-href', 'Library/Book.pdf#page=3');
    expect(link).toHaveAttribute('href', '/n/Library/Book.pdf#page%3D3');
    act(() => {
      viewer.currentPageNumber = 6;
    });
    expect(screen.getByRole('link', { name: 'Book.pdf' })).toHaveAttribute('data-href', 'Library/Book.pdf#page=6');
  });

  it('takes its height from #height=, or from |WxH', async () => {
    const a = show({ subpath: 'height=320' });
    expect(a.container.querySelector('.pdf-embed-box')).toHaveStyle({ height: '320px' });
    a.unmount();
    const b = show({ subpath: 'page=2&height=320', width: 500, height: 250 });
    expect(b.container.querySelector('.pdf-embed-box')).toHaveStyle({ height: '250px', maxWidth: '500px' });
  });

  it('loads PDF.js only when it comes near the screen', async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    window.IntersectionObserver = class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    show({ subpath: 'page=2' });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book.pdf' })).toHaveAttribute('data-href', 'Library/Book.pdf#page=2');
    await Promise.resolve();
    expect(lib.loads).toBe(0);
    act(() => observers[0]([{ isIntersecting: false }]));
    expect(lib.loads).toBe(0);
    act(() => observers[0]([{ isIntersecting: true }]));
    await open(4);
    expect(lib.loads).toBe(1);
    expect(screen.getByText('Page 2 of 4')).toBeInTheDocument();
  });

  it('shows why the PDF cannot be shown', async () => {
    show();
    await waitFor(() => expect(lib.current!.tasks).toHaveLength(1));
    await act(async () => {
      lib.current!.tasks[0].reject(Object.assign(new Error('pw'), { name: 'PasswordException' }));
      await lib.current!.tasks[0].promise.catch(() => {});
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This PDF is protected by a password.');
  });

  it('dims its pages in the dark theme like the view', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const { container } = show();
    expect(container.querySelector('.pdf-embed-box')).toHaveAttribute('data-pdf-dark');
  });
});
