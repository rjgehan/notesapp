// `/x/habits` (ROADMAP item 35, DESIGN §6.35): today's habits with one-tap check-ins, the last
// week to check in late, every habit on one calendar, one habit (`?habit=`), and the habit form
// (`?view=new`, `?view=edit&habit=`). Phone first: 48 px check buttons, rows of 64 px.
import { ChevronLeft, Plus, RefreshCw, Target } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { errorMessage } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { navigateTo } from '../../features/navigation';
import { habitKeys } from '../api';
import type { CheckInContext } from '../actions';
import { dayLabel } from '../labels';
import { isScheduled, overviewLevel, progressOf, todayString } from '../progress';
import { HABITS_ROUTE, habitsUrl } from '../routes';
import { useHabits } from '../useHabits';
import { HabitDetail } from './HabitDetail';
import { HabitForm } from './HabitForm';
import { Heatmap } from './Heatmap';
import { DayPicker, HabitRow } from './parts';
import '../habits.css';

/** Today's date, kept current past midnight. */
function useToday(): string {
  const [today, setToday] = useState(() => todayString());
  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayString()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}

const LEVEL_TEXT = ['none done', 'some done', 'about half done', 'most done', 'all done'];

function Empty({ folder }: { folder: string }) {
  return (
    <div className="hb-empty">
      <Target size={32} aria-hidden className="hb-empty-icon" />
      <p className="hb-empty-title">No habits yet</p>
      <p className="muted">
        A habit is a note in <code>{folder}/</code> (or any note tagged <code>#habit</code>). Its check-ins are kept in its properties, as Obsidian’s Habit Tracker 21 plugin keeps them, and a daily note can check it in with a property such as <code>exercise: true</code>.
      </p>
      <button type="button" className="button button-primary hb-new" onClick={() => navigateTo(habitsUrl({ view: 'new' }))}>
        <Plus size={16} aria-hidden /> New habit
      </button>
    </div>
  );
}

export default function HabitsPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const habitPath = params.get('habit');
  const today = useToday();
  const dayParam = params.get('day');
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) && dayParam <= today ? dayParam : today;
  const data = useHabits();
  const habit = habitPath ? (data.habits.find((h) => h.path === habitPath) ?? null) : null;
  usePageTitle(habit && view !== 'edit' ? habit.name : 'Habits');
  const ctx: CheckInContext = { byDay: data.byDay, dailyPaths: data.dailyPaths };
  const [showArchived, setShowArchived] = useState(false);

  const active = useMemo(() => data.habits.filter((h) => !h.archived), [data.habits]);
  const archived = data.habits.length - active.length;
  const ordered = useMemo(() => {
    // Due on the chosen day first (done ones too), then the others.
    const due = (h: (typeof active)[number]) => h.done.has(day) || (h.schedule.kind === 'weekly' ? progressOf(h, day).dueToday : isScheduled(h.schedule, day));
    return [...active.filter(due), ...active.filter((h) => !due(h))];
  }, [active, day]);

  if (data.loading) return <div className="view-loading" aria-busy="true" />;
  if (data.error || !data.data) {
    return (
      <div className="page">
        <h1 className="page-title">Habits</h1>
        <p role="alert">Could not load the habits: {errorMessage(data.error)}</p>
        <button type="button" className="button" onClick={() => void queryClient.invalidateQueries({ queryKey: habitKeys.all })}>
          <RefreshCw size={16} aria-hidden /> Try again
        </button>
      </div>
    );
  }
  const folder = data.data.folder;
  const back = (
    <button type="button" className="icon-button hb-back" aria-label="All habits" title="All habits" onClick={() => navigateTo(HABITS_ROUTE)}>
      <ChevronLeft size={20} aria-hidden />
    </button>
  );

  if (view === 'new' || (view === 'edit' && habit)) {
    return (
      <div className="page hb-page">
        <header className="page-header hb-header">
          {back}
          <h1 className="page-title">{habit ? `Edit ${habit.name}` : 'New habit'}</h1>
        </header>
        <HabitForm key={habit?.path ?? 'new'} habit={view === 'edit' ? habit : null} folder={folder} today={today} onDone={(path) => navigateTo(path ? habitsUrl({ habit: path }) : habit ? habitsUrl({ habit: habit.path }) : HABITS_ROUTE)} />
      </div>
    );
  }

  if (habitPath) {
    return (
      <div className="page hb-page">
        <header className="page-header hb-header">
          {back}
          <h1 className="page-title">{habit?.name ?? 'Habit'}</h1>
        </header>
        {habit ? <HabitDetail habit={habit} today={today} ctx={ctx} weeks={53} onEdit={() => navigateTo(habitsUrl({ view: 'edit', habit: habit.path }))} /> : <p className="muted">This habit is gone. It may have been moved out of {folder}/ or deleted.</p>}
      </div>
    );
  }

  const doneCount = active.filter((h) => h.done.has(day)).length;
  return (
    <div className="page hb-page">
      <header className="page-header">
        <h1 className="page-title">Habits</h1>
        <button type="button" className="button button-primary hb-new" onClick={() => navigateTo(habitsUrl({ view: 'new' }))}>
          <Plus size={16} aria-hidden /> New habit
        </button>
      </header>
      {active.length === 0 && archived === 0 ? (
        <Empty folder={folder} />
      ) : (
        <>
          <DayPicker day={day} today={today} habits={active} onPick={(d) => navigateTo(habitsUrl({ day: d === today ? undefined : d }), { replace: true })} />
          <p className="hb-summary" aria-live="polite">
            {day === today ? 'Today' : dayLabel(day, today).replace(/^./, (c) => c.toUpperCase())}: {doneCount} of {active.length} done
          </p>
          <ul className="hb-list">
            {ordered.map((h) => (
              <HabitRow key={h.path} habit={h} day={day} today={today} ctx={ctx} onOpen={() => navigateTo(habitsUrl({ habit: h.path }))} />
            ))}
          </ul>
          {archived > 0 && (
            <div className="hb-archived">
              <button type="button" className="link-button" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
                {showArchived ? 'Hide' : 'Show'} {archived} archived
              </button>
              {showArchived && (
                <ul className="hb-list">
                  {data.habits
                    .filter((h) => h.archived)
                    .map((h) => (
                      <HabitRow key={h.path} habit={h} day={day} today={today} ctx={ctx} onOpen={() => navigateTo(habitsUrl({ habit: h.path }))} />
                    ))}
                </ul>
              )}
            </div>
          )}
          {active.length > 0 && (
            <section className="hb-section">
              <h2 className="hb-section-title">All habits</h2>
              <Heatmap
                today={today}
                weeks={53}
                cell={(d) => {
                  const level = overviewLevel(active, d, today);
                  return level === null ? null : { day: d, tone: `level-${level}`, label: `${dayLabel(d, today)}: ${LEVEL_TEXT[level]}` };
                }}
                readout={(d) => {
                  if (!d) return <span className="muted">Each day: the share of the habits due that were done.</span>;
                  const done = active.filter((h) => h.done.has(d)).map((h) => h.name);
                  return (
                    <span>
                      <strong>{dayLabel(d, today)}</strong>: {done.length ? done.join(', ') : 'nothing done'}
                    </span>
                  );
                }}
                legend={
                  <>
                    <span>Less</span>
                    {[0, 1, 2, 3, 4].map((l) => (
                      <span key={l} className={`hb-cell is-level-${l}`} aria-hidden />
                    ))}
                    <span>More</span>
                  </>
                }
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
