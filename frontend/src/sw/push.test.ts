import { describe, expect, it } from 'vitest';
import { actionRequest, reminderNotification, safeAppPath, SNOOZE_MINUTES } from './push';

describe('reminder notifications in the service worker', () => {
  it('turns a task reminder into a notification with Snooze and Done', () => {
    const spec = reminderNotification({ title: 'Pay rent', body: 'Due 2026-10-16', tag: 'task:t1:2026-10-16T12:05', kind: 'task', url: '/x/tasks/today?task=t1', taskId: 't1', at: '2026-10-16T12:05' });
    expect(spec.title).toBe('Pay rent');
    expect(spec.options.body).toBe('Due 2026-10-16');
    expect(spec.options.tag).toBe('task:t1:2026-10-16T12:05');
    expect(spec.options.data).toEqual({ url: '/x/tasks/today?task=t1', taskId: 't1', at: '2026-10-16T12:05' });
    expect(spec.options.actions?.map((a) => a.action)).toEqual(['snooze', 'done']);
  });

  it('shows something for a test or a malformed message, and never opens another site', () => {
    expect(reminderNotification({ title: 'Test', kind: 'test', url: '/settings/reminders', tag: 'test:1' }).options.actions).toBeUndefined();
    const odd = reminderNotification('nonsense');
    expect(odd.title).toBe('NotesApp reminder');
    expect(odd.options.data.url).toBe('/');
    expect(reminderNotification({ url: 'https://evil.example/x' }).options.data.url).toBe('/');
    expect(safeAppPath('//evil.example')).toBe('/');
    expect(safeAppPath('/n/Note.md')).toBe('/n/Note.md');
  });

  it('maps the buttons to the reminder endpoints', () => {
    const data = { url: '/x', taskId: 't1', at: '2026-10-16T12:05' };
    expect(actionRequest('snooze', data)).toEqual({ url: '/api/reminders/snooze', body: { taskId: 't1', at: '2026-10-16T12:05', minutes: SNOOZE_MINUTES } });
    expect(actionRequest('done', data)).toEqual({ url: '/api/reminders/done', body: { taskId: 't1', at: '2026-10-16T12:05' } });
    expect(actionRequest('', data)).toBeNull();
    expect(actionRequest('done', { url: '/', taskId: null, at: null })).toBeNull();
    // A reminder of an extra vault (ROADMAP item 37) acts on that vault's API.
    const work = { url: '/v/work/x/tasks/today?task=t1', taskId: 't1', at: '2026-10-16T12:05' };
    expect(actionRequest('done', work)?.url).toBe('/api/v/work/reminders/done');
    expect(actionRequest('snooze', work)?.url).toBe('/api/v/work/reminders/snooze');
  });
});
