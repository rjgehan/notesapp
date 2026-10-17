import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { useNoteScroll } from '../../features/noteScroll';
import OutlinePanel from './OutlinePanel';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutlinePanel (FE-11)', () => {
  it('scrolls by line: a repeated click scrolls again, and duplicate or "#" headings reach the exact one', async () => {
    const content = '# Notes\n\nfirst\n\n## C# tips\n\nx\n\n# Notes\n\nsecond\n';
    vi.spyOn(api, 'readFile').mockImplementation(async (path) => ({ path, kind: 'note', content, version: 'v1', size: content.length, mtime: '2026-10-16T10:00:00.000Z', lossy: false }));
    render(<OutlinePanel activePath="Outline test.md" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Notes' })).toHaveLength(2));
    const [, second] = screen.getAllByRole('button', { name: 'Notes' });
    const before = useNoteScroll.getState().seq;
    fireEvent.click(second);
    expect(useNoteScroll.getState()).toMatchObject({ path: 'Outline test.md', line: 8, seq: before + 1 });
    fireEvent.click(second);
    expect(useNoteScroll.getState()).toMatchObject({ line: 8, seq: before + 2 });
    fireEvent.click(screen.getByRole('button', { name: 'C# tips' }));
    expect(useNoteScroll.getState()).toMatchObject({ line: 4 });
  });
});
