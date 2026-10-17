// Recurrence rules (API.md §20.6) on the client: reading typed text into an RRULE (rrule's text
// parser), the readable form (rrule's toText, ROADMAP item 4), the first occurrence, and the
// presets of the detail sheet. Imported by lazy chunks only, so rrule stays out of the main one.
import { Frequency, RRule, type Options } from 'rrule';
import type { LocalDate, TaskDate } from '../api/types';
import { datePart } from './dates';

/** The frequencies the server evaluates (§20.6). */
const SUPPORTED = new Set<Frequency>([Frequency.YEARLY, Frequency.MONTHLY, Frequency.WEEKLY, Frequency.DAILY]);

/** 'every week on Monday'; the raw rule when rrule cannot read it (a hand edit). */
export function recurrenceText(rrule: string): string {
  try {
    return RRule.fromString('RRULE:' + rrule.replace(/^RRULE:/i, '')).toText();
  } catch {
    return rrule;
  }
}

/** The RRULE value (without `RRULE:`), FREQ first, or null when the text is not a supported rule. */
export function ruleFromText(text: string): string | null {
  let options: Partial<Options> | null;
  try {
    options = RRule.parseText(text);
  } catch {
    return null;
  }
  if (!options || options.freq === undefined || options.freq === null || !SUPPORTED.has(options.freq)) return null;
  const { dtstart: _start, tzid: _tz, ...rest } = options;
  const parts = RRule.optionsToString(rest).replace(/^RRULE:/, '').split(';').filter(Boolean);
  parts.sort((a, b) => (a.startsWith('FREQ=') ? -1 : b.startsWith('FREQ=') ? 1 : 0));
  return parts.join(';');
}

function utcDate(date: LocalDate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The first day on or after `from` that the rule produces (a recurring task typed without a date). */
export function firstOccurrence(rrule: string, from: LocalDate): LocalDate | null {
  try {
    const options = RRule.parseString(rrule);
    const rule = new RRule({ ...options, dtstart: utcDate(from) });
    const next = rule.after(utcDate(from), true);
    return next ? next.toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface RecurrencePreset {
  id: string;
  label: string;
  rrule: string;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Common rules; the weekly, monthly and yearly ones follow the task's date when it has one. */
export function recurrencePresets(date: TaskDate | null): RecurrencePreset[] {
  const day = date ? new Date(`${datePart(date)}T00:00:00`) : null;
  const weekly = day ? `FREQ=WEEKLY;BYDAY=${DAYS[day.getDay()]}` : 'FREQ=WEEKLY';
  const monthly = day ? `FREQ=MONTHLY;BYMONTHDAY=${day.getDate()}` : 'FREQ=MONTHLY';
  const yearly = day ? `FREQ=YEARLY;BYMONTH=${day.getMonth() + 1};BYMONTHDAY=${day.getDate()}` : 'FREQ=YEARLY';
  return [
    { id: 'daily', label: 'Every day', rrule: 'FREQ=DAILY' },
    { id: 'weekdays', label: 'Every weekday', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { id: 'weekly', label: capitalized(recurrenceText(weekly)), rrule: weekly },
    { id: 'monthly', label: capitalized(recurrenceText(monthly)), rrule: monthly },
    { id: 'yearly', label: capitalized(recurrenceText(yearly)), rrule: yearly },
  ];
}
