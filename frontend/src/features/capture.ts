// Quick capture (ROADMAP item 7, DESIGN §6.22): the request a capture sends, and what another app
// shared (Web Share Target) turned into capture fields. "Today" is decided here, on the device:
// the request carries the local date and time and the IANA zone (API.md §8.5).
import type { CaptureRequest, CaptureTarget } from '../api/types';
import type { Dayjs } from './dates';

export interface CaptureInput {
  text: string;
  url: string | null;
  title: string | null;
  target: CaptureTarget;
}

export interface SharedData {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+/i;

/** The device's IANA time zone, when the browser knows it. */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The request for a capture made at `now` (local time); queued captures keep their own time. */
export function captureRequest(input: CaptureInput, now: Dayjs, tz: string | undefined = deviceTimeZone()): CaptureRequest {
  const req: CaptureRequest = { text: input.text.trim() || null, target: input.target, date: now.format('YYYY-MM-DD'), time: now.format('HH:mm') };
  if (input.url) req.url = input.url;
  if (input.title) req.title = input.title;
  if (tz) req.tz = tz;
  return req;
}

/** Whether there is anything to capture. */
export function hasContent(input: Pick<CaptureInput, 'text' | 'url'>, files: number): boolean {
  return input.text.trim() !== '' || !!input.url || files > 0;
}

/**
 * Capture fields from a share. Apps disagree on where they put a link: iOS and desktop browsers
 * send `url`, Android often puts it in `text` (alone or after the page title). The link is taken
 * out of the text and kept as the URL, and a title that only repeats the text or the link is dropped.
 */
export function fromShare(shared: SharedData): Pick<CaptureInput, 'text' | 'url' | 'title'> {
  let text = (shared.text ?? '').trim();
  let url = (shared.url ?? '').trim() || null;
  let title = (shared.title ?? '').trim() || null;
  if (!url) {
    const m = URL_IN_TEXT.exec(text);
    if (m) {
      url = m[0].replace(/[.,;:!?)\]]+$/, '');
      text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[ \t]{2,}/g, ' ').trim();
    }
  } else if (text.includes(url)) {
    text = text.replace(url, '').replace(/[ \t]{2,}/g, ' ').trim();
  }
  if (title && (title === url || title === text)) {
    if (title === text && url) text = '';
    else title = null;
  }
  return { text, url, title };
}

/** Where a capture went, for messages: "Inbox" or "today's note". */
export function targetLabel(target: CaptureTarget): string {
  return target === 'daily' ? "today's note" : 'Inbox';
}

const TARGET_KEY = 'notesapp:captureTarget';

/** The target picked last on this device (Inbox by default). */
export function lastTarget(): CaptureTarget {
  try {
    return localStorage.getItem(TARGET_KEY) === 'daily' ? 'daily' : 'inbox';
  } catch {
    return 'inbox';
  }
}

export function rememberTarget(target: CaptureTarget): void {
  try {
    localStorage.setItem(TARGET_KEY, target);
  } catch {
    // Private mode: the default applies next time.
  }
}
