import { describe, expect, it } from 'vitest';
import { firstOccurrence, IMPLIED_DUE, parseQuickAdd, partKey, ruleFromText } from './parse';

// Saturday 17 October 2026, 10:00 local time.
const now = new Date(2026, 9, 17, 10, 0);
const lists = [
  { id: 'inbox', name: 'Inbox', archived: false },
  { id: 'bills', name: 'Bills', archived: false },
  { id: 'reno', name: 'Home Renovation', archived: false },
  { id: 'old', name: 'Old', archived: true },
];
const parse = (text: string, ignore: string[] = [], extra: { noList?: boolean } = {}) => parseQuickAdd(text, { now, lists, ignore: new Set(ignore), ...extra });

describe('quick add parsing (ROADMAP item 4)', () => {
  it('reads the spec example into fields and chips', () => {
    const p = parse('Pay rent tomorrow 9am every month !high #home @Bills [[Apartment]]');
    expect(p.title).toBe('Pay rent [[Apartment]]');
    expect(p.due).toBe('2026-10-18T09:00');
    expect(p.dueImplied).toBe(false);
    expect(p.recurrence).toEqual({ rrule: 'FREQ=MONTHLY', from: 'due' });
    expect(p.priority).toBe(3);
    expect(p.tags).toEqual(['home']);
    expect(p.list).toEqual({ id: 'bills', name: 'Bills' });
    expect(p.links).toEqual(['Apartment']);
    expect(p.parts.map((x) => [x.kind, x.text])).toEqual([
      ['due', 'tomorrow 9am'],
      ['recurrence', 'every month'],
      ['priority', '!high'],
      ['tag', '#home'],
      ['list', '@Bills'],
      ['link', '[[Apartment]]'],
    ]);
  });

  it('reads an hour without am/pm as the next time the clock shows it', () => {
    // Saturday 17 October 2026, 16:45.
    const afternoon = (text: string) => parseQuickAdd(text, { now: new Date(2026, 9, 17, 16, 45), lists }).due;
    expect(afternoon('Call mom at 5 about May trip')).toBe('2026-10-17T17:00');
    expect(afternoon('Call mom at 5:30')).toBe('2026-10-17T17:30');
    expect(afternoon('Call mom today at 5')).toBe('2026-10-17T17:00');
    expect(afternoon('Call mom at 4:30')).toBe('2026-10-18T04:30');
    // Typed with am/pm, or as a 24-hour time, it stays as typed.
    expect(afternoon('Call mom at 5am')).toBe('2026-10-18T05:00');
    expect(afternoon('Call mom at 17')).toBe('2026-10-17T17:00');
    expect(afternoon('Call mom tomorrow at 9')).toBe('2026-10-18T09:00');
    // In the morning the morning hour is next.
    expect(parse('Call mom at 11').due).toBe('2026-10-17T11:00');
  });

  it('keeps an all-day date without a time', () => {
    expect(parse('Dentist oct 30').due).toBe('2026-10-30');
    expect(parse('Dentist oct 30').title).toBe('Dentist');
    expect(parse('Call Bob next friday').due).toBe('2026-10-23');
  });

  it('drops a dangling preposition before the date', () => {
    const p = parse('Finish the report by friday');
    expect(p.title).toBe('Finish the report');
    expect(p.due).toBe('2026-10-23');
  });

  it('reads every priority token, and only as whole words', () => {
    expect(parse('A !med').priority).toBe(2);
    expect(parse('A !medium').priority).toBe(2);
    expect(parse('A !low').priority).toBe(1);
    expect(parse('A !!!').priority).toBe(3);
    expect(parse('Wow!!! great').priority).toBeNull();
    expect(parse('Wow!!! great').title).toBe('Wow!!! great');
  });

  it('matches multi-word list names, else proposes a new list', () => {
    expect(parse('Paint @Home Renovation walls').list).toEqual({ id: 'reno', name: 'Home Renovation' });
    expect(parse('Paint @Home Renovation walls').title).toBe('Paint walls');
    expect(parse('Buy milk @groceries').list).toEqual({ id: null, name: 'groceries' });
    expect(parse('Buy milk @bills').list).toEqual({ id: 'bills', name: 'Bills' });
    // Archived lists are not offered.
    expect(parse('X @Old').list).toEqual({ id: null, name: 'Old' });
    // An e-mail address is not a list.
    expect(parse('Mail bob@example.com').list).toBeNull();
    // A subtask stays in its parent's list.
    expect(parse('X @Bills', [], { noList: true }).list).toBeNull();
    expect(parse('X @Bills', [], { noList: true }).title).toBe('X @Bills');
  });

  it('reads recurrences in the server subset only, without taking the following words', () => {
    expect(parse('Water plants every monday').recurrence?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(parse('Water plants every monday').title).toBe('Water plants');
    expect(parse('every 2 weeks on tuesday standup').recurrence?.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU');
    expect(parse('every 2 weeks on tuesday standup').title).toBe('standup');
    expect(parse('Pay every month on the 1st please').recurrence?.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
    expect(parse('Check every hour').recurrence).toBeNull();
    expect(parse('Check every hour').title).toBe('Check every hour');
    expect(parse('Every banana').recurrence).toBeNull();
  });

  it('dates a recurring task without a date at its first occurrence', () => {
    const p = parse('Water plants every monday');
    expect(p.due).toBe('2026-10-19');
    expect(p.dueImplied).toBe(true);
    expect(parse('Water plants every monday', [IMPLIED_DUE]).due).toBeNull();
    // The weekday is the rule's, not a due date.
    expect(p.parts.some((x) => x.kind === 'due')).toBe(false);
  });

  it('keeps dismissed parts in the title as text', () => {
    const p = parse('Read may report #work', [partKey('due', 'may')]);
    expect(p.due).toBeNull();
    expect(p.title).toBe('Read may report');
    const q = parse('Plan #work trip', [partKey('tag', '#work')]);
    expect(q.tags).toEqual([]);
    expect(q.title).toBe('Plan #work trip');
  });

  it('never reads tags, lists or dates inside links', () => {
    const p = parse('See [[Notes #2 @Home tomorrow]]');
    expect(p.tags).toEqual([]);
    expect(p.list).toBeNull();
    expect(p.due).toBeNull();
    expect(p.title).toBe('See [[Notes #2 @Home tomorrow]]');
  });

  it('collects distinct tags, nested ones included', () => {
    const p = parse('Fix #home/garden fence #Home #home');
    expect(p.tags).toEqual(['home/garden', 'Home']);
    expect(p.title).toBe('Fix fence');
  });
});

describe('recurrence helpers', () => {
  it('turns text into a supported RRULE, FREQ first', () => {
    expect(ruleFromText('every weekday')).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(ruleFromText('every 3 days')).toBe('FREQ=DAILY;INTERVAL=3');
    expect(ruleFromText('every minute')).toBeNull();
    expect(ruleFromText('nonsense')).toBeNull();
  });

  it('finds the first occurrence on or after a day', () => {
    expect(firstOccurrence('FREQ=WEEKLY;BYDAY=SA', '2026-10-17')).toBe('2026-10-17');
    expect(firstOccurrence('FREQ=MONTHLY;BYMONTHDAY=1', '2026-10-17')).toBe('2026-11-01');
    expect(firstOccurrence('FREQ=DAILY', '2026-10-17')).toBe('2026-10-17');
    expect(firstOccurrence('garbage', '2026-10-17')).toBeNull();
  });
});
