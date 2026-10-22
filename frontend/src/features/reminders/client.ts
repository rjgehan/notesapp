// HTTP for reminders and Web Push subscriptions (API.md §25).
import { apiFetch } from '../../api/client';
import type {
  PushDevice,
  PushKey,
  PushSubscriptionRequest,
  ReminderActionRequest,
  ReminderActionResult,
  RemindersStatus,
  ReminderTestRequest,
  ReminderTestResult,
} from '../../api/types';

export const REMINDERS_STATUS_KEY = ['reminders', 'status'] as const;

export const remindersApi = {
  status: () => apiFetch<RemindersStatus>('/api/reminders/status'),
  reportZone: (zone: string) => apiFetch<void>('/api/reminders/zone', { method: 'PUT', json: { zone } }),
  pushKey: () => apiFetch<PushKey>('/api/push/key', { method: 'POST' }),
  subscribe: (req: PushSubscriptionRequest) => apiFetch<PushDevice>('/api/push/subscriptions', { method: 'POST', json: req }),
  unsubscribe: (id: string) => apiFetch<void>(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  test: (req: ReminderTestRequest) => apiFetch<ReminderTestResult>('/api/reminders/test', { method: 'POST', json: req }),
  snooze: (req: ReminderActionRequest) => apiFetch<ReminderActionResult>('/api/reminders/snooze', { method: 'POST', json: req }),
  done: (req: ReminderActionRequest) => apiFetch<ReminderActionResult>('/api/reminders/done', { method: 'POST', json: req }),
};
