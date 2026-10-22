// `/x/calendar` (ROADMAP item 14, DESIGN §6.32): a month of six weeks with each day's daily note
// and tasks, and the focused day's details beside it (below it on a phone), or a week, day by day.
// The focused day and the view are the address (`?date=2026-10-21&view=week`). A tap focuses a
// day; a tap on the focused day (or Enter) opens its daily note, creating it from the template.
import { ChevronLeft, ChevronRight, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { LocalDate } from '../../api/types';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { addDays, useToday } from '../../tasks/dates';
import { LoadError } from '../../tasks/ui/common';
import { openPath } from '../../features/navigation';
import { openDay } from '../actions';
import { addMonthsToDay, isDay, localeWeekStart, monthOf, monthWeeks, weekOf, weekdayNames, type Weekday } from '../model';
import { DEFAULT_PROPERTIES, parseProperties, useCalendarPrefs, useWeekStart } from '../prefs';
import type { CalendarView } from '../routes';
import { useCalendarData } from '../useCalendarData';
import { DayDetails } from './DayDetails';
import { monthLabel, weekLabel } from './labels';
import { MonthGrid } from './MonthGrid';
import '../calendar.css';

export default function CalendarPage() {
  usePageTitle('Calendar');
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const view: CalendarView = params.get('view') === 'week' ? 'week' : 'month';
  const raw = params.get('date');
  const focused = isDay(raw) ? raw : today;
  const weekStart = useWeekStart();
  const weekNumbers = useCalendarPrefs((s) => s.weekNumbers);

  const go = (day: LocalDate, nextView: CalendarView = view) => {
    const next = new URLSearchParams(params);
    // Without a date the page follows today, also across midnight.
    if (day === today) next.delete('date');
    else next.set('date', day);
    if (nextView === 'week') next.set('view', 'week');
    else next.delete('view');
    setParams(next, { replace: true });
  };

  const week = weekOf(focused, weekStart);
  const days = view === 'month' ? monthWeeks(monthOf(focused), weekStart).flatMap((w) => w.days) : week.days;
  const cal = useCalendarData(days);
  const step = (n: 1 | -1) => go(view === 'month' ? addMonthsToDay(focused, n) : addDays(focused, 7 * n));
  const unit = view === 'month' ? 'month' : 'week';

  return (
    <div className={`page cal-page is-${view}`}>
      <header className="page-header cal-header">
        <div className="cal-heading">
          <h1 className="page-title">{view === 'month' ? monthLabel(monthOf(focused)) : weekLabel(week)}</h1>
          {view === 'week' && weekNumbers && <p className="cal-subtitle muted">Week {week.number}</p>}
        </div>
        <div className="cal-toolbar">
          <div className="cal-switch" role="group" aria-label="Calendar view">
            <button type="button" className="cal-switch-button" aria-pressed={view === 'month'} onClick={() => go(focused, 'month')}>
              Month
            </button>
            <button type="button" className="cal-switch-button" aria-pressed={view === 'week'} onClick={() => go(focused, 'week')}>
              Week
            </button>
          </div>
          <div className="cal-nav">
            <button type="button" className="icon-button cal-nav-button" aria-label={`Previous ${unit}`} title={`Previous ${unit}`} onClick={() => step(-1)}>
              <ChevronLeft size={18} />
            </button>
            <button type="button" className="button cal-today" onClick={() => go(today)}>
              Today
            </button>
            <button type="button" className="icon-button cal-nav-button" aria-label={`Next ${unit}`} title={`Next ${unit}`} onClick={() => step(1)}>
              <ChevronRight size={18} />
            </button>
          </div>
          <CalendarOptions />
        </div>
      </header>
      {cal.tasksError !== null && <LoadError error={cal.tasksError} retry={cal.retryTasks} />}
      {view === 'month' ? (
        <div className="cal-layout">
          <MonthGrid
            focused={focused}
            today={today}
            weekStart={weekStart}
            weekNumbers={weekNumbers}
            notes={cal.notes}
            tasks={cal.tasks}
            dated={cal.dated}
            repeats={cal.repeats}
            onFocusDay={(day) => go(day)}
            onOpenDay={openDay}
          />
          <DayDetails
            day={focused}
            today={today}
            note={cal.notes.get(focused)}
            dated={cal.dated.get(focused)}
            repeats={cal.repeats.get(focused)}
            tasks={cal.tasks.get(focused)}
            taskData={cal.taskData}
            tasksLoading={cal.tasksLoading}
            onOpenNote={openDay}
            onOpenPath={(path) => openPath(path)}
          />
        </div>
      ) : (
        <div className="cal-week">
          {week.days.map((day) => (
            <DayDetails
              key={day}
              day={day}
              today={today}
              note={cal.notes.get(day)}
              dated={cal.dated.get(day)}
              repeats={cal.repeats.get(day)}
              tasks={cal.tasks.get(day)}
              taskData={cal.taskData}
              tasksLoading={cal.tasksLoading}
              onOpenNote={openDay}
              onOpenPath={(path) => openPath(path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The first day of the week and the week numbers, kept on this device. */
function CalendarOptions() {
  const weekStart = useCalendarPrefs((s) => s.weekStart);
  const weekNumbers = useCalendarPrefs((s) => s.weekNumbers);
  const update = useCalendarPrefs((s) => s.update);
  const names = weekdayNames(0, 'long');
  const localeDefault = localeWeekStart();
  return (
    <details className="cal-options">
      <summary className="icon-button cal-nav-button" aria-label="Calendar options" title="Calendar options">
        <Settings2 size={16} aria-hidden />
      </summary>
      <div className="cal-options-body">
        <label className="cal-option">
          <span>First day of the week</span>
          <select
            value={weekStart === 'locale' ? 'locale' : String(weekStart)}
            onChange={(e) => update({ weekStart: e.target.value === 'locale' ? 'locale' : (Number(e.target.value) as Weekday) })}
          >
            <option value="locale">Language default ({names[localeDefault]})</option>
            {names.map((name, i) => (
              <option key={i} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="cal-option is-check">
          <input type="checkbox" checked={weekNumbers} onChange={(e) => update({ weekNumbers: e.target.checked })} />
          <span>Show week numbers</span>
        </label>
        <PropertiesOption />
      </div>
    </details>
  );
}

/** The frontmatter properties that date a note, comma-separated; applied when the field is left. */
function PropertiesOption() {
  const properties = useCalendarPrefs((s) => s.properties);
  const update = useCalendarPrefs((s) => s.update);
  const saved = properties.join(', ');
  const [text, setText] = useState(saved);
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setText(saved);
  }
  const apply = () => {
    const next = parseProperties(text);
    update({ properties: next.length > 0 ? next : DEFAULT_PROPERTIES });
    setText((next.length > 0 ? next : DEFAULT_PROPERTIES).join(', '));
  };
  return (
    <div className="cal-option">
      <label htmlFor="cal-properties">Note date properties</label>
      <input
        id="cal-properties"
        type="text"
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        placeholder="date"
        aria-describedby="cal-properties-help"
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply();
        }}
      />
      <small id="cal-properties-help" className="muted">
        Notes with one of these frontmatter dates show on that day.
      </small>
    </div>
  );
}
