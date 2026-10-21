import { describe, expect, it } from 'vitest';
import { captureRequest, fromShare, hasContent, lastTarget, rememberTarget } from './capture';
import { dayjs } from './dates';

describe('capture request', () => {
  it('carries the device’s date, time and zone, so "today" is decided on the device', () => {
    const now = dayjs('2026-10-16T23:58:00');
    expect(captureRequest({ text: '  Late thought \n', url: null, title: null, target: 'daily' }, now, 'America/New_York')).toEqual({
      text: 'Late thought',
      target: 'daily',
      date: '2026-10-16',
      time: '23:58',
      tz: 'America/New_York',
    });
  });

  it('sends a link with its title, and no text when there is none', () => {
    const now = dayjs('2026-01-02T08:05:00');
    expect(captureRequest({ text: '', url: 'https://example.com', title: 'Example', target: 'inbox' }, now, 'UTC')).toEqual({
      text: null,
      target: 'inbox',
      url: 'https://example.com',
      title: 'Example',
      date: '2026-01-02',
      time: '08:05',
      tz: 'UTC',
    });
  });

  it('needs text, a link or a file', () => {
    expect(hasContent({ text: '  ', url: null }, 0)).toBe(false);
    expect(hasContent({ text: 'x', url: null }, 0)).toBe(true);
    expect(hasContent({ text: '', url: 'https://x' }, 0)).toBe(true);
    expect(hasContent({ text: '', url: null }, 1)).toBe(true);
  });

  it('remembers the target per device', () => {
    expect(lastTarget()).toBe('inbox');
    rememberTarget('daily');
    expect(lastTarget()).toBe('daily');
  });
});

describe('shares from other apps', () => {
  it('keeps a URL sent as the URL (iOS, desktop browsers)', () => {
    expect(fromShare({ title: 'A page', text: '', url: 'https://example.com/a' })).toEqual({ text: '', url: 'https://example.com/a', title: 'A page' });
  });

  it('takes a link out of the text (Android puts it there)', () => {
    expect(fromShare({ title: null, text: 'Worth reading https://example.com/a?b=1.', url: null })).toEqual({
      text: 'Worth reading',
      url: 'https://example.com/a?b=1',
      title: null,
    });
    expect(fromShare({ text: 'https://example.com/only' })).toEqual({ text: '', url: 'https://example.com/only', title: null });
  });

  it('drops a title that only repeats the text or the link', () => {
    // Android Chrome: the page title as the title and again before the link in the text.
    expect(fromShare({ title: 'Great article', text: 'Great article https://example.com/g' })).toEqual({
      text: '',
      url: 'https://example.com/g',
      title: 'Great article',
    });
    expect(fromShare({ title: 'https://example.com/g', url: 'https://example.com/g' })).toEqual({ text: '', url: 'https://example.com/g', title: null });
    expect(fromShare({ title: 'Note to self', text: 'Note to self' })).toEqual({ text: 'Note to self', url: null, title: null });
  });

  it('removes the URL from the text when both carry it', () => {
    expect(fromShare({ text: 'Look: https://example.com/x', url: 'https://example.com/x' })).toEqual({ text: 'Look:', url: 'https://example.com/x', title: null });
  });

  it('keeps plain text as is', () => {
    expect(fromShare({ text: '  Milk\nEggs  ' })).toEqual({ text: 'Milk\nEggs', url: null, title: null });
  });
});
