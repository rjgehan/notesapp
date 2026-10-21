// Words for days and streaks (DESIGN §6.35).
import { dayjs } from '../features/dates';
import { addDays, type Progress } from './progress';

/** "today", "yesterday", or "Tue, Oct 14". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  if (day === addDays(today, -1)) return 'yesterday';
  return dayjs(day, 'YYYY-MM-DD').format('ddd, MMM D');
}

export function streakText(p: Progress): string {
  if (p.current === 0) return '';
  return `${p.current} ${p.unit}${p.current === 1 ? '' : 's'}`;
}
