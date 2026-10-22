// Reminder presets for the task detail sheet (ROADMAP item 4c, DESIGN §6.38): quick choices
// relative to the task's due date and to now, each a local 'YYYY-MM-DDTHH:mm' like every task date.
import type { LocalDateTime, Task } from '../api/types';
import { dayjs } from '../features/dates';
import { addDays, datePart, timePart } from './dates';

export interface ReminderPreset {
  id: string;
  label: string;
  at: LocalDateTime;
}

const FORMAT = 'YYYY-MM-DDTHH:mm';

/** The presets that make sense for this task now, without the ones it already has or that are past. */
export function reminderPresets(task: Pick<Task, 'due' | 'reminders'>, now: Date = new Date()): ReminderPreset[] {
  const out: ReminderPreset[] = [];
  const nowText = dayjs(now).format(FORMAT);
  if (task.due) {
    const day = datePart(task.due);
    const time = timePart(task.due);
    if (time) {
      out.push({ id: 'due', label: 'At the due time', at: `${day}T${time}` });
      out.push({ id: 'due-15', label: '15 minutes before', at: dayjs(`${day}T${time}`, FORMAT).subtract(15, 'minute').format(FORMAT) });
      out.push({ id: 'due-60', label: '1 hour before', at: dayjs(`${day}T${time}`, FORMAT).subtract(1, 'hour').format(FORMAT) });
    } else {
      out.push({ id: 'due-morning', label: 'On the due day at 9:00', at: `${day}T09:00` });
    }
    out.push({ id: 'day-before', label: 'The day before at 18:00', at: `${addDays(day, -1)}T18:00` });
  }
  // Rounded up to the next 5 minutes, so an hour from now reads as a time someone would pick.
  const inAnHour = dayjs(now).add(1, 'hour');
  const rounded = inAnHour.add((5 - (inAnHour.minute() % 5)) % 5, 'minute').second(0);
  out.push({ id: 'in-1h', label: 'In 1 hour', at: rounded.format(FORMAT) });
  out.push({ id: 'tomorrow', label: 'Tomorrow at 9:00', at: `${dayjs(now).add(1, 'day').format('YYYY-MM-DD')}T09:00` });
  const seen = new Set(task.reminders.map((r) => r.at));
  const unique: ReminderPreset[] = [];
  for (const p of out) {
    if (p.at <= nowText || seen.has(p.at)) continue;
    seen.add(p.at);
    unique.push(p);
  }
  return unique;
}
