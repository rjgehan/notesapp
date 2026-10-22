import { describe, expect, it } from 'vitest';
import { makeList, makeTask } from '../tasks/testing';
import { repeatsByDay } from './repeats';

const home = makeList();
const archived = makeList({ id: 'L9', name: 'Old', archived: true });
const lists = new Map([
  [home.id, home],
  [archived.id, archived],
]);
const weekly = { rrule: 'FREQ=WEEKLY', from: 'due' as const };

function days(map: Map<string, { id: string }[]>): Record<string, string[]> {
  return Object.fromEntries([...map].map(([day, tasks]) => [day, tasks.map((t) => t.id)]));
}

describe('repeatsByDay (DESIGN §6.32)', () => {
  it('projects open tasks repeating from their due date after today and after their date', () => {
    const tasks = [
      makeTask({ id: 'A', due: '2026-10-23', recurrence: weekly }),
      // Overdue: its next occurrences in the past are not shown, the later ones are.
      makeTask({ id: 'B', due: '2026-10-07', recurrence: weekly }),
      // A start date only: the rule runs from it.
      makeTask({ id: 'C', due: null, start: '2026-10-30', recurrence: { rrule: 'FREQ=DAILY;COUNT=2', from: 'due' } }),
    ];
    expect(days(repeatsByDay(tasks, lists, '2026-09-28', '2026-11-08', '2026-10-21'))).toEqual({
      '2026-10-28': ['B'],
      '2026-10-30': ['A'],
      '2026-10-31': ['C'],
      '2026-11-04': ['B'],
      '2026-11-06': ['A'],
    });
  });

  it('leaves out tasks repeating from completion, closed, archived or undated ones, and archived lists', () => {
    const tasks = [
      makeTask({ id: 'A', due: '2026-10-23', recurrence: { rrule: 'FREQ=WEEKLY', from: 'completion' } }),
      makeTask({ id: 'B', due: '2026-10-23', recurrence: weekly, status: 'done' }),
      makeTask({ id: 'C', due: '2026-10-23', recurrence: weekly, archived: true }),
      makeTask({ id: 'D', due: null, recurrence: weekly }),
      makeTask({ id: 'E', due: '2026-10-23', recurrence: weekly, listId: 'L9' }),
      makeTask({ id: 'F', due: '2026-10-23' }),
    ];
    expect(repeatsByDay(tasks, lists, '2026-09-28', '2026-11-08', '2026-10-21').size).toBe(0);
  });

  it('shows nothing for a range that has passed', () => {
    const tasks = [makeTask({ id: 'A', due: '2026-09-01', recurrence: weekly })];
    expect(repeatsByDay(tasks, lists, '2026-09-01', '2026-09-30', '2026-10-21').size).toBe(0);
  });
});
