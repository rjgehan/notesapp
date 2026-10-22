import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { DatedNote, FileEntry, Task, TasksResponse, TaskWriteResult, TextFile, WriteResult } from '../../api/types';
import { openPath } from '../../features/navigation';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { taskApi } from '../../tasks/api';
import { taskStore } from '../../tasks/store';
import { makeList, makeTask } from '../../tasks/testing';
import { renderWithApp } from '../../tasks/ui/renderWithApp';
import { useTaskUi } from '../../tasks/ui/state';
import { calendarApi } from '../api';
import { DEFAULT_CALENDAR_PREFS, useCalendarPrefs } from '../prefs';
import CalendarPage from './CalendarPage';

vi.mock('../../features/navigation', () => ({ openPath: vi.fn(), navigateTo: vi.fn() }));

const home = makeList();

function entry(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] };
}

function tasks(list: Task[]): TasksResponse {
  return { view: 'list', lists: [home], tasks: list, total: list.length, problems: [] };
}

const dated: DatedNote[] = [
  { path: 'Meetings/Kickoff.md', day: '2026-10-21', property: 'date', value: '2026-10-21T09:30' },
  { path: 'Daily/2026-10-21.md', day: '2026-10-21', property: 'date', value: '2026-10-21' },
  { path: 'Trips/Lisbon.md', day: '2026-10-28', property: 'date', value: '2026-10-28' },
];

let query: ReturnType<typeof vi.spyOn>;
let datedNotes: ReturnType<typeof vi.spyOn>;

function render(url = '/x/calendar') {
  return renderWithApp(<CalendarPage />, { path: url });
}

/** The day buttons of the grid, by their date. */
function dayButton(day: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
  if (!button) throw new Error(`no ${day}`);
  return button;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 21, 10, 15));
  taskStore.reset();
  useTaskUi.setState({ quickAdd: null, detailId: null });
  useCalendarPrefs.setState({ ...DEFAULT_CALENDAR_PREFS, weekStart: 1 });
  const settings = { ...DEFAULT_SETTINGS, dailyNotes: { ...DEFAULT_SETTINGS.dailyNotes, folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily.md' } };
  queryClient.setQueryData(queryKeys.settings(), { settings, version: 'v', readOnly: false });
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'e', folders: [], files: ['Daily/2026-10-21.md', 'Daily/2026-10-02.md', 'Meetings/Kickoff.md'].map(entry) });
  vi.spyOn(taskApi, 'lists').mockResolvedValue({ lists: [home], problems: [] });
  query = vi.spyOn(taskApi, 'query').mockResolvedValue(
    tasks([
      makeTask({ id: 'A', title: 'Call the plumber', due: '2026-10-21' }),
      makeTask({ id: 'B', title: 'Pay rent', due: '2026-10-21', status: 'done', completedAt: '2026-10-21T08:00:00.000Z' }),
      makeTask({ id: 'C', title: 'Water plants', due: '2026-10-23', recurrence: { rrule: 'FREQ=WEEKLY', from: 'due' } }),
      makeTask({ id: 'D', title: 'Old thing', due: '2026-10-12' }),
    ]),
  );
  datedNotes = vi.spyOn(calendarApi, 'datedNotes').mockResolvedValue({ from: '2026-09-28', to: '2026-11-08', properties: ['date'], notes: dated });
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  vi.mocked(openPath).mockReset();
  vi.useRealTimers();
});

describe('Calendar page (ROADMAP item 14)', () => {
  it('shows the month from the first day of the week, with daily notes, tasks and dated notes', async () => {
    render();
    expect(screen.getByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument();
    const grid = screen.getByRole('grid', { name: 'October 2026' });
    // Six weeks from Monday, September 28.
    expect(within(grid).getAllByRole('row')).toHaveLength(7);
    expect(within(grid).getAllByRole('gridcell')[0].querySelector('button')).toHaveAttribute('data-day', '2026-09-28');
    await waitFor(() => expect(dayButton('2026-10-21')).toHaveAccessibleName('Today, Wednesday, October 21, 2026: daily note, 1 note, 1 open task, 1 done'));
    expect(query).toHaveBeenCalledWith({ view: 'list', status: 'all' });
    expect(datedNotes).toHaveBeenCalledWith('2026-09-28', '2026-11-08', ['date']);
    expect(dayButton('2026-10-21')).not.toHaveAttribute('aria-current');
    expect(dayButton('2026-10-21').closest('td')).toHaveAttribute('aria-current', 'date');
    expect(dayButton('2026-10-12')).toHaveClass('is-overdue');
    expect(dayButton('2026-10-02')).toHaveClass('has-note');
    expect(dayButton('2026-10-28')).toHaveClass('has-dated');
    // The weekly task comes back after its date: projected on the 30th, not on the 16th.
    await waitFor(() => expect(dayButton('2026-10-30')).toHaveAccessibleName(/1 repeating/));
    expect(dayButton('2026-10-16')).not.toHaveAccessibleName(/repeating/);

    const details = screen.getByRole('region', { name: /Wednesday, October 21, 2026/ });
    expect(within(details).getByRole('button', { name: '2026-10-21' })).toBeInTheDocument();
    // The daily note is not listed again as a dated note.
    const notes = within(details).getByRole('list', { name: 'Notes on this day' });
    expect(within(notes).getAllByRole('button')).toHaveLength(1);
    expect(within(notes).getByRole('button', { name: /Kickoff/ })).toHaveTextContent('09:30');
    fireEvent.click(within(notes).getByRole('button', { name: /Kickoff/ }));
    expect(openPath).toHaveBeenCalledWith('Meetings/Kickoff.md');
    fireEvent.click(within(details).getByRole('button', { name: '2026-10-21' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('Daily/2026-10-21.md'));
  });

  it('creates another day’s daily note from the template, for that day', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ path: 'Templates/Daily.md', content: '# {{date:dddd D MMMM}} {{time}}\n', version: 'v', mtime: '', size: 1, lossy: false } as unknown as TextFile);
    const create = vi.spyOn(api, 'createFile').mockImplementation(async (req) => ({ file: entry(req.path), created: true, createdFolders: [] }) as unknown as WriteResult);
    render('/x/calendar?date=2026-10-05');
    const day = dayButton('2026-10-05');
    expect(day).toHaveAttribute('tabindex', '0');
    // A tap on the focused day opens (here: creates) its note.
    fireEvent.click(day);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ path: 'Daily/2026-10-05.md', content: '# Monday 5 October 10:15\n', onConflict: 'fail' });
    expect(openPath).toHaveBeenCalledWith('Daily/2026-10-05.md', null, { newNote: true });
  });

  it('a tap on another day focuses it first; its details offer to create the note', async () => {
    render();
    fireEvent.click(dayButton('2026-10-09'));
    await waitFor(() => expect(dayButton('2026-10-09')).toHaveAttribute('tabindex', '0'));
    expect(dayButton('2026-10-09').closest('td')).toHaveAttribute('aria-selected', 'true');
    expect(openPath).not.toHaveBeenCalled();
    const details = screen.getByRole('region', { name: /Friday, October 9, 2026/ });
    expect(within(details).getByRole('button', { name: 'Create daily note' })).toBeInTheDocument();
    expect(await within(details).findByText('No tasks')).toBeInTheDocument();
  });

  it('moves the focus with the date-grid keys, across months', async () => {
    const create = vi.spyOn(api, 'createFile').mockImplementation(async (req) => ({ file: entry(req.path), created: true, createdFolders: [] }) as unknown as WriteResult);
    vi.spyOn(api, 'readFile').mockResolvedValue({ path: 'Templates/Daily.md', content: '', version: 'v', mtime: '', size: 1, lossy: false } as unknown as TextFile);
    render();
    const today = dayButton('2026-10-21');
    today.focus();
    fireEvent.keyDown(today, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2026-10-22')));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2026-10-29')));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2026-11-01')));
    // The grid followed the focus into November.
    expect(screen.getByRole('heading', { level: 1, name: 'November 2026' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2026-10-26')));
    fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2026-11-26')));
    fireEvent.keyDown(document.activeElement!, { key: 'PageUp', shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2025-11-26')));
    expect(screen.getByRole('heading', { level: 1, name: 'November 2025' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ path: 'Daily/2025-11-26.md' }), expect.anything()));
  });

  it('turns the month with the buttons and with a sideways swipe', async () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { level: 1, name: 'November 2026' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument();

    const wrap = screen.getByRole('grid').parentElement!;
    // A quick stroke to the left: the next month; the click it ends with opens nothing.
    fireEvent.pointerDown(wrap, { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(wrap, { pointerType: 'touch', pointerId: 1, clientX: 180, clientY: 210 });
    fireEvent.click(dayButton('2026-11-21'));
    expect(screen.getByRole('heading', { level: 1, name: 'November 2026' })).toBeInTheDocument();
    expect(openPath).not.toHaveBeenCalled();
    // A mostly vertical stroke scrolls; it does not turn the month.
    fireEvent.pointerDown(wrap, { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(wrap, { pointerType: 'touch', pointerId: 2, clientX: 240, clientY: 300 });
    expect(screen.getByRole('heading', { level: 1, name: 'November 2026' })).toBeInTheDocument();
    // To the right: the previous month. A mouse drag is not a swipe.
    fireEvent.pointerDown(wrap, { pointerType: 'touch', pointerId: 3, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(wrap, { pointerType: 'touch', pointerId: 3, clientX: 220, clientY: 200 });
    expect(screen.getByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument();
    fireEvent.pointerDown(wrap, { pointerType: 'mouse', pointerId: 4, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(wrap, { pointerType: 'mouse', pointerId: 4, clientX: 100, clientY: 200 });
    expect(screen.getByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument();
  });

  it('shows a week day by day', async () => {
    render('/x/calendar?view=week');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Oct 19 – Oct 25, 2026/);
    expect(screen.getByText('Week 43')).toBeInTheDocument();
    const days = screen.getAllByRole('region');
    expect(days).toHaveLength(7);
    expect(within(days[0]).getByRole('heading', { level: 2 })).toHaveTextContent('Monday, October 19, 2026');
    expect(await within(days[2]).findByText('Call the plumber')).toBeInTheDocument();
    expect(within(days[4]).getByText('Water plants')).toBeInTheDocument();
    expect(within(days[2]).getByRole('button', { name: /Kickoff/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Oct 26 – Nov 1, 2026/);
    // Next week: the weekly task's coming occurrence, which cannot be checked off yet.
    const repeats = await screen.findByRole('list', { name: 'Repeating tasks due on this day' });
    expect(within(repeats).getByText('Water plants')).toBeInTheDocument();
    expect(within(repeats).queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(screen.getByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument();
  });

  it('completes a task from the day’s details', async () => {
    const task = makeTask({ id: 'A', title: 'Call the plumber', due: '2026-10-21' });
    query.mockResolvedValue(tasks([task]));
    const complete = vi.spyOn(taskApi, 'complete').mockResolvedValue({ task: { ...task, status: 'done', completedAt: '2026-10-21T10:15:00.000Z' }, changed: [], deleted: [], rolledForward: false, files: [], createdFolders: [], lists: [] } satisfies TaskWriteResult);
    render();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete “Call the plumber”' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('A', expect.objectContaining({ base: { due: '2026-10-21', start: null } }), expect.any(String)));
    await waitFor(() => expect(dayButton('2026-10-21')).toHaveAccessibleName(/1 done/));
  });

  it('adds a task on the focused day', async () => {
    render('/x/calendar?date=2026-10-09');
    fireEvent.click(screen.getByRole('button', { name: 'Add task on Friday, October 9, 2026' }));
    expect(useTaskUi.getState().quickAdd).toMatchObject({ due: '2026-10-09' });
  });

  it('keeps its options on the device and asks for the chosen date properties', async () => {
    render();
    fireEvent.change(screen.getByRole('combobox', { name: 'First day of the week' }), { target: { value: '0' } });
    expect(dayButton('2026-09-27')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('notesapp:calendar')!)).toMatchObject({ weekStart: 0 });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show week numbers' }));
    expect(screen.queryByRole('rowheader', { name: /Week/ })).not.toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Note date properties' });
    fireEvent.change(field, { target: { value: 'due, Date, due,' } });
    fireEvent.blur(field);
    expect(field).toHaveValue('due, Date');
    await waitFor(() => expect(datedNotes).toHaveBeenLastCalledWith('2026-09-27', '2026-11-07', ['due', 'Date']));
  });
});
