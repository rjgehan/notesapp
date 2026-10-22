import { describe, expect, it } from 'vitest';
import { makeList, makeTask } from '../tasks/testing';
import { addMonthsToDay, isDay, localeWeekStart, monthWeeks, moveDay, openCount, regionWeekStart, startOfWeek, tasksByDay, weekNumber, weekOf, weekdayNames } from './model';

describe('first day of the week (ROADMAP item 14)', () => {
  it('follows the locale', () => {
    expect(localeWeekStart('en-US')).toBe(0);
    expect(localeWeekStart('en-GB')).toBe(1);
    expect(localeWeekStart('de')).toBe(1);
    expect(localeWeekStart('fr-CA')).toBe(0);
    expect(localeWeekStart('ar-EG')).toBe(6);
    // A -u-fw- extension asks for a day explicitly, where the browser knows week info.
    const fw = localeWeekStart('en-US-u-fw-mon');
    expect([0, 1]).toContain(fw);
  });

  it('falls back to CLDR territories, Monday when unknown', () => {
    expect(regionWeekStart('US')).toBe(0);
    expect(regionWeekStart('JP')).toBe(0);
    expect(regionWeekStart('FR')).toBe(1);
    expect(regionWeekStart('EG')).toBe(6);
    expect(regionWeekStart('MV')).toBe(5);
    expect(regionWeekStart(undefined)).toBe(1);
    expect(localeWeekStart('not a locale!')).toBe(1);
  });

  it('names the weekdays from that day', () => {
    expect(weekdayNames(1, 'short', 'en-US')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdayNames(0, 'narrow', 'en-US')).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(weekdayNames(6, 'long', 'en-US')[0]).toBe('Saturday');
  });
});

describe('month grids', () => {
  it('starts weeks on the chosen day', () => {
    // 2026-10-21 is a Wednesday.
    expect(startOfWeek('2026-10-21', 1)).toBe('2026-10-19');
    expect(startOfWeek('2026-10-21', 0)).toBe('2026-10-18');
    expect(startOfWeek('2026-10-21', 6)).toBe('2026-10-17');
    expect(startOfWeek('2026-10-19', 1)).toBe('2026-10-19');
  });

  it('has six weeks from the week of the first day', () => {
    const monday = monthWeeks('2026-10', 1);
    expect(monday).toHaveLength(6);
    expect(monday[0].days[0]).toBe('2026-09-28');
    expect(monday[5].days[6]).toBe('2026-11-08');
    const sunday = monthWeeks('2026-02', 0);
    // February 2026 starts on a Sunday: no days of January.
    expect(sunday[0].days[0]).toBe('2026-02-01');
    expect(sunday.flatMap((w) => w.days)).toHaveLength(42);
  });

  it('numbers weeks the ISO way from Monday, the US way otherwise', () => {
    expect(weekNumber('2026-10-19', 1)).toBe(43);
    // 2026-12-28 (Monday) is ISO week 53 of 2026; 2027-01-04 is week 1 of 2027.
    expect(weekNumber('2026-12-28', 1)).toBe(53);
    expect(weekNumber('2027-01-04', 1)).toBe(1);
    // 2021-01-01 was a Friday: ISO puts the week of Monday 2020-12-28 in 2020 (week 53).
    expect(weekNumber('2020-12-28', 1)).toBe(53);
    // US rule: the week holding January 1 is week 1, also when it starts in December.
    expect(weekNumber('2026-12-27', 0)).toBe(1);
    expect(weekNumber('2026-01-04', 0)).toBe(2);
    expect(weekNumber('2026-10-18', 0)).toBe(43);
    expect(weekOf('2026-10-21', 0)).toMatchObject({ start: '2026-10-18', number: 43 });
  });

  it('moves the focused day with the keys of a date grid', () => {
    expect(moveDay('2026-10-21', 'ArrowLeft', 1)).toBe('2026-10-20');
    expect(moveDay('2026-10-31', 'ArrowRight', 1)).toBe('2026-11-01');
    expect(moveDay('2026-10-21', 'ArrowUp', 1)).toBe('2026-10-14');
    expect(moveDay('2026-10-28', 'ArrowDown', 1)).toBe('2026-11-04');
    expect(moveDay('2026-10-21', 'Home', 1)).toBe('2026-10-19');
    expect(moveDay('2026-10-21', 'End', 0)).toBe('2026-10-24');
    expect(moveDay('2026-01-31', 'PageDown', 1)).toBe('2026-02-28');
    expect(moveDay('2026-10-21', 'PageUp', 1, true)).toBe('2025-10-21');
    expect(moveDay('2026-10-21', 'a', 1)).toBeNull();
    expect(addMonthsToDay('2024-03-31', -1)).toBe('2024-02-29');
  });

  it('accepts only real days', () => {
    expect(isDay('2026-10-21')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-10')).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});

describe('tasksByDay', () => {
  const home = makeList();
  const old = makeList({ id: 'L2', name: 'Old', archived: true, path: 'Tasks/Old.tasks' });
  const lists = new Map([
    [home.id, home],
    [old.id, old],
  ]);

  it('groups tasks of active lists by due date, else start date, open ones first', () => {
    const tasks = [
      makeTask({ id: 'A', title: 'Timed', due: '2026-10-21T09:00' }),
      makeTask({ id: 'B', title: 'All day', due: '2026-10-21' }),
      makeTask({ id: 'C', title: 'Done', due: '2026-10-21', status: 'done' }),
      makeTask({ id: 'D', title: 'Starts', start: '2026-10-22' }),
      makeTask({ id: 'E', title: 'Due wins', start: '2026-10-01', due: '2026-10-23' }),
      makeTask({ id: 'F', title: 'Archived list', listId: 'L2', due: '2026-10-21' }),
      makeTask({ id: 'G', title: 'Archived task', due: '2026-10-21', archived: true, status: 'done' }),
      makeTask({ id: 'H', title: 'No date' }),
      makeTask({ id: 'I', title: 'Out of range', due: '2026-12-01' }),
    ];
    const byDay = tasksByDay(tasks, lists, [home], '2026-10-01', '2026-10-31');
    expect(byDay.get('2026-10-21')?.map((t) => t.id)).toEqual(['B', 'A', 'C']);
    expect(byDay.get('2026-10-22')?.map((t) => t.id)).toEqual(['D']);
    expect(byDay.get('2026-10-23')?.map((t) => t.id)).toEqual(['E']);
    expect(byDay.has('2026-10-01')).toBe(false);
    expect([...byDay.keys()].sort()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(openCount(byDay.get('2026-10-21'))).toBe(2);
    expect(openCount(undefined)).toBe(0);
  });
});
