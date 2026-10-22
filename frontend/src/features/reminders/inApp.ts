// The in-app reminder route (DESIGN §6.32): a `reminder.due` event becomes a toast with an Open
// action and, when this browser allows notifications, a system notification. Several tabs show
// one system notification (the tag is the reminder's key); each tab shows a reminder once.
import type { ReminderDueEvent } from '../../api/types';
import { toast } from '../../state/toasts';
import { openReminderUrl } from './open';

const shown = new Set<string>();

/** A replayed event this old is not shown again (the stream replays after a reconnect). */
const MAX_AGE_MS = 15 * 60 * 1000;

export function showReminder(event: ReminderDueEvent, now: number = Date.now()): boolean {
  if (shown.has(event.key)) return false;
  const sent = Date.parse(event.sentAt);
  if (Number.isFinite(sent) && now - sent > MAX_AGE_MS) return false;
  shown.add(event.key);
  toast(event.title, { kind: 'info', timeout: 0, action: { label: 'Open', run: () => openReminderUrl(event.url) } });
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(event.title, { body: event.body, tag: event.key, icon: '/icon-192.png' });
      n.onclick = () => {
        window.focus();
        openReminderUrl(event.url);
        n.close();
      };
    } catch {
      // iOS and some Android browsers allow notifications only from a service worker: the toast stays.
    }
  }
  return true;
}

/** For tests. */
export function resetShownReminders(): void {
  shown.clear();
}
