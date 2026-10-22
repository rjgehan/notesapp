import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../../state/toasts';
import { useTaskUi } from '../../tasks/ui/state';
import { defaultDeviceName, keyBytes } from './device';
import { resetShownReminders, showReminder } from './inApp';
import { consumeLaunchTask } from './open';
import type { ReminderDueEvent } from '../../api/types';

const event = (over: Partial<ReminderDueEvent> = {}): ReminderDueEvent => ({
  key: 'task:t1:2026-10-16T12:05',
  kind: 'task',
  taskId: 't1',
  at: '2026-10-16T12:05',
  title: 'Pay rent',
  body: 'Due 2026-10-16',
  url: '/x/tasks/today?task=t1',
  sentAt: new Date().toISOString(),
  ...over,
});

describe('in-app reminders', () => {
  beforeEach(() => {
    resetShownReminders();
    useToasts.setState({ toasts: [] });
  });

  it('shows a reminder once as a toast whose action opens the task', () => {
    expect(showReminder(event())).toBe(true);
    expect(showReminder(event())).toBe(false);
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Pay rent');
    expect(toasts[0].action?.label).toBe('Open');
    toasts[0].action?.run();
    expect(useTaskUi.getState().detailId).toBe('t1');
    useTaskUi.getState().closeDetail();
  });

  it('does not show a replayed reminder sent long ago', () => {
    expect(showReminder(event({ key: 'old', sentAt: '2020-01-01T00:00:00Z' }))).toBe(false);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});

describe('opening a reminder at startup', () => {
  afterEach(() => useTaskUi.getState().closeDetail());

  it('opens ?task= and removes it from the address', () => {
    const replaceState = vi.fn();
    const id = consumeLaunchTask({ search: '?task=abc&view=x', pathname: '/x/tasks/today', hash: '' } as Location, { state: null, replaceState } as unknown as History);
    expect(id).toBe('abc');
    expect(useTaskUi.getState().detailId).toBe('abc');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/x/tasks/today?view=x');
    expect(consumeLaunchTask({ search: '', pathname: '/', hash: '' } as Location, { state: null, replaceState } as unknown as History)).toBeNull();
  });
});

describe('this device', () => {
  it('names the device from its user agent', () => {
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 5)).toBe('iPhone · Safari');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 0)).toBe('Windows · Edge');
    expect(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5)).toBe('iPad · Safari');
  });

  it('decodes the base64url VAPID key', () => {
    const bytes = keyBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });
});
