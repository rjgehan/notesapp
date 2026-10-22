// Reminders in the service worker (DESIGN §6.38, ROADMAP item 9), as pure functions: the push
// message (written by the server's WebPushRoute) becomes a notification, and a click becomes either
// an API call (Snooze, Done) or a page to open. `sw.ts` wires them to the `push` and
// `notificationclick` events. Nothing here touches a browser global.

import { vaultFromPathname } from './vaultPath';

/** What the server encrypts into each push message. */
export interface ReminderPush {
  title: string;
  body: string;
  tag: string;
  kind: 'task' | 'daily' | 'test';
  url: string;
  taskId?: string;
  at?: string;
}

/** The data a reminder notification carries to its click handler. */
export interface ReminderNotificationData {
  url: string;
  taskId: string | null;
  at: string | null;
}

export interface NotificationSpec {
  title: string;
  options: {
    body: string;
    tag: string;
    icon: string;
    badge: string;
    data: ReminderNotificationData;
    actions?: Array<{ action: string; title: string }>;
    requireInteraction?: boolean;
  };
}

/** Minutes a notification's Snooze button snoozes for. */
export const SNOOZE_MINUTES = 10;

/** Only app paths are opened, so a message can never send the app elsewhere. */
export function safeAppPath(url: unknown): string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * The notification for a push message's JSON. A message that is not one of ours still shows
 * something: browsers (Safari above all) penalise a push that shows no notification.
 */
export function reminderNotification(json: unknown): NotificationSpec {
  const p = (json && typeof json === 'object' ? json : {}) as Partial<ReminderPush>;
  const taskId = typeof p.taskId === 'string' ? p.taskId : null;
  const at = typeof p.at === 'string' ? p.at : null;
  const spec: NotificationSpec = {
    title: text(p.title, 'NotesApp reminder') || 'NotesApp reminder',
    options: {
      body: text(p.body, ''),
      tag: text(p.tag, 'notesapp-reminder'),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: safeAppPath(p.url), taskId, at },
    },
  };
  // Action buttons show on desktop Chrome, Edge and Android; iOS shows none (a tap opens the task).
  if (taskId && at) {
    spec.options.actions = [
      { action: 'snooze', title: `Snooze ${SNOOZE_MINUTES} min` },
      { action: 'done', title: 'Done' },
    ];
    spec.options.requireInteraction = true;
  }
  return spec;
}

/** The request a notification button makes, or null when the click opens the app. */
export function actionRequest(action: string, data: Partial<ReminderNotificationData> | null | undefined): { url: string; body: { taskId: string; at: string; minutes?: number } } | null {
  if (!data?.taskId || !data.at) return null;
  // The reminder's vault (DESIGN §6.41): its app URL starts with /v/<name>/ unless it is the default vault.
  const vault = vaultFromPathname(safeAppPath(data.url));
  const api = vault === null ? '/api' : `/api/v/${vault}`;
  if (action === 'snooze') return { url: api + '/reminders/snooze', body: { taskId: data.taskId, at: data.at, minutes: SNOOZE_MINUTES } };
  if (action === 'done') return { url: api + '/reminders/done', body: { taskId: data.taskId, at: data.at } };
  return null;
}

/** The message a focused tab receives to open a reminder without reloading. */
export const OPEN_MESSAGE = 'notesapp:open-reminder';
