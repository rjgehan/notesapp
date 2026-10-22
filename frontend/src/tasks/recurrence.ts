// Recurrence rules (API.md §20.6) on the client: reading typed text into an RRULE (rrule's text
// parser), the readable form (rrule's toText, ROADMAP item 4), the rule editor's model (a draft
// of the common rule shapes, and raw RRULEs checked against the server's subset), the preview of
// the next occurrences, and the roll-forward of a completed task, mirrored from the server's
// `Recurrence.next` so a completion shows its next date before the server answers. Imported by
// lazy chunks only (`loadRecurrence` for the main chunk), so rrule stays out of the main one.
import { Frequency, RRule, type Options } from 'rrule';
import type { LocalDate, Task, TaskDate, TaskReminder } from '../api/types';
import { addDays, datePart, timePart } from './dates';

/** The frequencies the server evaluates (§20.6). */
const SUPPORTED = new Set<Frequency>([Frequency.YEARLY, Frequency.MONTHLY, Frequency.WEEKLY, Frequency.DAILY]);

/** The parts of the server's subset (Recurrence.PARTS). */
const PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS', 'WKST', 'BYHOUR', 'BYMINUTE']);
const FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const NUMBER = /^[1-9][0-9]{0,4}$/;
const UNTIL = /^(\d{8})(T\d{6}Z?)?$/;
const MAX_LENGTH = 300;

/** 'every week on Monday', with COUNT read as what it is here (occurrences left); the raw rule when rrule cannot read it. */
export function recurrenceText(rrule: string): string {
  try {
    const text = RRule.fromString('RRULE:' + rrule.replace(/^RRULE:/i, '')).toText();
    return text
      .replace(/ on the last$/, ' on the last day')
      .replace(/ for (\d+) times?$/, (_, n: string) => (n === '1' ? ', this time only' : `, ${n} more times`));
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

/** A floating date (or date-time) as rrule's "UTC means local" Date. */
function utcOf(value: TaskDate): Date {
  const [y, m, d] = datePart(value).split('-').map(Number);
  const time = timePart(value);
  const [h, min] = time ? time.split(':').map(Number) : [0, 0];
  return new Date(Date.UTC(y, m - 1, d, h, min));
}

function dateOf(d: Date): LocalDate {
  return d.toISOString().slice(0, 10);
}

function valueOf(d: Date, timed: boolean): TaskDate {
  return timed ? d.toISOString().slice(0, 16) : dateOf(d);
}

/** The first day on or after `from` that the rule produces (a recurring task typed without a date). */
export function firstOccurrence(rrule: string, from: LocalDate): LocalDate | null {
  try {
    const options = RRule.parseString(rrule);
    const rule = new RRule({ ...options, dtstart: utcOf(from) });
    const next = rule.after(utcOf(from), true);
    return next ? dateOf(next) : null;
  } catch {
    return null;
  }
}

// ---------- the server's subset (Recurrence.normalize) ----------

/** The rule's parts, upper case, in order; throws with a message for the user. */
export function ruleParts(rrule: string): Map<string, string> {
  let rule = rrule.trim();
  if (/^RRULE:/i.test(rule)) rule = rule.slice(6).trim();
  if (rule === '' || rule.length > MAX_LENGTH || /[\r\n]/.test(rule)) throw new Error(`Must be a single RRULE of at most ${MAX_LENGTH} characters`);
  const parts = new Map<string, string>();
  for (const part of rule.toUpperCase().split(';')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) throw new Error('Each part must be NAME=VALUE');
    const name = part.slice(0, eq);
    if (!PARTS.has(name)) throw new Error(`${name} is not supported`);
    if (parts.has(name)) throw new Error(`${name} appears twice`);
    parts.set(name, part.slice(eq + 1));
  }
  return parts;
}

function joinParts(parts: ReadonlyMap<string, string>): string {
  return [...parts].map(([k, v]) => `${k}=${v}`).join(';');
}

function untilDate(value: string): LocalDate | null {
  const m = UNTIL.exec(value);
  if (!m) return null;
  const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && dateOf(d) === date ? date : null;
}

/** A rule without COUNT and UNTIL (the app handles those), bounded so a rule that never matches cannot spin. */
function evaluator(parts: ReadonlyMap<string, string>, dtstart: Date, timed: boolean): RRule {
  const open = new Map(parts);
  open.delete('COUNT');
  open.delete('UNTIL');
  if (!timed) {
    open.delete('BYHOUR');
    open.delete('BYMINUTE');
  }
  const options = RRule.parseString(joinParts(open));
  const horizon = new Date(dtstart.getTime());
  horizon.setUTCFullYear(horizon.getUTCFullYear() + 50);
  return new RRule({ ...options, dtstart, until: horizon });
}

/**
 * Checks a typed RRULE against the server's subset (API.md §20.6): the stored form (upper case,
 * without `RRULE:`), or the reason it would be refused.
 */
export function validateRule(text: string): { rrule: string } | { error: string } {
  let parts: Map<string, string>;
  try {
    parts = ruleParts(text);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const freq = parts.get('FREQ');
  if (!freq || !FREQUENCIES.has(freq)) return { error: 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY' };
  for (const numeric of ['INTERVAL', 'COUNT']) {
    const value = parts.get(numeric);
    if (value !== undefined && !NUMBER.test(value)) return { error: `${numeric} must be a whole number from 1 to 99999` };
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) return { error: 'COUNT and UNTIL cannot be combined' };
  const until = parts.get('UNTIL');
  if (until !== undefined && untilDate(until) === null) return { error: 'UNTIL must be a date (YYYYMMDD) or a date-time (YYYYMMDDTHHMMSSZ)' };
  try {
    const probe = utcOf('2026-01-01');
    const rule = evaluator(parts, probe, false);
    if (!rule.after(probe, true) && !evaluator(parts, utcOf('2026-01-01T09:00'), true).after(probe, true)) return { error: 'This rule never repeats' };
  } catch (e) {
    return { error: `Not a valid RRULE: ${(e as Error).message}` };
  }
  return { rrule: joinParts(parts) };
}

// ---------- the rule editor's draft ----------

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const JS_DAYS: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The common rule shapes, as the editor's controls show them. */
export interface RuleDraft {
  freq: Freq;
  /** Every `interval` days, weeks, months or years. */
  interval: number;
  /** WEEKLY: the days of the week (none: the day of the task's date). */
  byDay: Weekday[];
  /** MONTHLY and YEARLY: a day of the month, or the nth weekday ("the second Tuesday"). */
  monthBy: 'day' | 'weekday';
  /** 1 to 31, or -1 for the last day. */
  monthDay: number;
  /** 1 to 4, or -1 for the last. */
  setPos: number;
  weekday: Weekday;
  /** YEARLY: 1 to 12. */
  month: number;
  end: 'never' | 'count' | 'until';
  /** Occurrences left, this one included (§20.6). */
  count: number;
  until: LocalDate;
}

/** A starting draft that follows a date: weekly on its weekday, monthly on its day, and so on. */
export function defaultDraft(date: LocalDate): RuleDraft {
  const d = utcOf(date);
  const day = d.getUTCDate();
  const lastWeek = day + 7 > new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    freq: 'WEEKLY',
    interval: 1,
    byDay: [JS_DAYS[d.getUTCDay()]],
    monthBy: 'day',
    monthDay: day,
    setPos: lastWeek && day > 28 ? -1 : Math.min(4, Math.ceil(day / 7)),
    weekday: JS_DAYS[d.getUTCDay()],
    month: d.getUTCMonth() + 1,
    end: 'never',
    count: 10,
    until: addDays(date, 90),
  };
}

const NTH_DAY = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/;

/**
 * The draft of a rule, from the task's date for the parts the rule leaves out; null when the rule
 * uses something the draft cannot show (BYYEARDAY, several months, times, ...): the editor then
 * shows it as an RRULE.
 */
export function draftFromRule(rrule: string, date: LocalDate): RuleDraft | null {
  let parts: Map<string, string>;
  try {
    parts = ruleParts(rrule);
  } catch {
    return null;
  }
  const draft = defaultDraft(date);
  const freq = parts.get('FREQ');
  if (!freq || !FREQUENCIES.has(freq)) return null;
  draft.freq = freq as Freq;
  for (const [name, value] of parts) {
    switch (name) {
      case 'FREQ':
        break;
      case 'INTERVAL':
        if (!NUMBER.test(value)) return null;
        draft.interval = Number(value);
        break;
      case 'COUNT':
        if (!NUMBER.test(value)) return null;
        draft.end = 'count';
        draft.count = Number(value);
        break;
      case 'UNTIL': {
        const until = untilDate(value);
        if (!until) return null;
        draft.end = 'until';
        draft.until = until;
        break;
      }
      case 'BYDAY': {
        const days = value.split(',').map((v) => NTH_DAY.exec(v));
        if (days.some((m) => !m)) return null;
        if (draft.freq === 'WEEKLY') {
          if (days.some((m) => m![1])) return null;
          draft.byDay = WEEKDAYS.filter((w) => days.some((m) => m![2] === w));
        } else if (draft.freq === 'MONTHLY' || draft.freq === 'YEARLY') {
          const pos = days.length === 1 ? Number(days[0]![1] ?? parts.get('BYSETPOS') ?? NaN) : NaN;
          if (!(pos === -1 || (pos >= 1 && pos <= 4))) return null;
          draft.monthBy = 'weekday';
          draft.setPos = pos;
          draft.weekday = days[0]![2] as Weekday;
        } else {
          return null;
        }
        break;
      }
      case 'BYSETPOS':
        // Only as the position of a single BYDAY ("BYDAY=TU;BYSETPOS=2").
        if (!parts.has('BYDAY') || parts.get('BYDAY')!.includes(',') || NTH_DAY.exec(parts.get('BYDAY')!)?.[1]) return null;
        break;
      case 'BYMONTHDAY': {
        const n = Number(value);
        if (draft.freq !== 'MONTHLY' && draft.freq !== 'YEARLY') return null;
        if (!Number.isInteger(n) || !(n === -1 || (n >= 1 && n <= 31))) return null;
        draft.monthBy = 'day';
        draft.monthDay = n;
        break;
      }
      case 'BYMONTH': {
        const n = Number(value);
        if (draft.freq !== 'YEARLY' || !Number.isInteger(n) || n < 1 || n > 12) return null;
        draft.month = n;
        break;
      }
      default:
        return null;
    }
  }
  if (draft.freq === 'YEARLY' && !parts.has('BYMONTH') && (parts.has('BYMONTHDAY') || parts.has('BYDAY'))) return null;
  return draft;
}

function untilValue(date: LocalDate): string {
  return date.replaceAll('-', '');
}

/** The RRULE of a draft, FREQ first, as the server stores it. */
export function ruleFromDraft(d: RuleDraft): string {
  const parts: string[] = [`FREQ=${d.freq}`];
  if (d.interval > 1) parts.push(`INTERVAL=${Math.min(99999, Math.floor(d.interval))}`);
  const nth = `${d.setPos}${d.weekday}`;
  if (d.freq === 'WEEKLY' && d.byDay.length > 0) parts.push(`BYDAY=${WEEKDAYS.filter((w) => d.byDay.includes(w)).join(',')}`);
  if (d.freq === 'MONTHLY') parts.push(d.monthBy === 'day' ? `BYMONTHDAY=${d.monthDay}` : `BYDAY=${nth}`);
  if (d.freq === 'YEARLY') parts.push(`BYMONTH=${d.month}`, d.monthBy === 'day' ? `BYMONTHDAY=${d.monthDay}` : `BYDAY=${nth}`);
  if (d.end === 'count') parts.push(`COUNT=${Math.min(99999, Math.max(1, Math.floor(d.count)))}`);
  if (d.end === 'until') parts.push(`UNTIL=${untilValue(d.until)}`);
  return parts.join(';');
}

// ---------- occurrences ----------

/**
 * The occurrence after the one being completed, mirrored from the server (API.md §20.6,
 * `Recurrence.next`): null when the rule has no more (the task closes), undefined when the rule
 * cannot be evaluated here. `anchor` is the due date, else the start date.
 */
export function nextOccurrence(rrule: string, from: 'due' | 'completion', anchor: TaskDate | null, completionDay: LocalDate): { value: TaskDate; rrule: string } | null | undefined {
  let parts: Map<string, string>;
  try {
    parts = ruleParts(rrule);
  } catch {
    return undefined;
  }
  if (!FREQUENCIES.has(parts.get('FREQ') ?? '')) return undefined;
  const countValue = parts.get('COUNT');
  const count = countValue !== undefined ? Number(countValue) : null;
  if (count !== null && count <= 1) return null;
  const untilValue = parts.get('UNTIL');
  const until = untilValue !== undefined ? untilDate(untilValue) : null;
  const timed = anchor !== null && anchor.length > 10;
  const fromDue = from === 'due' && anchor !== null;
  const start = utcOf(fromDue ? anchor : timed ? `${completionDay}T${timePart(anchor)}` : completionDay);
  const earliest = fromDue ? utcOf(addDays(completionDay, 1)) : null;
  try {
    const rule = evaluator(parts, start, timed);
    const next = earliest && earliest > start ? rule.after(earliest, true) : rule.after(start, false);
    if (!next) return null;
    if (until && dateOf(next) > until) return null;
    if (count !== null) parts.set('COUNT', String(count - 1));
    return { value: valueOf(next, timed), rrule: count !== null ? joinParts(parts) : rrule };
  } catch {
    return undefined;
  }
}

function shift(value: TaskDate, days: number): TaskDate {
  const time = timePart(value);
  const day = addDays(datePart(value), days);
  return time ? `${day}T${time}` : day;
}

function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((utcOf(b).getTime() - utcOf(a).getTime()) / 86_400_000);
}

/**
 * What completing a recurring task on `day` does, as the server will do it (TaskService
 * `rollForward`): the due date (else the start date) moves to the next occurrence, the other date
 * and the reminders by as many days, and COUNT goes down. `null`: the task closes. `undefined`:
 * unknown here (the server decides).
 */
export function rollForward(task: Pick<Task, 'due' | 'start' | 'recurrence' | 'reminders'>, day: LocalDate): Partial<Task> | null | undefined {
  if (!task.recurrence) return null;
  const anchor = task.due ?? task.start;
  const next = nextOccurrence(task.recurrence.rrule, task.recurrence.from, anchor, day);
  if (!next) return next;
  const nextDay = datePart(next.value);
  const patch: Partial<Task> = { recurrence: { ...task.recurrence, rrule: next.rrule } };
  let days: number;
  if (task.due !== null) {
    days = daysBetween(datePart(task.due), nextDay);
    patch.due = next.value;
    if (task.start !== null) patch.start = shift(task.start, days);
  } else if (task.start !== null) {
    days = daysBetween(datePart(task.start), nextDay);
    patch.start = next.value;
  } else {
    days = daysBetween(day, nextDay);
    patch.due = next.value;
  }
  patch.reminders = task.reminders.map((r): TaskReminder => ({ ...r, at: shift(r.at, days) }));
  return patch;
}

/**
 * The next `n` occurrences after `anchor` (the task's date, else `today`), honouring COUNT
 * (occurrences left, this one included) and UNTIL: the editor's preview.
 */
export function upcomingOccurrences(rrule: string, anchor: TaskDate | null, today: LocalDate, n = 3): TaskDate[] {
  let parts: Map<string, string>;
  try {
    parts = ruleParts(rrule);
  } catch {
    return [];
  }
  const timed = anchor !== null && anchor.length > 10;
  const start = utcOf(anchor ?? today);
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) - 1 : Infinity;
  const until = parts.has('UNTIL') ? untilDate(parts.get('UNTIL')!) : null;
  try {
    const rule = evaluator(parts, start, timed);
    const out: TaskDate[] = [];
    let at = start;
    while (out.length < Math.min(n, count)) {
      const next = rule.after(at, false);
      if (!next || (until && dateOf(next) > until)) break;
      out.push(valueOf(next, timed));
      at = next;
    }
    return out;
  } catch {
    return [];
  }
}

/** At most this many occurrences are read from a rule's start: a bound for daily rules started long ago. */
const MAX_SCAN = 2000;

/**
 * The days of the occurrences after `anchor` (the task's date) that fall from `from` to `to`,
 * honouring COUNT (occurrences left, this one included) and UNTIL: the calendar's projection of
 * a repeating task (DESIGN §6.32). One pass over the rule; empty when it cannot be evaluated.
 */
export function occurrencesBetween(rrule: string, anchor: TaskDate, from: LocalDate, to: LocalDate): LocalDate[] {
  let parts: Map<string, string>;
  try {
    parts = ruleParts(rrule);
  } catch {
    return [];
  }
  if (!FREQUENCIES.has(parts.get('FREQ') ?? '') || to < from || datePart(anchor) > to) return [];
  const timed = anchor.length > 10;
  const start = utcOf(anchor);
  const left = parts.has('COUNT') ? Number(parts.get('COUNT')) - 1 : Infinity;
  const until = parts.has('UNTIL') ? untilDate(parts.get('UNTIL')!) : null;
  const end = new Date(utcOf(addDays(to, 1)).getTime() - 1);
  try {
    const rule = evaluator(parts, start, timed);
    const all = rule.between(start, end, false, (_, i) => i < MAX_SCAN);
    const out: LocalDate[] = [];
    for (let i = 0; i < all.length && i < left; i++) {
      const day = dateOf(all[i]);
      if (until && day > until) break;
      if (day >= from && out[out.length - 1] !== day) out.push(day);
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- presets ----------

export interface RecurrencePreset {
  id: string;
  label: string;
  rrule: string;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The readable rule with a capital letter, for menus and labels. */
export function recurrenceLabel(rrule: string): string {
  return capitalized(recurrenceText(rrule));
}

/** Common rules; the weekly, monthly and yearly ones follow the task's date when it has one. */
export function recurrencePresets(date: TaskDate | null): RecurrencePreset[] {
  const day = date ? utcOf(datePart(date)) : null;
  const weekly = day ? `FREQ=WEEKLY;BYDAY=${JS_DAYS[day.getUTCDay()]}` : 'FREQ=WEEKLY';
  const monthly = day ? `FREQ=MONTHLY;BYMONTHDAY=${day.getUTCDate()}` : 'FREQ=MONTHLY';
  const yearly = day ? `FREQ=YEARLY;BYMONTH=${day.getUTCMonth() + 1};BYMONTHDAY=${day.getUTCDate()}` : 'FREQ=YEARLY';
  return [
    { id: 'daily', label: 'Every day', rrule: 'FREQ=DAILY' },
    { id: 'weekdays', label: 'Every weekday', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { id: 'weekly', label: recurrenceLabel(weekly), rrule: weekly },
    { id: 'biweekly', label: recurrenceLabel(weekly.replace('FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2')), rrule: weekly.replace('FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2') },
    { id: 'monthly', label: recurrenceLabel(monthly), rrule: monthly },
    { id: 'yearly', label: recurrenceLabel(yearly), rrule: yearly },
  ];
}
