// The month grid shared by the calendar page and the sidebar panel (DESIGN §6.32): six weeks from
// the locale's (or the chosen) first day of the week, with optional week numbers. Each day shows
// a dot for its daily note, a square for each note a property dates, and its open tasks and coming
// repeats (as dots, or as titles when the grid is wide enough, a container query). One day is focused: it alone is in the tab order (a roving tabindex), and
// the WAI-ARIA date-grid keys move it. A horizontal swipe turns the month on touch screens.
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { DatedNote, FileEntry, LocalDate, Task } from '../../api/types';
import { lastSegment } from '../../features/paths';
import { isClosed } from '../../tasks/model';
import { titleSegments } from '../../tasks/ui/display';
import { monthOf, monthWeeks, moveDay, openCount, weekdayNames, type Weekday } from '../model';
import { dayLabel, monthLabel } from './labels';
import { useSwipe } from './useSwipe';

const MAX_TITLES = 3;

/** A task title as text: links read as their display text. */
function plainTitle(title: string): string {
  return titleSegments(title)
    .map((s) => s.text)
    .join('');
}
const MAX_DOTS = 3;

export interface MonthGridProps {
  focused: LocalDate;
  today: LocalDate;
  weekStart: Weekday;
  weekNumbers: boolean;
  notes: ReadonlyMap<LocalDate, FileEntry>;
  tasks: ReadonlyMap<LocalDate, Task[]>;
  /** Notes dated by a property (API.md §25). */
  dated?: ReadonlyMap<LocalDate, DatedNote[]>;
  /** Coming occurrences of repeating tasks. */
  repeats?: ReadonlyMap<LocalDate, Task[]>;
  /** Moves the focus (a click, a key, a swipe); the grid shows the focused day's month. */
  onFocusDay(day: LocalDate): void;
  /** Enter on a day, a double click, a click on the focused day, or any click with `clickOpens`. */
  onOpenDay(day: LocalDate): void;
  /** The panel: a click opens the day's daily note at once, as Obsidian's Calendar does. */
  clickOpens?: boolean;
  compact?: boolean;
  /** The day of the note in view (the panel), outlined. */
  current?: LocalDate | null;
}

export function MonthGrid({ focused, today, weekStart, weekNumbers, notes, tasks, dated, repeats, onFocusDay, onOpenDay, clickOpens, compact, current }: MonthGridProps) {
  const month = monthOf(focused);
  const weeks = monthWeeks(month, weekStart);
  const names = weekdayNames(weekStart, compact ? 'narrow' : 'short');
  const longNames = weekdayNames(weekStart, 'long');
  const grid = useRef<HTMLTableElement>(null);
  // After a key moves the focus, the new day's button takes it (it may be in a new month's grid).
  const moved = useRef(false);
  // Which way the month turned, for the slide-in (derived from the previous render's month).
  const [turn, setTurn] = useState({ month, direction: 0 });
  if (turn.month !== month) setTurn({ month, direction: month > turn.month ? 1 : -1 });
  const direction = turn.direction;
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`button[data-day="${focused}"]`)?.focus();
  }, [focused]);

  const swipe = useSwipe((dir) => {
    const target = moveDay(focused, dir > 0 ? 'PageDown' : 'PageUp', weekStart);
    if (target) onFocusDay(target);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const day = (e.target as HTMLElement).closest<HTMLElement>('[data-day]')?.dataset.day;
    if (!day || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpenDay(day);
      return;
    }
    const next = moveDay(day, e.key, weekStart, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    moved.current = true;
    onFocusDay(next);
  };

  return (
    <div className={`cal-grid-wrap${compact ? ' is-compact' : ''}`} {...swipe}>
      <table
        ref={grid}
        role="grid"
        className={`cal-grid${weekNumbers ? ' has-week-numbers' : ''}${direction ? (direction > 0 ? ' slide-next' : ' slide-prev') : ''}`}
        key={month}
        aria-label={monthLabel(month)}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {weekNumbers && (
              <th scope="col" className="cal-weeknum-head">
                <abbr title="Week number">{compact ? 'W' : 'Wk'}</abbr>
              </th>
            )}
            {names.map((name, i) => (
              <th key={i} scope="col" className="cal-weekday">
                <abbr title={longNames[i]}>{name}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.start}>
              {weekNumbers && (
                <th scope="row" className="cal-weeknum" aria-label={`Week ${week.number}`}>
                  {week.number}
                </th>
              )}
              {week.days.map((day) => {
                const note = notes.get(day);
                const dayTasks = tasks.get(day);
                const dayDated = dated?.get(day) ?? [];
                const dayRepeats = repeats?.get(day) ?? [];
                const open = openCount(dayTasks);
                const done = (dayTasks?.length ?? 0) - open;
                const overdue = open > 0 && day < today;
                const cls = [
                  'cal-day',
                  monthOf(day) !== month && 'is-outside',
                  day === today && 'is-today',
                  day === focused && 'is-focused',
                  current === day && 'is-current',
                  note && 'has-note',
                  dayDated.length > 0 && 'has-dated',
                  overdue && 'is-overdue',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <td key={day} role="gridcell" aria-selected={day === focused} aria-current={day === today ? 'date' : undefined}>
                    <button
                      type="button"
                      className={cls}
                      data-day={day}
                      tabIndex={day === focused ? 0 : -1}
                      aria-label={dayLabel(day, today, { hasNote: Boolean(note), dated: dayDated.length, open, done, repeats: dayRepeats.length })}
                      onClick={() => {
                        if (clickOpens || day === focused) onOpenDay(day);
                        if (day !== focused) onFocusDay(day);
                      }}
                    >
                      <span className="cal-day-number" aria-hidden>
                        {Number(day.slice(8))}
                      </span>
                      <span className="cal-day-marks" aria-hidden>
                        {note && <span className="cal-note-dot" />}
                        {dayDated.slice(0, MAX_DOTS).map((n) => (
                          <span key={n.path} className="cal-dated-dot" />
                        ))}
                        {Array.from({ length: Math.min(open, MAX_DOTS) }, (_, i) => (
                          <span key={i} className="cal-task-dot" />
                        ))}
                        {open === 0 && dayRepeats.length > 0 && <span className="cal-task-dot is-repeat" />}
                      </span>
                      {!compact && <DayTitles dated={dayDated} tasks={dayTasks ?? []} repeats={dayRepeats} />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The titles in a wide grid's day: its dated notes, its tasks, then its coming repeats. */
function DayTitles({ dated, tasks, repeats }: { dated: readonly DatedNote[]; tasks: readonly Task[]; repeats: readonly Task[] }) {
  const items = [
    ...dated.map((n) => ({ key: 'n:' + n.path, cls: 'is-note', text: lastSegment(n.path).replace(/\.md$/i, '') })),
    ...tasks.map((t) => ({ key: 't:' + t.id, cls: isClosed(t) ? 'is-closed' : '', text: plainTitle(t.title) })),
    ...repeats.map((t) => ({ key: 'r:' + t.id, cls: 'is-repeat', text: plainTitle(t.title) })),
  ];
  if (items.length === 0) return null;
  return (
    <span className="cal-day-titles" aria-hidden>
      {items.slice(0, MAX_TITLES).map((item) => (
        <span key={item.key} className={`cal-day-title ${item.cls}`.trim()}>
          {item.text}
        </span>
      ))}
      {items.length > MAX_TITLES && <span className="cal-day-more">+{items.length - MAX_TITLES} more</span>}
    </span>
  );
}
