// The Calendar panel of the right sidebar (DESIGN §6.32), like Obsidian's Calendar plugin: a
// compact month with a dot for each daily note and one per open task; a click on a day opens its
// daily note (creating it from the template). It follows the daily note in view, and shows the
// focused day's tasks below the month. On a phone it is a tab of the bottom sheet, which closes
// when a note opens.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useVaultSettings } from '../../api/hooks';
import type { LocalDate } from '../../api/types';
import { dailyNoteDate } from '../../features/daily';
import { navigateTo, openPath } from '../../features/navigation';
import { useUi } from '../../state/ui';
import { useToday } from '../../tasks/dates';
import { openDay } from '../actions';
import { addMonthsToDay, monthOf, monthWeeks } from '../model';
import { useCalendarPrefs, useWeekStart } from '../prefs';
import { calendarUrl } from '../routes';
import { useCalendarData } from '../useCalendarData';
import { DayDetails } from './DayDetails';
import { monthLabel } from './labels';
import { MonthGrid } from './MonthGrid';
import '../calendar.css';

function closeSheet(): void {
  useUi.getState().setSheetOpen(false);
}

export default function CalendarPanel({ activePath }: { activePath: string | null }) {
  const today = useToday();
  const daily = useVaultSettings().dailyNotes;
  const weekStart = useWeekStart();
  const weekNumbers = useCalendarPrefs((s) => s.weekNumbers);
  const noteDay = activePath ? (dailyNoteDate(activePath, daily)?.format('YYYY-MM-DD') ?? null) : null;
  const [focused, setFocused] = useState<LocalDate>(noteDay ?? today);
  // The daily note in view brings its month (and day) into view.
  const [followed, setFollowed] = useState(noteDay);
  if (followed !== noteDay) {
    setFollowed(noteDay);
    if (noteDay) setFocused(noteDay);
  }
  const month = monthOf(focused);
  const days = monthWeeks(month, weekStart).flatMap((w) => w.days);
  const cal = useCalendarData(days);
  const open = (day: LocalDate) => {
    closeSheet();
    openDay(day);
  };

  return (
    <div className="cal-panel">
      <div className="cal-panel-header">
        <button
          type="button"
          className="cal-panel-month"
          title="Open the calendar page"
          onClick={() => {
            closeSheet();
            useUi.getState().setDrawerOpen(false);
            navigateTo(calendarUrl({ date: focused === today ? undefined : focused }));
          }}
        >
          {monthLabel(month)}
        </button>
        <div className="cal-nav">
          <button type="button" className="icon-button cal-nav-button" aria-label="Previous month" title="Previous month" onClick={() => setFocused(addMonthsToDay(focused, -1))}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="button button-small cal-today" onClick={() => setFocused(today)}>
            Today
          </button>
          <button type="button" className="icon-button cal-nav-button" aria-label="Next month" title="Next month" onClick={() => setFocused(addMonthsToDay(focused, 1))}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <MonthGrid
        compact
        clickOpens
        focused={focused}
        today={today}
        current={noteDay}
        weekStart={weekStart}
        weekNumbers={weekNumbers}
        notes={cal.notes}
        tasks={cal.tasks}
        dated={cal.dated}
        repeats={cal.repeats}
        onFocusDay={setFocused}
        onOpenDay={open}
      />
      <DayDetails
        headingLevel={3}
        day={focused}
        today={today}
        note={cal.notes.get(focused)}
        dated={cal.dated.get(focused)}
        repeats={cal.repeats.get(focused)}
        tasks={cal.tasks.get(focused)}
        taskData={cal.taskData}
        tasksLoading={cal.tasksLoading}
        onOpenNote={open}
        onOpenPath={(path) => {
          closeSheet();
          openPath(path);
        }}
      />
    </div>
  );
}
