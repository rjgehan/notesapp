// Streaks, rates and the calendar heatmap of habits (DESIGN §6.35). Days are local YYYY-MM-DD.
import { dayjs } from '../features/dates';
import type { Habit, Schedule } from './model';

const DAY_MS = 86_400_000;

/** A day as UTC milliseconds: date arithmetic without time zones or DST, and without parsing. */
function utc(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

export function addDays(day: string, n: number): string {
  return new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
}

export function todayString(now: number = Date.now()): string {
  return dayjs(now).format('YYYY-MM-DD');
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: string): number {
  return new Date(utc(day)).getUTCDay();
}

/** The Monday of the week `day` is in. */
export function weekStart(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** True when the schedule asks for the habit on `day` (every day counts for an N-a-week habit). */
export function isScheduled(s: Schedule, day: string): boolean {
  return s.kind === 'weekly' || s.days.includes(weekdayOf(day));
}

export interface Progress {
  /** The habit is due on `today` (a day it is scheduled; for N a week, while the week's target is not met). */
  dueToday: boolean;
  doneToday: boolean;
  /** The current streak: done days, or for N-a-week habits weeks that met the target. */
  current: number;
  longest: number;
  unit: 'day' | 'week';
  /** Share of what was asked over the last 30 days that was done; null before the habit started. */
  rate: number | null;
  total: number;
  /** N-a-week habits: days done this week. */
  thisWeek: number;
}

function weekCount(done: ReadonlySet<string>, monday: string): number {
  let n = 0;
  for (let i = 0; i < 7; i++) if (done.has(addDays(monday, i))) n++;
  return n;
}

export function progressOf(h: Pick<Habit, 'done' | 'schedule' | 'maxGap' | 'start'>, today: string): Progress {
  const done = h.done;
  const doneToday = done.has(today);
  const total = [...done].filter((d) => d <= today).length;
  if (h.schedule.kind === 'weekly') {
    const times = h.schedule.times;
    const thisMonday = weekStart(today);
    const thisWeek = weekCount(done, thisMonday);
    const empty = { dueToday: thisWeek < times, doneToday, current: 0, longest: 0, unit: 'week' as const, rate: null, total, thisWeek };
    if (!h.start) return empty;
    const firstMonday = weekStart(h.start);
    let current = 0;
    for (let w = thisWeek >= times ? thisMonday : addDays(thisMonday, -7); w >= firstMonday && weekCount(done, w) >= times; w = addDays(w, -7)) current++;
    let longest = 0;
    let run = 0;
    for (let w = firstMonday; w <= thisMonday; w = addDays(w, 7)) {
      if (weekCount(done, w) >= times) longest = Math.max(longest, ++run);
      else if (w !== thisMonday) run = 0;
    }
    // The last four full weeks (fewer for a new habit), each counting up to its target.
    let sum = 0;
    let weeks = 0;
    for (let i = 1; i <= 4; i++) {
      const w = addDays(thisMonday, -7 * i);
      if (w < firstMonday) break;
      sum += Math.min(1, weekCount(done, w) / times);
      weeks++;
    }
    return { ...empty, current, longest: Math.max(longest, current), rate: weeks ? sum / weeks : null };
  }
  const schedule = h.schedule;
  const dueToday = isScheduled(schedule, today);
  if (!h.start || h.start > today) return { dueToday, doneToday, current: 0, longest: 0, unit: 'day', rate: null, total, thisWeek: 0 };
  const start = h.start;
  // The current streak counts back from today, or from yesterday while today is still open.
  let current = 0;
  let gap = 0;
  for (let d = doneToday ? today : addDays(today, -1); d >= start; d = addDays(d, -1)) {
    if (done.has(d)) {
      current++;
      gap = 0;
    } else if (isScheduled(schedule, d) && ++gap > h.maxGap) break;
  }
  let longest = 0;
  let run = 0;
  gap = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (done.has(d)) {
      longest = Math.max(longest, ++run);
      gap = 0;
    } else if (d !== today && isScheduled(schedule, d) && ++gap > h.maxGap) {
      run = 0;
      gap = 0;
    }
  }
  let asked = 0;
  let met = 0;
  for (let i = 0; i < 30; i++) {
    const d = addDays(today, -i);
    if (d < start) break;
    if (!isScheduled(schedule, d) || (d === today && !doneToday)) continue;
    asked++;
    if (done.has(d)) met++;
  }
  return { dueToday, doneToday, current, longest, unit: 'day', rate: asked ? met / asked : null, total, thisWeek: 0 };
}

export type CellState = 'done' | 'missed' | 'open' | 'off' | 'future' | 'before';

export interface Cell {
  day: string;
  state: CellState;
}

/** `weeks` columns of seven days (Monday first), the last one holding `today`. */
export function calendarWeeks(today: string, weeks: number): string[][] {
  const first = addDays(weekStart(today), -7 * (weeks - 1));
  const out: string[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: string[] = [];
    for (let i = 0; i < 7; i++) col.push(addDays(first, w * 7 + i));
    out.push(col);
  }
  return out;
}

export function cellState(h: Pick<Habit, 'done' | 'schedule' | 'start'>, day: string, today: string): CellState {
  if (day > today) return 'future';
  if (h.done.has(day)) return 'done';
  if (!h.start || day < h.start) return 'before';
  if (h.schedule.kind === 'weekly') return 'open';
  if (!isScheduled(h.schedule, day)) return 'off';
  return day === today ? 'open' : 'missed';
}

/** All habits on one calendar: the share of the habits due each day that were done, in five levels. */
export function overviewLevel(habits: readonly Pick<Habit, 'done' | 'schedule' | 'start'>[], day: string, today: string): number | null {
  if (day > today) return null;
  let due = 0;
  let done = 0;
  for (const h of habits) {
    if (!h.start || day < h.start) continue;
    if (h.done.has(day)) {
      due++;
      done++;
    } else if (h.schedule.kind === 'days' && isScheduled(h.schedule, day)) due++;
  }
  if (due === 0) return null;
  const ratio = done / due;
  return ratio === 0 ? 0 : ratio < 0.34 ? 1 : ratio < 0.67 ? 2 : ratio < 1 ? 3 : 4;
}
