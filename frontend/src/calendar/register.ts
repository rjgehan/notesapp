// The calendar (ROADMAP item 14, DESIGN §6.32) through the extension points of DESIGN §6.8: the
// `/x/calendar` page (month and week), the Calendar panel of the right sidebar, a command, and
// event handlers that refetch the dated notes (API.md §25) when a note changes. Daily notes come
// from the tree and tasks from the task store, which SSE keeps current already.
import { Calendar, CalendarRange } from 'lucide-react';
import { queryClient } from '../api/queryClient';
import { registerCommand, registerEventHandler, registerPage, registerPanel } from '../extensions';
import { navigateTo } from '../features/navigation';
import { useUi } from '../state/ui';
import { calendarKeys } from './api';
import { calendarUrl } from './routes';

/** Any note may gain, change or lose a date. */
const NOTE_EVENTS = ['file.created', 'file.changed', 'file.deleted', 'entry.moved', 'folder.deleted'];
export const REFRESH_DEBOUNCE_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleDatedRefresh(data: unknown): void {
  const d = data as { path?: string; file?: { path: string }; from?: string; to?: string } | null;
  const paths = [d?.path, d?.file?.path, d?.from, d?.to].filter((p): p is string => typeof p === 'string');
  // Only notes (and folders, which may hold notes) carry frontmatter.
  if (paths.length && paths.every((p) => /\.[^/]+$/.test(p) && !p.toLowerCase().endsWith('.md'))) return;
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
  }, REFRESH_DEBOUNCE_MS);
}

let registered = false;

export function registerCalendar(): void {
  if (registered) return;
  registered = true;
  registerPage({ route: 'calendar', title: 'Calendar', icon: Calendar, load: () => import('./ui/CalendarPage') });
  registerPanel({ id: 'calendar', side: 'right', title: 'Calendar', icon: Calendar, load: () => import('./ui/CalendarPanel') });
  registerCommand({
    id: 'calendar.week',
    name: 'Open Calendar: this week',
    icon: CalendarRange,
    run: () => {
      useUi.getState().setDrawerOpen(false);
      navigateTo(calendarUrl({ view: 'week' }));
    },
  });
  for (const name of NOTE_EVENTS) registerEventHandler(name, scheduleDatedRefresh);
}
