import { describe, expect, it } from 'vitest';
import { habitFileName, newHabitContent } from './actions';
import { habitColor, HABIT_COLORS } from './colors';
import { dailyValues, EVERY_DAY, habitOf, isCheckedValue, parseSchedule, propertyKey, scheduleLabel, scheduleValue } from './model';
import { addDays, calendarWeeks, cellState, isScheduled, overviewLevel, progressOf, weekStart } from './progress';
import { withEntry } from './write';

// 2026-10-21 is a Wednesday.
const TODAY = '2026-10-21';

function habit(entries: string[], props: Record<string, unknown> = {}, byDay = new Map<string, Map<string, unknown>>()) {
  return habitOf({ path: 'Habits/Exercise.md', version: 'v', properties: { entries, ...props } }, byDay);
}

describe('schedules', () => {
  it('read the frontmatter forms', () => {
    expect(parseSchedule(undefined)).toEqual(EVERY_DAY);
    expect(parseSchedule('daily')).toEqual(EVERY_DAY);
    expect(parseSchedule('Weekdays')).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5] });
    expect(parseSchedule('weekends')).toEqual({ kind: 'days', days: [0, 6] });
    expect(parseSchedule('mon, wed, fri')).toEqual({ kind: 'days', days: [1, 3, 5] });
    expect(parseSchedule(['Tuesday', 'thu'])).toEqual({ kind: 'days', days: [2, 4] });
    expect(parseSchedule('3/week')).toEqual({ kind: 'weekly', times: 3 });
    expect(parseSchedule('2 times a week')).toEqual({ kind: 'weekly', times: 2 });
    expect(parseSchedule('9x week')).toEqual({ kind: 'weekly', times: 7 });
    expect(parseSchedule('sometimes')).toEqual(EVERY_DAY);
  });

  it('write and label them', () => {
    expect(scheduleValue({ kind: 'days', days: [5, 1, 3] })).toBe('mon, wed, fri');
    expect(scheduleValue({ kind: 'days', days: [0, 6] })).toBe('weekends');
    expect(scheduleValue({ kind: 'weekly', times: 3 })).toBe('3/week');
    expect(scheduleLabel({ kind: 'days', days: [0, 1] })).toBe('Mon, Sun');
    expect(scheduleLabel({ kind: 'weekly', times: 1 })).toBe('Once a week');
    expect(scheduleLabel(EVERY_DAY)).toBe('Every day');
    for (const s of ['daily', 'weekdays', 'tue, sat', '4/week']) expect(scheduleValue(parseSchedule(s))).toBe(s);
  });
});

describe('habits', () => {
  it('read the Habit Tracker 21 frontmatter and daily-note check-ins', () => {
    const byDay = dailyValues(
      [
        { path: 'Daily/2026-10-19.md', values: { Exercise: true } },
        { path: 'Daily/2026-10-18.md', values: { exercise: 'no' } },
        { path: 'Daily/notes.md', values: { exercise: true } },
      ],
      { format: 'YYYY-MM-DD' },
      'Daily',
    );
    const h = habit(['2026-10-15', '2026-10-17T08:00', 'junk'], { title: 'Morning run', color: '#123456', maxGap: 1, archived: true }, byDay);
    expect(h.name).toBe('Morning run');
    expect(h.property).toBe('exercise');
    expect([...h.entries].sort()).toEqual(['2026-10-15', '2026-10-17']);
    expect([...h.fromDaily]).toEqual(['2026-10-19']);
    expect(h.done.size).toBe(3);
    expect(h.start).toBe('2026-10-15');
    expect(h.maxGap).toBe(1);
    expect(h.archived).toBe(true);
    expect(habitColor(h)).toBe('#123456');
    expect(HABIT_COLORS).toContain(habitColor({ color: 'not a colour!', path: 'x.md' }));
  });

  it('derive the daily-note property from the name', () => {
    expect(propertyKey('Read 20 pages')).toBe('read-20-pages');
    expect(propertyKey('Méditer!')).toBe('méditer');
    expect(propertyKey('!!!')).toBe('habit');
    expect(isCheckedValue(true)).toBe(true);
    expect(isCheckedValue(2)).toBe(true);
    expect(isCheckedValue('Yes')).toBe(true);
    expect(isCheckedValue('✓')).toBe(true);
    expect(isCheckedValue(0)).toBe(false);
    expect(isCheckedValue('no')).toBe(false);
    expect(isCheckedValue(false)).toBe(false);
  });
});

describe('streaks', () => {
  it('count back from today, or from yesterday while today is open', () => {
    const h = habit(['2026-10-18', '2026-10-19', '2026-10-20']);
    expect(progressOf(h, TODAY)).toMatchObject({ current: 3, longest: 3, doneToday: false, dueToday: true, unit: 'day', total: 3 });
    expect(progressOf(habit(['2026-10-19', '2026-10-20', TODAY]), TODAY).current).toBe(3);
    expect(progressOf(habit(['2026-10-18', '2026-10-20']), TODAY).current).toBe(1);
  });

  it('skip days the schedule does not ask for, and survive maxGap missed days', () => {
    // Mon, Wed, Fri: Mon 19 and Fri 16 done, Wed 14 done; the weekend does not count.
    const mwf = habit(['2026-10-14', '2026-10-16', '2026-10-19'], { schedule: 'mon, wed, fri' });
    expect(progressOf(mwf, TODAY)).toMatchObject({ current: 3, dueToday: true });
    const gap = habit(['2026-10-16', '2026-10-18', '2026-10-20'], { maxGap: 1 });
    expect(progressOf(gap, TODAY).current).toBe(3);
    expect(progressOf(habit(['2026-10-16', '2026-10-18', '2026-10-20']), TODAY).current).toBe(1);
  });

  it('find the longest run and the 30-day rate', () => {
    const h = habit(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-10', '2026-10-20'], { created: '2026-10-01' });
    const p = progressOf(h, TODAY);
    expect(p.longest).toBe(4);
    expect(p.current).toBe(1);
    // 20 days asked (Oct 1–20; today is still open), 6 done.
    expect(p.rate).toBeCloseTo(6 / 20);
    expect(progressOf(habit([]), TODAY)).toMatchObject({ current: 0, longest: 0, rate: null });
  });

  it('count weeks for N-a-week habits', () => {
    const h = habit(['2026-10-06', '2026-10-07', '2026-10-13', '2026-10-15', '2026-10-20'], { schedule: '2/week' });
    const p = progressOf(h, TODAY);
    expect(p).toMatchObject({ unit: 'week', thisWeek: 1, dueToday: true, current: 2, longest: 2 });
    const met = progressOf(habit(['2026-10-13', '2026-10-15', '2026-10-19', '2026-10-20'], { schedule: '2/week' }), TODAY);
    expect(met).toMatchObject({ current: 2, dueToday: false });
    expect(met.rate).toBe(1);
  });
});

describe('calendar', () => {
  it('lays weeks out Monday first, ending with this week', () => {
    const weeks = calendarWeeks(TODAY, 2);
    expect(weeks[1][0]).toBe('2026-10-19');
    expect(weeks[1][2]).toBe(TODAY);
    expect(weeks[0][0]).toBe('2026-10-12');
    expect(weekStart('2026-10-25')).toBe('2026-10-19');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(isScheduled({ kind: 'days', days: [3] }, TODAY)).toBe(true);
  });

  it('gives each day a state, and all habits a level', () => {
    const h = habit(['2026-10-19'], { schedule: 'mon, wed, fri', created: '2026-10-12' });
    expect(cellState(h, '2026-10-19', TODAY)).toBe('done');
    expect(cellState(h, '2026-10-16', TODAY)).toBe('missed');
    expect(cellState(h, '2026-10-18', TODAY)).toBe('off');
    expect(cellState(h, TODAY, TODAY)).toBe('open');
    expect(cellState(h, '2026-10-22', TODAY)).toBe('future');
    expect(cellState(h, '2026-10-01', TODAY)).toBe('before');
    const daily = habit(['2026-10-19', '2026-10-20'], { created: '2026-10-12' });
    expect(overviewLevel([h, daily], '2026-10-19', TODAY)).toBe(4);
    expect(overviewLevel([h, daily], '2026-10-16', TODAY)).toBe(0);
    expect(overviewLevel([h, daily], '2026-10-20', TODAY)).toBe(4);
    expect(overviewLevel([h, daily], '2026-10-01', TODAY)).toBeNull();
  });
});

describe('notes', () => {
  it('add and remove check-ins in the habit note', () => {
    const text = '---\ntitle: Run\nentries:\n  - 2026-10-19\n---\nBody\n';
    expect(withEntry(text, '2026-10-20', true)).toBe('---\ntitle: Run\nentries:\n  - 2026-10-19\n  - 2026-10-20\n---\nBody\n');
    expect(withEntry(text, '2026-10-19', true)).toBe(text);
    expect(withEntry(text, '2026-10-19', false)).toBe('---\ntitle: Run\nentries: []\n---\nBody\n');
    expect(withEntry('Body\n', '2026-10-20', true)).toBe('---\nentries:\n  - 2026-10-20\n---\nBody\n');
    expect(withEntry('---\nentries: [2026-10-21, 2026-10-19]\n---\n', '2026-10-20', true)).toBe('---\nentries:\n  - 2026-10-19\n  - 2026-10-20\n  - 2026-10-21\n---\n');
  });

  it('write a new habit note', () => {
    expect(newHabitContent({ name: 'Exercise', schedule: { kind: 'days', days: [1, 3, 5] }, color: '#2a78d6', property: 'exercise', maxGap: 0 }, 'Exercise', TODAY)).toBe(
      '---\ncolor: "#2a78d6"\nschedule: mon, wed, fri\ncreated: 2026-10-21\nentries: []\n---\n',
    );
    expect(newHabitContent({ name: 'Read: 20 pages', schedule: EVERY_DAY, color: null, property: 'read', maxGap: 1 }, 'Read 20 pages', TODAY)).toBe(
      '---\ntitle: "Read: 20 pages"\nschedule: daily\nproperty: read\nmaxGap: 1\ncreated: 2026-10-21\nentries: []\n---\n',
    );
    expect(habitFileName('Read: 20 pages.')).toBe('Read 20 pages');
    expect(habitFileName('###')).toBe('');
  });
});
