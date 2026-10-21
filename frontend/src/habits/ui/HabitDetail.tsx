// One habit (DESIGN §6.35): today's check-in, its streaks and rate, and a year of check-ins. A day
// picked on the calendar can be marked done or undone, for check-ins made late.
import { FileText, Pencil } from 'lucide-react';
import type { CSSProperties } from 'react';
import { openPath } from '../../features/navigation';
import { setCheckIn, type CheckInContext } from '../actions';
import { habitColor } from '../colors';
import { dayLabel } from '../labels';
import { dailyValue, isCheckedValue, scheduleLabel, type Habit } from '../model';
import { cellState, progressOf, type CellState } from '../progress';
import { CheckButton } from './parts';
import { Heatmap } from './Heatmap';

const STATE_TEXT: Record<CellState, string> = {
  done: 'done',
  missed: 'missed',
  open: 'not done',
  off: 'not scheduled',
  future: 'ahead',
  before: 'before the habit started',
};

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="hb-tile">
      <div className="hb-tile-value">{value}</div>
      <div className="hb-tile-label">{label}</div>
    </div>
  );
}

export function HabitDetail({ habit, today, ctx, weeks, onEdit }: { habit: Habit; today: string; ctx: CheckInContext; weeks: number; onEdit(): void }) {
  const p = progressOf(habit, today);
  const color = habitColor(habit);
  const unit = (n: number) => `${n} ${p.unit}${n === 1 ? '' : 's'}`;
  const doneToday = habit.done.has(today);
  return (
    <div className="hb-detail" style={{ '--hb-color': color } as CSSProperties}>
      <div className="hb-detail-today">
        <CheckButton habit={habit} day={today} today={today} ctx={ctx} />
        <div>
          <div className="hb-detail-status">{doneToday ? 'Done today' : p.dueToday ? 'Not done yet today' : 'Not scheduled today'}</div>
          <div className="muted">
            {scheduleLabel(habit.schedule)}
            {habit.archived ? ' · archived' : ''}
          </div>
        </div>
        <div className="hb-detail-actions">
          <button type="button" className="icon-button" aria-label="Edit habit" title="Edit habit" onClick={onEdit}>
            <Pencil size={18} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Open the habit note" title="Open the habit note" onClick={() => openPath(habit.path)}>
            <FileText size={18} aria-hidden />
          </button>
        </div>
      </div>
      <div className="hb-tiles">
        <Tile value={unit(p.current)} label="Current streak" />
        <Tile value={unit(p.longest)} label="Longest streak" />
        <Tile value={p.rate === null ? '–' : `${Math.round(p.rate * 100)}%`} label={p.unit === 'week' ? 'Last 4 weeks' : 'Last 30 days'} />
        <Tile value={String(p.total)} label="Times done" />
      </div>
      <section className="hb-section">
        <h2 className="hb-section-title">Calendar</h2>
        <Heatmap
          today={today}
          weeks={weeks}
          color={color}
          cell={(day) => {
            const state = cellState(habit, day, today);
            const fromDaily = habit.fromDaily.has(day) && !habit.entries.has(day);
            return { day, tone: state, label: `${dayLabel(day, today)}: ${STATE_TEXT[state]}${fromDaily ? ' (daily note)' : ''}` };
          }}
          readout={(day) => {
            if (!day) return <span className="muted">Pick a day to change it.</span>;
            const state = cellState(habit, day, today);
            if (state === 'future') return <span>{dayLabel(day, today)}: ahead</span>;
            const done = habit.done.has(day);
            const viaDaily = isCheckedValue(dailyValue(habit, ctx.byDay, day));
            return (
              <span className="hb-readout">
                <span>
                  <strong>{dayLabel(day, today)}</strong>: {STATE_TEXT[state]}
                  {viaDaily ? ' (from the daily note)' : ''}
                </span>
                <button type="button" className="button button-small" onClick={() => void setCheckIn(habit, day, !done, ctx)}>
                  {done ? 'Mark not done' : 'Mark done'}
                </button>
              </span>
            );
          }}
          legend={
            <>
              <span className="hb-legend-item">
                <span className="hb-cell is-done" /> Done
              </span>
              <span className="hb-legend-item">
                <span className="hb-cell is-missed" /> Missed
              </span>
              <span className="hb-legend-item">
                <span className="hb-cell is-off" /> Not scheduled
              </span>
            </>
          }
        />
      </section>
      <p className="hb-hint">
        Check-ins are kept in the note’s <code>entries</code>. A daily note with <code>{habit.property}: true</code> in its properties counts too.
      </p>
    </div>
  );
}
