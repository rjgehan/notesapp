import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import type { SearchResponse } from '../../api/types';
import { setNavigator } from '../../features/navigation';
import { hitRoute, pdfViewerUrl } from '../../features/searchLinks';
import { SearchView } from './SearchView';

const navigate = vi.fn();

const buttonWith = (text: string): HTMLElement => screen.getAllByRole('button').find((b) => b.textContent?.includes(text))!;

function Harness({ initial = '' }: { initial?: string }) {
  const [query, setQuery] = useState(initial);
  return <SearchView query={query} onQuery={setQuery} />;
}

function renderView(initial = '') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness initial={initial} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RESPONSE: SearchResponse = {
  query: 'recieve jam',
  total: 2,
  tookMs: 3,
  corrections: [{ term: 'recieve', replacements: ['receive'] }],
  results: [
    {
      path: 'Docs/Manual.pdf',
      basename: 'Manual',
      kind: 'pdf',
      score: 3,
      mtime: '2026-10-16T10:00:00.000Z',
      titleRanges: [],
      matches: [{ line: 4, text: 'Paper jam in tray two', ranges: [{ from: 6, to: 9 }], page: 2 }],
      moreMatches: 0,
    },
    {
      path: 'Notes/Post.md',
      basename: 'Post',
      kind: 'note',
      score: 2,
      mtime: '2026-10-16T10:00:00.000Z',
      titleRanges: [],
      matches: [{ line: 1, text: 'We receive a jam', ranges: [{ from: 3, to: 10 }], page: null }],
      moreMatches: 0,
    },
  ],
};

beforeEach(() => {
  setNavigator(navigate);
  navigate.mockClear();
  vi.spyOn(api, 'getSavedSearches').mockResolvedValue({
    searches: [{ id: 's-1', name: 'Open loops', query: 'tag:#todo -done', sort: 'mtime' }],
    version: 'v1',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('SearchView', () => {
  it('lists saved searches while the field is empty and runs one when picked', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue({ ...RESPONSE, results: [], total: 0, corrections: [] });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: /^Open loops/ }));
    expect(screen.getByRole('searchbox')).toHaveValue('tag:#todo -done');
    await waitFor(() => expect(search).toHaveBeenCalledWith('tag:#todo -done', { sort: 'mtime', prefix: true, fuzzy: true }));
    expect(await screen.findByRole('button', { name: 'Saved as Open loops' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows PDF hits with their page, and corrections with a way back to exact words', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue(RESPONSE);
    renderView('recieve jam');
    expect(await screen.findByText('p. 2')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Including similar words: recieve → receive');
    fireEvent.click(buttonWith('Paper jam in tray two'));
    expect(navigate).toHaveBeenCalledWith('/n/Docs/Manual.pdf?page=2', undefined);
    fireEvent.click(buttonWith('We receive a jam'));
    expect(navigate).toHaveBeenLastCalledWith('/n/Notes/Post.md?line=1&q=' + encodeURIComponent('recieve jam receive'), undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Exact words only' }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('recieve jam', { sort: 'relevance', prefix: true, fuzzy: false }));
  });

  it('shows why a query is invalid', async () => {
    vi.spyOn(api, 'search').mockRejectedValue(
      new ApiError({ type: 'urn:notesapp:problem:bad-request', title: 'Bad request', status: 400, code: 'bad-request', detail: 'Invalid regular expression /a(b/: Unclosed group' }),
    );
    renderView('/a(b/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid regular expression /a(b/');
  });
});

describe('search links', () => {
  it('opens notes at the line and PDFs at the page', () => {
    expect(hitRoute({ path: 'A b.md', kind: 'note' }, { line: 3, page: null }, 'x y')).toBe('/n/A%20b.md?line=3&q=x%20y');
    expect(hitRoute({ path: 'A.pdf', kind: 'pdf' }, { line: 3, page: 4 }, 'x')).toBe('/n/A.pdf?page=4');
    expect(hitRoute({ path: 'A.md', kind: 'note' }, null, 'x')).toBe('/n/A.md');
    expect(pdfViewerUrl('/raw', '4')).toBe('/raw#page=4');
    expect(pdfViewerUrl('/raw', 'x')).toBe('/raw');
    expect(pdfViewerUrl('/raw', null)).toBe('/raw');
  });
});
