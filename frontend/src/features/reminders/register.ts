// Reminders (ROADMAP items 9 and 4c, DESIGN §6.38): the in-app route's `reminder.due` events, the
// device's time zone (reminders are local times; the server reads them in the zone the devices
// report, the latest report winning), and notifications that open a task.
import { registerEventHandler } from '../../extensions';
import type { ReminderDueEvent } from '../../api/types';
import { remindersApi } from './client';
import { showReminder } from './inApp';
import { consumeLaunchTask, listenForWorkerMessages } from './open';

let registered = false;

export function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Tells the server this device's zone; quiet on failure (it is sent again on the next start). */
export function reportZone(): void {
  const zone = deviceZone();
  if (zone) void remindersApi.reportZone(zone).catch(() => undefined);
}

export function registerReminders(): void {
  if (registered) return;
  registered = true;
  registerEventHandler('reminder.due', (data) => {
    showReminder(data as ReminderDueEvent);
  });
}

/** At startup (main.tsx): open a task a notification launched, listen to the worker, report the zone. */
export function startReminders(): void {
  listenForWorkerMessages();
  consumeLaunchTask();
  reportZone();
}
