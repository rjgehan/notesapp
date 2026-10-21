// The recurrence helpers are a lazy chunk (rrule comes with them); the main chunk loads them on
// demand, for the roll-forward a completion shows before the server answers.
import type * as Recurrence from './recurrence';

export type RecurrenceModule = typeof Recurrence;

let load: Promise<RecurrenceModule> | null = null;

export function loadRecurrence(): Promise<RecurrenceModule> {
  load ??= import('./recurrence');
  return load;
}
