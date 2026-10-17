// Task dates (API.md §20.1): 'YYYY-MM-DD' (all day) or 'YYYY-MM-DDTHH:mm', both local to the
// user, so they are compared and shown as strings and calendar days, never as instants.
import { useEffect, useState } from 'react';
import type { LocalDate, TaskDate } from '../api/types';
import { dayjs } from '../features/dates';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isTaskDate(value: string): boolean {
  return (DATE.test(value) || DATE_TIME.test(value)) && dayjs(value.slice(0, 10), 'YYYY-MM-DD', true).isValid();
}

/** The browser's local date. */
export function localToday(now: Date = new Date()): LocalDate {
  return dayjs(now).format('YYYY-MM-DD');
}

export function datePart(value: TaskDate): LocalDate {
  return value.slice(0, 10);
}

/** 'HH:mm', or null for an all-day date. */
export function timePart(value: TaskDate): string | null {
  return value.length > 10 ? value.slice(11, 16) : null;
}

export function joinDate(date: LocalDate, time: string | null): TaskDate {
  return time ? `${date}T${time}` : date;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return dayjs(date, 'YYYY-MM-DD').add(days, 'day').format('YYYY-MM-DD');
}

/** The server's order (TaskDates.compare): by day, an all-day date before the times of its day. */
export function compareTaskDates(a: TaskDate, b: TaskDate): number {
  const da = datePart(a);
  const db = datePart(b);
  if (da !== db) return da < db ? -1 : 1;
  const timedA = a.length > 10;
  const timedB = b.length > 10;
  if (timedA !== timedB) return timedA ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthDayYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function toLocalDate(date: LocalDate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** '9:00 AM' or '09:00', in the user's locale. */
export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return clock.format(new Date(2000, 0, 1, h, m));
}

/** 'Today', 'Tomorrow', 'Yesterday', a weekday within the coming week, else 'Oct 30' (with the year when it differs). */
export function formatDay(date: LocalDate, today: LocalDate): string {
  const diff = dayjs(date, 'YYYY-MM-DD').diff(dayjs(today, 'YYYY-MM-DD'), 'day');
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = toLocalDate(date);
  if (diff > 1 && diff < 7) return weekday.format(d);
  return date.slice(0, 4) === today.slice(0, 4) ? monthDay.format(d) : monthDayYear.format(d);
}

/** A task date for a row or chip: 'Tomorrow 9:00 AM'. */
export function formatTaskDate(value: TaskDate, today: LocalDate): string {
  const time = timePart(value);
  const day = formatDay(datePart(value), today);
  return time ? `${day} ${formatTime(time)}` : day;
}

/** 'Saturday, October 17'. */
export function formatLongDate(date: LocalDate): string {
  return longDate.format(toLocalDate(date));
}

export type DateTone = 'overdue' | 'today' | 'soon' | 'later';

export function dateTone(value: TaskDate, today: LocalDate): DateTone {
  const day = datePart(value);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return day <= addDays(today, 6) ? 'soon' : 'later';
}

/** The local date, kept current across midnight and while the page sleeps in the background. */
export function useToday(): LocalDate {
  const [today, setToday] = useState(localToday);
  useEffect(() => {
    const check = () => setToday(localToday());
    const timer = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return today;
}
