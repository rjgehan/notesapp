// Locations of the calendar page (`/x/calendar`, DESIGN §6.32): the focused day and the view are
// the address, so a day can be bookmarked or linked, and reloading keeps the place.
import type { LocalDate } from '../api/types';

export const CALENDAR_ROUTE = '/x/calendar';

export type CalendarView = 'month' | 'week';

export function calendarUrl(opts: { date?: LocalDate; view?: CalendarView } = {}): string {
  const params = new URLSearchParams();
  if (opts.date) params.set('date', opts.date);
  if (opts.view === 'week') params.set('view', 'week');
  const q = params.toString();
  return CALENDAR_ROUTE + (q ? '?' + q : '');
}
