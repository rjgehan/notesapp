// The calendar's date logic (ROADMAP item 14, DESIGN §6.32): the locale's first day of the week,
// month grids of six weeks, week numbers, keyboard moves, and the tasks of each day. Days are
// local calendar days as 'YYYY-MM-DD' strings, like task dates (API.md §20.1), never instants.
import type { LocalDate, Task, TaskList } from '../api/types';
import { dayjs } from '../features/dates';
import { addDays, datePart } from '../tasks/dates';
import { isClosed, scheduleComparator, scheduled } from '../tasks/model';

/** 0 = Sunday … 6 = Saturday, as `Date.getDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 'YYYY-MM'. */
export type Month = string;

const FMT = 'YYYY-MM-DD';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string | null | undefined): value is LocalDate {
  return typeof value === 'string' && DAY.test(value) && dayjs(value, FMT, true).isValid();
}

// CLDR's first day of the week by territory (weekData firstDay): Sunday, Saturday or Friday in
// these, Monday everywhere else. Used where the browser lacks Intl.Locale's week info (Firefox).
const SUNDAY = new Set(
  'AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(' '),
);
const SATURDAY = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '));

export function regionWeekStart(region: string | undefined): Weekday {
  if (!region) return 1;
  if (SUNDAY.has(region)) return 0;
  if (SATURDAY.has(region)) return 6;
  return region === 'MV' ? 5 : 1;
}

interface WeekInfo {
  firstDay: number;
}

/**
 * The first day of the week in `locale` (the browser's by default): Intl.Locale's week info
 * (which honours a `-u-fw-` extension), else the territory table above. Monday when unknown.
 */
export function localeWeekStart(locale?: string): Weekday {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined) ?? 'en-US';
    const loc = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?(): WeekInfo; weekInfo?: WeekInfo };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return (info.firstDay % 7) as Weekday;
    return regionWeekStart(loc.maximize().region);
  } catch {
    return 1;
  }
}

export function startOfWeek(day: LocalDate, weekStart: Weekday): LocalDate {
  const d = dayjs(day, FMT);
  return d.subtract((d.day() - weekStart + 7) % 7, 'day').format(FMT);
}

export function monthOf(day: LocalDate): Month {
  return day.slice(0, 7);
}

/** The same day `n` months away, clamped to the end of a shorter month (Jan 31 + 1 → Feb 28). */
export function addMonthsToDay(day: LocalDate, n: number): LocalDate {
  return dayjs(day, FMT).add(n, 'month').format(FMT);
}

/**
 * The week's number: ISO 8601 when weeks start on Monday (week 1 holds the year's first
 * Thursday); otherwise week 1 is the week that holds January 1 (the US rule), counted in the year
 * the week ends in.
 */
export function weekNumber(start: LocalDate, weekStart: Weekday): number {
  const d = dayjs(start, FMT);
  if (weekStart === 1) return d.isoWeek();
  const year = d.add(6, 'day').year();
  const first = dayjs(startOfWeek(`${year}-01-01`, weekStart), FMT);
  return Math.round(d.diff(first, 'day') / 7) + 1;
}

export interface CalendarWeek {
  start: LocalDate;
  number: number;
  days: LocalDate[];
}

export function weekOf(day: LocalDate, weekStart: Weekday): CalendarWeek {
  const start = startOfWeek(day, weekStart);
  return { start, number: weekNumber(start, weekStart), days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
}

/** Six weeks from the week of the month's first day, so the grid keeps its height month to month. */
export const GRID_WEEKS = 6;

export function monthWeeks(month: Month, weekStart: Weekday): CalendarWeek[] {
  const first = startOfWeek(`${month}-01`, weekStart);
  return Array.from({ length: GRID_WEEKS }, (_, w) => weekOf(addDays(first, w * 7), weekStart));
}

/** Weekday names from the first day of the week, in the browser's locale. */
export function weekdayNames(weekStart: Weekday, style: 'narrow' | 'short' | 'long', locale?: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + ((weekStart + i) % 7))));
}

/**
 * Where a key moves the focused day in a grid (the WAI-ARIA date grid): arrows by a day or a
 * week, Home and End to the ends of the week, Page Up and Page Down by a month (with Shift, a
 * year). Null for other keys.
 */
export function moveDay(day: LocalDate, key: string, weekStart: Weekday, shift = false): LocalDate | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1);
    case 'ArrowRight':
      return addDays(day, 1);
    case 'ArrowUp':
      return addDays(day, -7);
    case 'ArrowDown':
      return addDays(day, 7);
    case 'Home':
      return startOfWeek(day, weekStart);
    case 'End':
      return addDays(startOfWeek(day, weekStart), 6);
    case 'PageUp':
      return addMonthsToDay(day, shift ? -12 : -1);
    case 'PageDown':
      return addMonthsToDay(day, shift ? 12 : 1);
    default:
      return null;
  }
}

/**
 * The tasks scheduled on each day from `from` to `to` (by due date, else start date, as Upcoming
 * groups them), of lists that are not archived: open tasks first, each part in schedule order.
 */
export function tasksByDay(
  tasks: Iterable<Task>,
  lists: ReadonlyMap<string, TaskList>,
  sortedLists: readonly TaskList[],
  from: LocalDate,
  to: LocalDate,
): Map<LocalDate, Task[]> {
  const byDay = new Map<LocalDate, Task[]>();
  for (const t of tasks) {
    const when = scheduled(t);
    if (when === null || t.archived) continue;
    const list = lists.get(t.listId);
    if (!list || list.archived) continue;
    const day = datePart(when);
    if (day < from || day > to) continue;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(t);
    else byDay.set(day, [t]);
  }
  const order = scheduleComparator(sortedLists);
  for (const bucket of byDay.values()) bucket.sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || order(a, b));
  return byDay;
}

export function openCount(tasks: readonly Task[] | undefined): number {
  return tasks ? tasks.reduce((n, t) => n + (isClosed(t) ? 0 : 1), 0) : 0;
}
