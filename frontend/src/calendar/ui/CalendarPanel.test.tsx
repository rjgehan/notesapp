import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { FileEntry, WriteResult } from '../../api/types';
import { navigateTo, openPath } from '../../features/navigation';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { useUi } from '../../state/ui';
import { taskApi } from '../../tasks/api';
import { taskStore } from '../../tasks/store';
import { makeList, makeTask } from '../../tasks/testing';
import { renderWithApp } from '../../tasks/ui/renderWithApp';
import { calendarApi } from '../api';
import { DEFAULT_CALENDAR_PREFS, useCalendarPrefs } from '../prefs';
import CalendarPanel from './CalendarPanel';

vi.mock('../../features/navigation', () => ({ openPath: vi.fn(), navigateTo: vi.fn() }));

const home = makeList();

function entry(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] };
}

function dayButton(day: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
  if (!button) throw new Error(`no ${day}`);
  return button;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 21, 10, 15));
  taskStore.reset();
  useCalendarPrefs.setState({ ...DEFAULT_CALENDAR_PREFS, weekStart: 1 });
  useUi.getState().setSheetOpen(true);
  const settings = { ...DEFAULT_SETTINGS, dailyNotes: { ...DEFAULT_SETTINGS.dailyNotes, folder: 'Daily', format: 'YYYY-MM-DD', template: '' } };
  queryClient.setQueryData(queryKeys.settings(), { settings, version: 'v', readOnly: false });
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'e', folders: [], files: ['Daily/2026-09-10.md', 'Daily/2026-10-21.md'].map(entry) });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [home], problems: [] });
  vi.spyOn(taskApi, 'query').mockResolvedValue({ view: 'list', lists: [home], tasks: [makeTask({ id: 'A', title: 'Book flights', due: '2026-09-10' })], total: 1, problems: [] });
  vi.spyOn(calendarApi, 'datedNotes').mockResolvedValue({ from: '2026-08-31', to: '2026-10-11', properties: ['date'], notes: [{ path: 'Trips/Rome.md', day: '2026-09-12', property: 'date', value: '2026-09-12' }] });
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  vi.mocked(openPath).mockReset();
  vi.mocked(navigateTo).mockReset();
  vi.useRealTimers();
});

describe('Calendar panel (ROADMAP item 14)', () => {
  it('follows the daily note in view, and shows its day', async () => {
    const { rerender } = renderWithApp(<CalendarPanel activePath="Daily/2026-09-10.md" />);
    expect(screen.getByRole('button', { name: 'September 2026' })).toBeInTheDocument();
    expect(dayButton('2026-09-10')).toHaveClass('is-current');
    const details = screen.getByRole('region', { name: /Thursday, September 10, 2026/ });
    expect(await within(details).findByText('Book flights')).toBeInTheDocument();
    await waitFor(() => expect(dayButton('2026-09-12')).toHaveClass('has-dated'));
    // Another daily note brings its month.
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CalendarPanel activePath="Daily/2026-10-21.md" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'October 2026' })).toBeInTheDocument();
    expect(dayButton('2026-10-21')).toHaveClass('is-current');
  });

  it('opens a day’s daily note with one click, and closes the sheet', async () => {
    renderWithApp(<CalendarPanel activePath={null} />);
    fireEvent.click(dayButton('2026-10-21'));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('Daily/2026-10-21.md'));
    expect(useUi.getState().sheetOpen).toBe(false);
  });

  it('creates a missing one (without a template, empty)', async () => {
    vi.spyOn(api, 'readFile').mockRejectedValue(new Error('no template expected'));
    const create = vi.spyOn(api, 'createFile').mockImplementation(async (req) => ({ file: entry(req.path), created: true, createdFolders: [] }) as unknown as WriteResult);
    renderWithApp(<CalendarPanel activePath={null} />);
    fireEvent.click(dayButton('2026-10-14'));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ path: 'Daily/2026-10-14.md', content: '' }), expect.anything()));
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it('turns the month, and opens the calendar page at the focused day', async () => {
    renderWithApp(<CalendarPanel activePath={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('button', { name: 'September 2026' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'September 2026' }));
    expect(navigateTo).toHaveBeenCalledWith('/x/calendar?date=2026-09-21');
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(screen.getByRole('button', { name: 'October 2026' }));
    expect(navigateTo).toHaveBeenLastCalledWith('/x/calendar');
  });

  it('opens a dated note of the focused day', async () => {
    renderWithApp(<CalendarPanel activePath="Daily/2026-09-10.md" />);
    // Arrow keys move the focus without opening anything.
    dayButton('2026-09-10').focus();
    fireEvent.keyDown(dayButton('2026-09-10'), { key: 'ArrowRight' });
    fireEvent.keyDown(dayButton('2026-09-11'), { key: 'ArrowRight' });
    expect(openPath).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /Rome/ }));
    expect(openPath).toHaveBeenCalledWith('Trips/Rome.md');
    expect(useUi.getState().sheetOpen).toBe(false);
  });
});
