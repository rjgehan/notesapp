// The coming occurrences of repeating tasks (DESIGN §6.32): a task repeating from its due date
// shows faintly on the later days its rule produces, after today and after its own date, so a
// month shows what is coming. Only a projection: completing the task rolls it forward (API.md
// §20.6). Tasks repeating from their completion are not projected, since their next date depends
// on when they are done. Imports rrule, so only the calendar's lazy chunks load it.
import type { LocalDate, Task, TaskList } from '../api/types';
import { addDays, datePart } from '../tasks/dates';
import { isClosed, scheduled } from '../tasks/model';
import { occurrencesBetween } from '../tasks/recurrence';

export function repeatsByDay(tasks: Iterable<Task>, lists: ReadonlyMap<string, TaskList>, from: LocalDate, to: LocalDate, today: LocalDate): Map<LocalDate, Task[]> {
  const byDay = new Map<LocalDate, Task[]>();
  const first = from > today ? from : addDays(today, 1);
  if (first > to) return byDay;
  for (const t of tasks) {
    if (!t.recurrence || t.recurrence.from !== 'due' || t.archived || isClosed(t)) continue;
    const list = lists.get(t.listId);
    if (!list || list.archived) continue;
    const anchor = scheduled(t);
    if (anchor === null) continue;
    for (const day of occurrencesBetween(t.recurrence.rrule, anchor, first, to)) {
      if (day <= datePart(anchor)) continue;
      const bucket = byDay.get(day);
      if (bucket) bucket.push(t);
      else byDay.set(day, [t]);
    }
  }
  return byDay;
}
