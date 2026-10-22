// Opening a day of the calendar: its daily note, created from the template when missing, by the
// procedure of API.md §15.2 (DESIGN §6.32).
import type { LocalDate } from '../api/types';
import { openDailyNote } from '../features/daily';
import { dayjs } from '../features/dates';

export function openDay(day: LocalDate): void {
  void openDailyNote(dayjs(day, 'YYYY-MM-DD'));
}
