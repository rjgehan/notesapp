// Opening what a reminder points at (DESIGN §6.38): `?task=<id>` opens the task's detail sheet over
// the page, `/?open=daily` today's daily note (HomePage). The service worker opens these URLs in a
// new window, or posts them to an open tab (OPEN_MESSAGE).
import { openTodaysDailyNote } from '../daily';
import { navigateTo } from '../navigation';
import { openTaskDetail } from '../../tasks/ui/state';
import { OPEN_MESSAGE, safeAppPath } from '../../sw/push';

/** Opens a reminder's app path in this tab. */
export function openReminderUrl(url: string): void {
  const target = new URL(safeAppPath(url), 'https://app.invalid');
  const task = target.searchParams.get('task');
  if (target.searchParams.get('open') === 'daily') {
    void openTodaysDailyNote();
    return;
  }
  target.searchParams.delete('task');
  navigateTo(target.pathname + target.search);
  if (task) openTaskDetail(task);
}

/**
 * At startup: a `?task=<id>` in the address (a notification opened the app) opens that task and is
 * removed from the address, so a reload does not open it again. Returns the task id, or null.
 */
export function consumeLaunchTask(location: Location = window.location, history: History = window.history): string | null {
  const params = new URLSearchParams(location.search);
  const task = params.get('task');
  if (!task) return null;
  params.delete('task');
  const search = params.toString();
  history.replaceState(history.state, '', location.pathname + (search ? `?${search}` : '') + location.hash);
  openTaskDetail(task);
  return task;
}

/** Tabs that are already open receive the reminder to open from the service worker. */
export function listenForWorkerMessages(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data && data.type === OPEN_MESSAGE && typeof data.url === 'string') openReminderUrl(data.url);
  });
}
