import { describe, expect, it } from 'vitest';
import { adjacentDailyNote, dailyNoteDate, dailyNotePath } from './daily';
import { dayjs } from './dates';

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
