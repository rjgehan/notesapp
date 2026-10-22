import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, TextFile, WriteResult } from '../api/types';
import { buildVaultTree } from '../api/vaultTree';
import { adjacentDailyNote, atTimeOf, dailyNoteDate, dailyNoteEntry, dailyNotePath, openDailyNote } from './daily';
import { dayjs } from './dates';
import { openPath } from './navigation';
import { DEFAULT_SETTINGS } from './settings';

vi.mock('./navigation', () => ({ openPath: vi.fn(), navigateTo: vi.fn() }));

function entry(path: string): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] };
}

const today = dayjs('2026-10-16T14:03:09');

describe('dailyNotePath (API.md §15.2)', () => {
  it.each([
    [{ format: 'YYYY-MM-DD', folder: 'Daily' }, 'Daily/2026-10-16.md'],
    [{ format: 'YYYY/MM-MMMM/YYYY-MM-DD dddd', folder: 'Journal' }, 'Journal/2026/10-October/2026-10-16 Friday.md'],
    [{ format: 'YYYY-[W]WW', folder: '' }, '2026-W42.md'],
  ])('%j → %s', (settings, path) => {
    expect(dailyNotePath(settings, today)).toBe(path);
  });
});

describe('dailyNoteDate', () => {
  const daily = { format: 'YYYY-MM-DD', folder: 'Daily' };

  it('parses the path below the folder strictly', () => {
    expect(dailyNoteDate('Daily/2026-10-16.md', daily)?.format('YYYY-MM-DD')).toBe('2026-10-16');
    expect(dailyNoteDate('Daily/2026-13-01.md', daily)).toBeNull();
    expect(dailyNoteDate('Daily/2026-10-16 notes.md', daily)).toBeNull();
    expect(dailyNoteDate('Daily/16-10-2026.md', daily)).toBeNull();
    expect(dailyNoteDate('Other/2026-10-16.md', daily)).toBeNull();
    expect(dailyNoteDate('Daily/2026-10-16.txt', daily)).toBeNull();
  });

  it('handles formats that create subfolders, and the vault root as folder', () => {
    const nested = { format: 'YYYY/MM-MMMM/YYYY-MM-DD dddd', folder: 'Journal' };
    expect(dailyNoteDate('Journal/2026/10-October/2026-10-16 Friday.md', nested)?.format('YYYY-MM-DD')).toBe('2026-10-16');
    // A weekday that does not match the date is not that format.
    expect(dailyNoteDate('Journal/2026/10-October/2026-10-16 Monday.md', nested)).toBeNull();
    expect(dailyNoteDate('2026-10-16.md', { format: 'YYYY-MM-DD', folder: '' })?.format('YYYY-MM-DD')).toBe('2026-10-16');
  });
});

describe('adjacentDailyNote', () => {
  const settings = { format: 'YYYY-MM-DD', folder: 'Daily' };
  const paths = ['Daily/2026-10-12.md', 'Daily/2026-10-16.md', 'Daily/2026-10-20.md', 'Daily/notes.md', 'Daily/2026-09-30.md', 'Welcome.md'];

  it('finds the nearest earlier and later existing note, skipping gaps and other notes', () => {
    expect(adjacentDailyNote(paths, 'Daily/2026-10-16.md', settings, -1)).toBe('Daily/2026-10-12.md');
    expect(adjacentDailyNote(paths, 'Daily/2026-10-16.md', settings, 1)).toBe('Daily/2026-10-20.md');
    expect(adjacentDailyNote(paths, 'Daily/2026-10-12.md', settings, -1)).toBe('Daily/2026-09-30.md');
  });

  it('returns null at either end and for a note that is not a daily note', () => {
    expect(adjacentDailyNote(paths, 'Daily/2026-10-20.md', settings, 1)).toBeNull();
    expect(adjacentDailyNote(paths, 'Daily/2026-09-30.md', settings, -1)).toBeNull();
    expect(adjacentDailyNote(paths, 'Welcome.md', settings, 1)).toBeNull();
  });

  it('works across subfolders created by the format', () => {
    const nested = { format: 'YYYY/MM/DD', folder: 'J' };
    const list = ['J/2026/09/30.md', 'J/2026/10/01.md', 'J/2026/10/05.md'];
    expect(adjacentDailyNote(list, 'J/2026/10/01.md', nested, -1)).toBe('J/2026/09/30.md');
    expect(adjacentDailyNote(list, 'J/2026/10/01.md', nested, 1)).toBe('J/2026/10/05.md');
  });
});

describe('dailyNoteEntry (the calendar, ROADMAP item 14)', () => {
  const tree = buildVaultTree({ eventId: '', folders: [], files: ['Daily/2026-10-16.md', 'journal/2026-W42.md', 'Daily/notes.md'].map(entry) });

  it('finds a day’s note by formatting the day, ignoring case', () => {
    expect(dailyNoteEntry({ format: 'YYYY-MM-DD', folder: 'Daily' }, tree, today)?.path).toBe('Daily/2026-10-16.md');
    expect(dailyNoteEntry({ format: 'YYYY-MM-DD', folder: 'daily' }, tree, today)?.path).toBe('Daily/2026-10-16.md');
    expect(dailyNoteEntry({ format: 'YYYY-MM-DD', folder: 'Daily' }, tree, today.add(1, 'day'))).toBeUndefined();
  });

  it('works with week-based formats, which cannot be parsed back', () => {
    const weekly = { format: 'gggg-[W]ww', folder: 'Journal' };
    // Every day of that week has the same note.
    expect(dailyNoteEntry(weekly, tree, dayjs('2026-10-12'))?.path).toBe('journal/2026-W42.md');
    expect(dailyNoteEntry(weekly, tree, dayjs('2026-10-17'))?.path).toBe('journal/2026-W42.md');
  });
});

describe('atTimeOf', () => {
  it('keeps the day and takes the time of day', () => {
    const at = atTimeOf(dayjs('2026-10-05'), dayjs('2026-10-21T14:03:09.250'));
    expect(at.format('YYYY-MM-DD HH:mm:ss.SSS')).toBe('2026-10-05 14:03:09.250');
  });
});

describe('openDailyNote', () => {
  const settings = { ...DEFAULT_SETTINGS, dailyNotes: { ...DEFAULT_SETTINGS.dailyNotes, folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily.md' } };

  beforeEach(() => {
    queryClient.setQueryData(queryKeys.settings(), { settings, version: 'v', readOnly: false });
    queryClient.setQueryData(queryKeys.tree(), { eventId: 'e', folders: [], files: [entry('Daily/2026-10-16.md')] });
    vi.spyOn(api, 'readFile').mockResolvedValue({ path: 'Templates/Daily.md', content: '# {{title}}\nCreated {{date:dddd}} at {{time}}\n', version: 'v', mtime: '', size: 1, lossy: false } as unknown as TextFile);
  });

  afterEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
    vi.mocked(openPath).mockReset();
  });

  it('opens an existing note', async () => {
    const create = vi.spyOn(api, 'createFile');
    await expect(openDailyNote(dayjs('2026-10-16'))).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledWith('Daily/2026-10-16.md');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates another day’s note from the template, rendered for that day', async () => {
    const create = vi.spyOn(api, 'createFile').mockImplementation(async (req) => ({ file: entry(req.path), created: true, createdFolders: [] }) as unknown as WriteResult);
    const now = dayjs();
    await expect(openDailyNote(dayjs('2026-10-05'))).resolves.toBe(true);
    const req = create.mock.calls[0][0];
    expect(req.path).toBe('Daily/2026-10-05.md');
    expect(req.onConflict).toBe('fail');
    // 2026-10-05 is a Monday; the time is the current time of day.
    expect(req.content).toMatch(/^# 2026-10-05\nCreated Monday at \d{2}:\d{2}\n$/);
    // The time of day is now's (give or take the minute that may turn during the test).
    expect([now.format('HH:mm'), now.add(1, 'minute').format('HH:mm')]).toContain(/at (\d{2}:\d{2})/.exec(req.content ?? '')?.[1] ?? '');
    expect(openPath).toHaveBeenCalledWith('Daily/2026-10-05.md', null, { newNote: true });
  });
});
