import { describe, expect, it } from 'vitest';
import {
  defaultDraft,
  draftFromRule,
  nextOccurrence,
  recurrencePresets,
  recurrenceText,
  rollForward,
  ruleFromDraft,
  upcomingOccurrences,
  validateRule,
} from './recurrence';

describe('readable rules (rrule toText)', () => {
  it('reads rules, and COUNT as the occurrences left', () => {
    expect(recurrenceText('FREQ=WEEKLY;BYDAY=MO')).toBe('every week on Monday');
    expect(recurrenceText('FREQ=DAILY;COUNT=3')).toBe('every day, 3 more times');
    expect(recurrenceText('FREQ=DAILY;COUNT=1')).toBe('every day, this time only');
    expect(recurrenceText('RRULE:FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('every month on the last day');
    expect(recurrenceText('garbage')).toBe('garbage');
  });

  it('offers presets that follow the task’s date', () => {
    const presets = recurrencePresets('2026-10-14T08:00');
    expect(presets.map((p) => p.rrule)).toEqual([
      'FREQ=DAILY',
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      'FREQ=WEEKLY;BYDAY=WE',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
      'FREQ=MONTHLY;BYMONTHDAY=14',
      'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=14',
    ]);
    expect(presets[3].label).toBe('Every 2 weeks on Wednesday');
  });
});

describe('typed RRULEs (the server subset, API.md §20.6)', () => {
  it('accepts the subset in the stored form', () => {
    expect(validateRule('RRULE:freq=monthly;byday=2tu')).toEqual({ rrule: 'FREQ=MONTHLY;BYDAY=2TU' });
    expect(validateRule('FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO')).toEqual({ rrule: 'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO' });
    expect(validateRule('FREQ=WEEKLY;UNTIL=20261231T235959Z')).toEqual({ rrule: 'FREQ=WEEKLY;UNTIL=20261231T235959Z' });
  });

  it('refuses what the server refuses, with a reason', () => {
    const error = (text: string) => ('error' in validateRule(text) ? (validateRule(text) as { error: string }).error : null);
    expect(error('FREQ=HOURLY')).toMatch(/FREQ must be/);
    expect(error('FREQ=DAILY;BYSECOND=3')).toMatch(/BYSECOND is not supported/);
    expect(error('FREQ=DAILY;COUNT=2;UNTIL=20270101')).toMatch(/cannot be combined/);
    expect(error('FREQ=DAILY;FREQ=WEEKLY')).toMatch(/appears twice/);
    expect(error('FREQ=DAILY;INTERVAL=0')).toMatch(/whole number/);
    expect(error('FREQ=DAILY;UNTIL=20261340')).toMatch(/UNTIL must be/);
    expect(error('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30')).toMatch(/never repeats/);
    expect(error('')).toMatch(/single RRULE/);
  });
});

describe('the rule editor draft', () => {
  it('starts from the task’s date', () => {
    expect(defaultDraft('2026-10-14')).toMatchObject({ freq: 'WEEKLY', byDay: ['WE'], monthDay: 14, setPos: 2, weekday: 'WE', month: 10, end: 'never' });
    expect(defaultDraft('2026-10-30').setPos).toBe(-1);
  });

  it('round-trips the common shapes', () => {
    for (const rule of [
      'FREQ=DAILY',
      'FREQ=DAILY;INTERVAL=3',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
      'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYDAY=-1FR;COUNT=5',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;UNTIL=20300101',
      'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH',
    ]) {
      const draft = draftFromRule(rule, '2026-10-14');
      expect(draft, rule).not.toBeNull();
      expect(ruleFromDraft(draft!)).toBe(rule);
    }
  });

  it('reads BYSETPOS with one weekday, and fills what a rule leaves out from the date', () => {
    expect(ruleFromDraft(draftFromRule('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2', '2026-10-14')!)).toBe('FREQ=MONTHLY;BYDAY=2TU');
    expect(ruleFromDraft(draftFromRule('FREQ=MONTHLY', '2026-10-14')!)).toBe('FREQ=MONTHLY;BYMONTHDAY=14');
  });

  it('leaves rules it cannot show to the RRULE field', () => {
    expect(draftFromRule('FREQ=YEARLY;BYYEARDAY=100', '2026-10-14')).toBeNull();
    expect(draftFromRule('FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1', '2026-10-14')).toBeNull();
    expect(draftFromRule('FREQ=DAILY;BYHOUR=9', '2026-10-14')).toBeNull();
    expect(draftFromRule('FREQ=YEARLY;BYMONTHDAY=1', '2026-10-14')).toBeNull();
    expect(draftFromRule('nonsense', '2026-10-14')).toBeNull();
  });
});

describe('rolling forward, as the server does (API.md §20.6 examples, completed on Wednesday 2026-10-14)', () => {
  const day = '2026-10-14';
  it('follows the documented examples', () => {
    expect(nextOccurrence('FREQ=WEEKLY', 'due', '2026-10-14T08:00', day)?.value).toBe('2026-10-21T08:00');
    expect(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=-1', 'due', '2026-09-30', day)?.value).toBe('2026-10-31');
    expect(nextOccurrence('FREQ=MONTHLY', 'due', '2026-01-31', day)?.value).toBe('2026-10-31');
  });

  it('skips the occurrences missed by an overdue task, or counts from completion', () => {
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=WE', 'due', '2026-09-23', day)?.value).toBe('2026-10-21');
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', 'completion', '2026-10-01', day)?.value).toBe('2026-10-17');
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', 'completion', '2026-10-01T07:30', day)?.value).toBe('2026-10-17T07:30');
    expect(nextOccurrence('FREQ=DAILY', 'due', '2026-10-20', day)?.value).toBe('2026-10-21');
  });

  it('counts COUNT down and stops at the last occurrence or after UNTIL', () => {
    expect(nextOccurrence('FREQ=DAILY;COUNT=3', 'due', day, day)).toEqual({ value: '2026-10-15', rrule: 'FREQ=DAILY;COUNT=2' });
    expect(nextOccurrence('FREQ=DAILY;COUNT=1', 'due', day, day)).toBeNull();
    expect(nextOccurrence('FREQ=WEEKLY;UNTIL=20261020', 'due', day, day)).toBeNull();
    expect(nextOccurrence('FREQ=WEEKLY;UNTIL=20261021', 'due', day, day)?.value).toBe('2026-10-21');
    expect(nextOccurrence('FREQ=SECONDLY', 'due', day, day)).toBeUndefined();
    expect(nextOccurrence('BYSECOND=1', 'due', day, day)).toBeUndefined();
  });

  it('moves the other date and the reminders by as many days', () => {
    const patch = rollForward(
      { due: '2026-10-14T08:00', start: '2026-10-12', recurrence: { rrule: 'FREQ=WEEKLY', from: 'due' }, reminders: [{ at: '2026-10-14T07:45' }] },
      day,
    );
    expect(patch).toEqual({ due: '2026-10-21T08:00', start: '2026-10-19', recurrence: { rrule: 'FREQ=WEEKLY', from: 'due' }, reminders: [{ at: '2026-10-21T07:45' }] });
    expect(rollForward({ due: null, start: '2026-10-14', recurrence: { rrule: 'FREQ=DAILY', from: 'due' }, reminders: [] }, day)).toMatchObject({ start: '2026-10-15' });
    expect(rollForward({ due: null, start: null, recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=FR', from: 'due' }, reminders: [] }, day)).toMatchObject({ due: '2026-10-16' });
    expect(rollForward({ due: day, start: null, recurrence: { rrule: 'FREQ=DAILY;COUNT=1', from: 'due' }, reminders: [] }, day)).toBeNull();
  });
});

describe('the preview of the next occurrences', () => {
  it('lists the occurrences after the task’s date, within COUNT and UNTIL', () => {
    expect(upcomingOccurrences('FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-15', '2026-10-01')).toEqual(['2026-10-19', '2026-10-22', '2026-10-26']);
    expect(upcomingOccurrences('FREQ=DAILY;COUNT=2', '2026-10-15T09:00', '2026-10-01')).toEqual(['2026-10-16T09:00']);
    expect(upcomingOccurrences('FREQ=DAILY;UNTIL=20261016', null, '2026-10-15')).toEqual(['2026-10-16']);
    expect(upcomingOccurrences('garbage', null, '2026-10-15')).toEqual([]);
  });
});
