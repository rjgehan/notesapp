// Pieces of the habits page and panel (DESIGN §6.35): the check button, a habit's row, the week
// strip and the day picker.
import { Check, Flame } from 'lucide-react';
import type { CSSProperties } from 'react';
import { dayjs } from '../../features/dates';
import { setCheckIn, type CheckInContext } from '../actions';
import { habitColor } from '../colors';
import { scheduleLabel, type Habit } from '../model';
import { dayLabel, streakText } from '../labels';
import { addDays, cellState, progressOf } from '../progress';

export function CheckButton({ habit, day, today, ctx, size = 'large' }: { habit: Habit; day: string; today: string; ctx: CheckInContext; size?: 'large' | 'small' }) {
  const done = habit.done.has(day);
  const future = day > today;
  return (
    <button
      type="button"
      className={`hb-check is-${size}${done ? ' is-done' : ''}`}
      style={{ '--hb-color': habitColor(habit) } as CSSProperties}
      aria-pressed={done}
      aria-label={`${habit.name}, ${dayLabel(day, today)}`}
      title={done ? `Done ${dayLabel(day, today)}: tap to undo` : `Mark done ${dayLabel(day, today)}`}
      disabled={future}
      onClick={() => void setCheckIn(habit, day, !done, ctx)}
    >
      <Check size={size === 'large' ? 26 : 18} strokeWidth={3} aria-hidden />
    </button>
  );
}

/** The last seven days up to `today`, as dots. */
export function WeekDots({ habit, today }: { habit: Habit; today: string }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  return (
    <span className="hb-week" aria-hidden style={{ '--hb-color': habitColor(habit) } as CSSProperties}>
      {days.map((d) => (
        <span key={d} className={`hb-dot is-${cellState(habit, d, today)}`} />
      ))}
    </span>
  );
}

export function HabitRow({ habit, day, today, ctx, onOpen }: { habit: Habit; day: string; today: string; ctx: CheckInContext; onOpen(): void }) {
  const p = progressOf(habit, today);
  const streak = streakText(p);
  return (
    <li className={`hb-row${habit.done.has(day) ? ' is-done' : ''}`}>
      <CheckButton habit={habit} day={day} today={today} ctx={ctx} />
      <button type="button" className="hb-row-main" onClick={onOpen}>
        <span className="hb-name">{habit.name}</span>
        <span className="hb-meta">
          {habit.schedule.kind === 'weekly' ? `${p.thisWeek} of ${habit.schedule.times} this week` : scheduleLabel(habit.schedule)}
          {streak && (
            <span className="hb-streak">
              <Flame size={13} aria-hidden /> {streak}
            </span>
          )}
        </span>
      </button>
      <WeekDots habit={habit} today={today} />
    </li>
  );
}

/** The last seven days, to check in late; each shows how many habits were done. */
export function DayPicker({ day, today, habits, onPick }: { day: string; today: string; habits: Habit[]; onPick(day: string): void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  return (
    <div className="hb-days" role="group" aria-label="Day to check in">
      {days.map((d) => {
        const done = habits.filter((h) => h.done.has(d)).length;
        const date = dayjs(d, 'YYYY-MM-DD');
        return (
          <button key={d} type="button" className={`hb-day${d === day ? ' is-selected' : ''}`} aria-pressed={d === day} aria-label={`${dayLabel(d, today)}: ${done} done`} onClick={() => onPick(d)}>
            <span className="hb-day-name">{d === today ? 'Today' : date.format('ddd')}</span>
            <span className="hb-day-date">{date.format('D')}</span>
            <span className="hb-day-count">{habits.length ? `${done}/${habits.length}` : ''}</span>
          </button>
        );
      })}
    </div>
  );
}
