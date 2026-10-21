// Habits from their notes (DESIGN §6.35). A habit is a note in `Habits/` or tagged `#habit`; its
// frontmatter is Obsidian's Habit Tracker 21 shape plus a schedule:
//
//   title: Morning workout      (optional; the note's name otherwise)
//   color: "#4CAF50"            (optional)
//   entries:                    the days it was done, YYYY-MM-DD
//     - 2026-10-20
//   schedule: mon, wed, fri     daily (default), weekdays, weekends, days, or "3/week"
//   property: exercise          the daily-note property that also checks it in (default: from the name)
//   maxGap: 1                   missed days a streak survives (as in Habit Tracker 21)
//   archived: true              hidden from today's list
//
// A daily note checks a habit in with its property: `exercise: true` (or yes, done, x, ✓, a number > 0).
import type { DailyNoteValues, DailyNotesSettings, HabitNote } from '../api/types';
import { dailyNoteDate } from '../features/daily';
import { basenameOf, lastSegment } from '../features/paths';

export type Schedule = { kind: 'days'; days: number[] } | { kind: 'weekly'; times: number };

export const EVERY_DAY: Schedule = { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6] };
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface Habit {
  path: string;
  version: string;
  name: string;
  color: string | null;
  schedule: Schedule;
  /** The daily-note property that checks the habit in. */
  property: string;
  /** Days done according to the habit note's `entries`. */
  entries: Set<string>;
  /** Days done according to a daily note's property. */
  fromDaily: Set<string>;
  /** Every day done. */
  done: Set<string>;
  maxGap: number;
  archived: boolean;
  /** The first day the habit counts from: `created`, else its first check-in. */
  start: string | null;
}

/** A schedule from its frontmatter value; anything unreadable is every day. */
export function parseSchedule(value: unknown): Schedule {
  if (Array.isArray(value)) return daysOf(value.map(String)) ?? EVERY_DAY;
  if (typeof value !== 'string') return EVERY_DAY;
  const s = value.trim().toLowerCase();
  if (s === '' || s === 'daily' || s === 'every day' || s === 'everyday') return EVERY_DAY;
  if (s === 'weekdays') return { kind: 'days', days: [1, 2, 3, 4, 5] };
  if (s === 'weekends') return { kind: 'days', days: [0, 6] };
  const weekly = /^(\d+)\s*(?:\/|x|times?\s*(?:a|per|\/)?)\s*(?:a\s*)?w(?:ee)?k$/.exec(s);
  if (weekly) {
    const times = Math.min(7, Math.max(1, Number(weekly[1])));
    return { kind: 'weekly', times };
  }
  return daysOf(s.split(/[\s,]+/)) ?? EVERY_DAY;
}

function daysOf(names: string[]): Schedule | null {
  const days = new Set<number>();
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    const i = DAY_NAMES.findIndex((d) => n.startsWith(d.slice(0, 2)) && d.startsWith(n.slice(0, 3)));
    if (i < 0) return null;
    days.add(i);
  }
  return days.size ? { kind: 'days', days: [...days].sort((a, b) => a - b) } : null;
}

/** The frontmatter value of a schedule. */
export function scheduleValue(s: Schedule): string {
  if (s.kind === 'weekly') return `${s.times}/week`;
  const key = s.days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'daily';
  if (key === '1,2,3,4,5') return 'weekdays';
  if (key === '0,6') return 'weekends';
  return DAY_ORDER.filter((d) => s.days.includes(d))
    .map((d) => DAY_NAMES[d])
    .join(', ');
}

/** "Every day", "Weekdays", "Mon, Wed, Fri", "3 times a week". */
export function scheduleLabel(s: Schedule): string {
  if (s.kind === 'weekly') return s.times === 1 ? 'Once a week' : `${s.times} times a week`;
  const v = scheduleValue(s);
  if (v === 'daily') return 'Every day';
  if (v === 'weekdays') return 'Weekdays';
  if (v === 'weekends') return 'Weekends';
  return DAY_ORDER.filter((d) => s.days.includes(d))
    .map((d) => DAY_LABELS[d])
    .join(', ');
}

/** The default daily-note property of a habit: its name, lower case, with dashes for spaces. */
export function propertyKey(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
  return key || 'habit';
}

/** True for a daily-note value that checks a habit in. */
export function isCheckedValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return /^(y|yes|true|done|x|✓|✔|✅)$/i.test(value.trim());
  return false;
}

const DATE = /^(\d{4}-\d{2}-\d{2})/;

function dates(value: unknown): Set<string> {
  const out = new Set<string>();
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  for (const v of list) {
    const m = typeof v === 'string' ? DATE.exec(v.trim()) : null;
    if (m) out.add(m[1]);
  }
  return out;
}

/** Daily-note values by day (YYYY-MM-DD), with keys lower-cased. */
export function dailyValues(daily: readonly DailyNoteValues[], settings: Pick<DailyNotesSettings, 'format'>, folder: string): Map<string, Map<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  for (const note of daily) {
    const date = dailyNoteDate(note.path, { format: settings.format, folder });
    if (!date) continue;
    const day = date.format('YYYY-MM-DD');
    const values = out.get(day) ?? new Map<string, unknown>();
    for (const [k, v] of Object.entries(note.values)) values.set(k.toLowerCase(), v);
    out.set(day, values);
  }
  return out;
}

export function habitOf(note: HabitNote, byDay: ReadonlyMap<string, ReadonlyMap<string, unknown>>): Habit {
  const p = note.properties;
  const name = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : basenameOf(lastSegment(note.path));
  const property = typeof p.property === 'string' && p.property.trim() ? p.property.trim() : propertyKey(basenameOf(lastSegment(note.path)));
  const entries = dates(p.entries);
  const fromDaily = new Set<string>();
  const key = property.toLowerCase();
  for (const [day, values] of byDay) if (isCheckedValue(values.get(key))) fromDaily.add(day);
  const done = new Set([...entries, ...fromDaily]);
  const created = typeof p.created === 'string' ? DATE.exec(p.created)?.[1] ?? null : null;
  const first = [...done].sort()[0] ?? null;
  const start = created && first ? (created < first ? created : first) : (created ?? first);
  const maxGap = typeof p.maxGap === 'number' && p.maxGap >= 0 ? Math.floor(p.maxGap) : 0;
  return {
    path: note.path,
    version: note.version,
    name,
    color: typeof p.color === 'string' && p.color.trim() ? p.color.trim() : null,
    schedule: parseSchedule(p.schedule),
    property,
    entries,
    fromDaily,
    done,
    maxGap,
    archived: p.archived === true,
    start,
  };
}

/** The value a daily note has for the habit on `day`, if any. */
export function dailyValue(habit: Pick<Habit, 'property'>, byDay: ReadonlyMap<string, ReadonlyMap<string, unknown>>, day: string): unknown {
  return byDay.get(day)?.get(habit.property.toLowerCase());
}
