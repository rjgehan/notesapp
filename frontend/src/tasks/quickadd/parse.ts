// Quick-add parsing (ROADMAP item 4, "Quick add"): one line such as
//   Pay rent tomorrow 9am every month !high #home @Bills [[Apartment]]
// becomes a title and fields, each recognized part shown as a chip before saving.
//   - `every …` is a recurrence (rrule's text parser), kept only in the server's RRULE subset;
//   - dates and times come from chrono-node (casual English), on the text without the other parts;
//   - `!high`, `!med`, `!low` or `!!!` set the priority;
//   - `#tag` becomes a tag, `@List` the list (the longest list name that matches; otherwise a new
//     list of that one word), and `[[link]]` stays in the title, where it is a backlink.
// A part the user dismisses (its chip's ×) stays in the title as plain text.
// This module is a lazy chunk: chrono-node and rrule load with it, not with the app.
import { casual } from 'chrono-node/en';
import type { TaskDate, TaskList, TaskPriority, TaskRecurrence } from '../../api/types';
import { dayjs } from '../../features/dates';
import { findTags, findWikiLinks } from '../../features/syntax';
import { firstOccurrence, ruleFromText } from '../recurrence';

export type PartKind = 'due' | 'recurrence' | 'priority' | 'tag' | 'list' | 'link';

export interface ParsedPart {
  kind: PartKind;
  /** The text as typed. */
  text: string;
  from: number;
  to: number;
  /** Identifies the part for dismissal: `${kind}:${text}` (lower-cased). */
  key: string;
}

export interface ParsedList {
  /** null: a list of this name does not exist yet and is created on save. */
  id: string | null;
  name: string;
}

export interface ParsedTask {
  title: string;
  due: TaskDate | null;
  /** The due date was not typed: it is the recurrence's first day from today. */
  dueImplied: boolean;
  recurrence: TaskRecurrence | null;
  priority: TaskPriority | null;
  tags: string[];
  list: ParsedList | null;
  /** Wikilink targets in the title (they stay in it). */
  links: string[];
  parts: ParsedPart[];
}

export interface ParseOptions {
  now: Date;
  lists: readonly Pick<TaskList, 'id' | 'name' | 'archived'>[];
  /** Keys of parts the user dismissed. */
  ignore?: ReadonlySet<string>;
  /** `@List` is not read (a subtask always goes to its parent's list). */
  noList?: boolean;
}

export const partKey = (kind: PartKind, text: string) => `${kind}:${text.toLowerCase()}`;

/** The dismissal key of a due date implied by a recurrence. */
export const IMPLIED_DUE = 'due:(implied)';

const PRIORITY: Record<string, TaskPriority> = { '!high': 3, '!!!': 3, '!med': 2, '!medium': 2, '!low': 1 };
const PRIORITY_TOKEN = /(?<!\S)(!high|!medium|!med|!low|!!!)(?!\S)/giu;
const MAX_RULE_WORDS = 10;
/** Prepositions left dangling before a removed date ("Finish report by"). */
const DANGLING = /(?:^|\s)(?:by|on|at|due|before)\s*$/iu;

type Range = [number, number];

const overlaps = (ranges: readonly Range[], from: number, to: number) => ranges.some(([a, b]) => from < b && to > a);

/** `text` with the given ranges replaced by spaces, so offsets (code units) stay valid. */
function mask(text: string, ranges: readonly Range[]): string {
  let out = text;
  for (const [a, b] of ranges) out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
  return out;
}

/** The readable rule, for the recurrence chip (the dialog itself does not load rrule). */
export { recurrenceText as ruleText, ruleFromText, firstOccurrence } from '../recurrence';

interface WordSpan {
  from: number;
  to: number;
  text: string;
}

function wordsFrom(text: string, start: number): WordSpan[] {
  const out: WordSpan[] = [];
  const re = /\S+/gu;
  re.lastIndex = start;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ from: m.index, to: m.index + m[0].length, text: m[0] });
  return out;
}

/** The recurrence phrase starting at `every`: the longest run of words that still adds to the rule. */
function findRecurrence(text: string, taken: readonly Range[], ignore: ReadonlySet<string>): { part: ParsedPart; rrule: string } | null {
  const every = /(?<![\p{L}\p{N}])every(?![\p{L}\p{N}])/giu;
  for (let m = every.exec(text); m; m = every.exec(text)) {
    if (overlaps(taken, m.index, m.index + 5)) continue;
    const words = wordsFrom(text, m.index);
    let bestTo = -1;
    let bestRule: string | null = null;
    for (let n = 2; n <= Math.min(words.length, MAX_RULE_WORDS); n++) {
      const last = words[n - 1];
      // Our own syntax and the parts already taken end the phrase.
      if (/^[!#@]|^\[\[/u.test(last.text) || overlaps(taken, last.from, last.to)) break;
      const rule = ruleFromText(text.slice(m.index, last.to));
      if (rule !== null && rule !== bestRule) {
        bestTo = last.to;
        bestRule = rule;
      }
    }
    if (bestRule === null) continue;
    const raw = text.slice(m.index, bestTo);
    const key = partKey('recurrence', raw);
    if (ignore.has(key)) continue;
    return { part: { kind: 'recurrence', text: raw, from: m.index, to: bestTo, key }, rrule: bestRule };
  }
  return null;
}

/** The list named right after `@`: the longest existing name, else one word for a new list. */
function findList(text: string, at: number, lists: ParseOptions['lists']): { name: string; id: string | null; to: number } | null {
  const rest = text.slice(at + 1);
  const candidates = [...lists].filter((l) => !l.archived).sort((a, b) => b.name.length - a.name.length);
  for (const l of candidates) {
    if (rest.length < l.name.length || rest.slice(0, l.name.length).toLowerCase() !== l.name.toLowerCase()) continue;
    const after = rest[l.name.length];
    if (after === undefined || /\s/u.test(after)) return { name: l.name, id: l.id, to: at + 1 + l.name.length };
  }
  const word = /^[^\s!#@[\]]+/u.exec(rest);
  if (!word) return null;
  const name = word[0].replace(/[.,;:]+$/u, '');
  if (!name) return null;
  const existing = lists.find((l) => !l.archived && l.name.toLowerCase() === name.toLowerCase());
  return { name: existing?.name ?? name, id: existing?.id ?? null, to: at + 1 + name.length };
}

/**
 * chrono's date, with an hour typed without am/pm read as the next time the clock shows it:
 * "at 5" typed at 16:45 is 17:00 today, not 05:00 tomorrow (chrono's forward date). With a day
 * ("today at 5"), the afternoon hour is taken when the morning one has already passed.
 */
function withNextHour(r: ReturnType<typeof casual.parse>[number], now: Date): Date {
  const date = r.start.date();
  const hour = r.start.get('hour');
  if (!r.start.isCertain('hour') || r.start.isCertain('meridiem') || hour === null || hour < 1 || hour > 11) return date;
  const afternoon = new Date(date);
  afternoon.setHours(hour + 12);
  if (r.start.isCertain('day') || r.start.isCertain('weekday')) return date < now && afternoon > now ? afternoon : date;
  const morningToday = new Date(now);
  morningToday.setHours(hour, r.start.get('minute') ?? 0, r.start.get('second') ?? 0, 0);
  const afternoonToday = new Date(morningToday);
  afternoonToday.setHours(hour + 12);
  return [morningToday, afternoonToday].find((d) => d > now) ?? date;
}

export function parseQuickAdd(text: string, opts: ParseOptions): ParsedTask {
  const ignore = opts.ignore ?? new Set<string>();
  const parts: ParsedPart[] = [];
  const taken: Range[] = [];
  const take = (part: ParsedPart) => {
    parts.push(part);
    taken.push([part.from, part.to]);
  };

  // [[links]] stay in the title; nothing inside them is read as a tag, list or date.
  const links: string[] = [];
  for (const l of findWikiLinks(text)) {
    taken.push([l.from, l.to]);
    if (l.embed || !l.target) continue;
    links.push(l.target);
    parts.push({ kind: 'link', text: l.raw, from: l.from, to: l.to, key: partKey('link', l.raw) });
  }
  const linkRanges = [...taken];

  let priority: TaskPriority | null = null;
  for (const m of text.matchAll(PRIORITY_TOKEN)) {
    const key = partKey('priority', m[0]);
    if (ignore.has(key) || overlaps(taken, m.index, m.index + m[0].length)) continue;
    priority = PRIORITY[m[0].toLowerCase()];
    take({ kind: 'priority', text: m[0], from: m.index, to: m.index + m[0].length, key });
  }

  const tags: string[] = [];
  for (const t of findTags(text)) {
    const raw = text.slice(t.from, t.to);
    const key = partKey('tag', raw);
    if (ignore.has(key) || overlaps(taken, t.from, t.to)) continue;
    if (!tags.some((x) => x.toLowerCase() === t.tag.toLowerCase())) tags.push(t.tag);
    take({ kind: 'tag', text: raw, from: t.from, to: t.to, key });
  }

  let list: ParsedList | null = null;
  if (!opts.noList) {
    for (const m of text.matchAll(/(?<!\S)@/gu)) {
      if (overlaps(taken, m.index, m.index + 1)) continue;
      const found = findList(text, m.index, opts.lists);
      if (!found) continue;
      const raw = text.slice(m.index, found.to);
      const key = partKey('list', raw);
      if (ignore.has(key)) continue;
      list = { id: found.id, name: found.name };
      take({ kind: 'list', text: raw, from: m.index, to: found.to, key });
      break;
    }
  }

  let recurrence: TaskRecurrence | null = null;
  const rule = findRecurrence(text, taken, ignore);
  if (rule) {
    recurrence = { rrule: rule.rrule, from: 'due' };
    take(rule.part);
  }

  let due: TaskDate | null = null;
  const masked = mask(text, taken);
  for (const r of casual.parse(masked, opts.now, { forwardDate: true })) {
    const raw = text.slice(r.index, r.index + r.text.length);
    const key = partKey('due', raw);
    if (ignore.has(key)) continue;
    const day = dayjs(withNextHour(r, opts.now));
    due = r.start.isCertain('hour') ? day.format('YYYY-MM-DDTHH:mm') : day.format('YYYY-MM-DD');
    take({ kind: 'due', text: raw, from: r.index, to: r.index + r.text.length, key });
    break;
  }
  // A recurring task needs a date to count from: its first occurrence from today.
  let dueImplied = false;
  if (recurrence && due === null && !ignore.has(IMPLIED_DUE)) {
    due = firstOccurrence(recurrence.rrule, dayjs(opts.now).format('YYYY-MM-DD'));
    dueImplied = due !== null;
  }

  // The title: the text without the parts it does not keep (links stay), whitespace collapsed.
  const removed = taken
    .filter(([a, b]) => !linkRanges.some(([x, y]) => x === a && y === b))
    .sort((x, y) => x[0] - y[0]);
  let title = '';
  let pos = 0;
  for (const [a, b] of removed) {
    let before = text.slice(pos, a);
    if (parts.some((p) => p.kind === 'due' && p.from === a)) before = before.replace(DANGLING, ' ');
    title += before + ' ';
    pos = b;
  }
  title += text.slice(pos);
  title = title.replace(/\s+/gu, ' ').trim();

  parts.sort((a, b) => a.from - b.from);
  return { title, due, dueImplied, recurrence, priority, tags, list, links, parts };
}
