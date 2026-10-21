// The Habits panel (DESIGN §6.35): check-ins from a daily note. For the daily note in view it
// lists the habits of that day, otherwise today's; one tap checks a habit in.
import { useEffect, useState } from 'react';
import { useVaultSettings } from '../../api/hooks';
import { dailyNoteDate } from '../../features/daily';
import { navigateTo } from '../../features/navigation';
import { useUi } from '../../state/ui';
import type { CheckInContext } from '../actions';
import { dayLabel } from '../labels';
import { scheduleLabel } from '../model';
import { todayString } from '../progress';
import { habitsUrl } from '../routes';
import { useHabits } from '../useHabits';
import { CheckButton } from './parts';
import '../habits.css';

export default function HabitsPanel({ activePath }: { activePath: string | null }) {
  const settings = useVaultSettings();
  const data = useHabits();
  const [today, setToday] = useState(() => todayString());
  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayString()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const noteDay = activePath ? dailyNoteDate(activePath, settings.dailyNotes)?.format('YYYY-MM-DD') : undefined;
  const day = noteDay && noteDay <= today ? noteDay : today;
  const ctx: CheckInContext = { byDay: data.byDay, dailyPaths: data.dailyPaths };
  const habits = data.habits.filter((h) => !h.archived);
  const open = (url: string) => {
    useUi.getState().setSheetOpen(false);
    navigateTo(url);
  };

  if (data.loading) return <div className="panel-empty muted">Loading habits…</div>;
  if (data.error) return <div className="panel-empty muted">Could not load the habits.</div>;
  return (
    <div className="hb-panel">
      <p className="hb-panel-day">
        {noteDay ? 'This daily note' : 'Today'}: {dayLabel(day, today)}
      </p>
      {habits.length === 0 ? (
        <p className="muted">
          No habits yet.{' '}
          <button type="button" className="link-button" onClick={() => open(habitsUrl({ view: 'new' }))}>
            Create one
          </button>
        </p>
      ) : (
        <ul className="hb-panel-list">
          {habits.map((h) => (
            <li key={h.path} className="hb-panel-row">
              <CheckButton habit={h} day={day} today={today} ctx={ctx} size="small" />
              <button type="button" className="hb-panel-name" onClick={() => open(habitsUrl({ habit: h.path }))}>
                <span>{h.name}</span>
                <span className="muted">{scheduleLabel(h.schedule)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="link-button hb-panel-more" onClick={() => open(habitsUrl(noteDay && noteDay !== today ? { day } : {}))}>
        Open habits
      </button>
    </div>
  );
}
