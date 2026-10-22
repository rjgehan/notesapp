// Words of the calendar, in the browser's locale (Intl), and the accessible names of days.
import type { LocalDate } from '../../api/types';
import { formatDay } from '../../tasks/dates';
import type { CalendarWeek, Month } from '../model';

const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fullDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const shortDateYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function toDate(day: LocalDate): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 'October 2026'. */
export function monthLabel(month: Month): string {
  const [y, m] = month.split('-').map(Number);
  return monthYear.format(new Date(y, m - 1, 1));
}

/** 'Wednesday, October 21, 2026'. */
export function fullDayLabel(day: LocalDate): string {
  return fullDate.format(toDate(day));
}

/** 'Oct 19 – 25, 2026' style: the week's first and last day. */
export function weekLabel(week: CalendarWeek): string {
  const first = toDate(week.days[0]);
  const last = toDate(week.days[6]);
  return `${shortDate.format(first)} – ${shortDateYear.format(last)}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface DayCounts {
  hasNote: boolean;
  dated: number;
  open: number;
  done: number;
  repeats: number;
}

/** A day button's name: 'Today, Wednesday, October 21, 2026: daily note, 1 note, 2 open tasks, 1 done, 1 repeating'. */
export function dayLabel(day: LocalDate, today: LocalDate, c: DayCounts): string {
  const rel = formatDay(day, today);
  const name = rel === 'Today' || rel === 'Tomorrow' || rel === 'Yesterday' ? `${rel}, ${fullDayLabel(day)}` : fullDayLabel(day);
  const parts: string[] = [];
  if (c.hasNote) parts.push('daily note');
  if (c.dated > 0) parts.push(count(c.dated, 'note', 'notes'));
  if (c.open > 0) parts.push(count(c.open, 'open task', 'open tasks'));
  if (c.done > 0) parts.push(`${c.done} done`);
  if (c.repeats > 0) parts.push(`${c.repeats} repeating`);
  return parts.length > 0 ? `${name}: ${parts.join(', ')}` : name;
}
