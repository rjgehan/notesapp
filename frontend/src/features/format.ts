/** Human-readable byte count. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Counts words (Unicode letters and numbers runs; CJK characters count one each) and characters. */
export function countWords(text: string): { words: number; chars: number } {
  const words = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}'’_-]+/gu);
  return { words: words ? words.length : 0, chars: text.length };
}

const relative = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "yesterday", "just now". */
export function formatRelative(iso: string | number, now = Date.now()): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  for (const [unit, ms] of UNITS) {
    if (abs >= ms || unit === 'minute') {
      const value = Math.round(diff / ms);
      return relative ? relative.format(value, unit) : `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? '' : 's'} ${diff < 0 ? 'ago' : 'from now'}`;
    }
  }
  return '';
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Absolute local date and time, for tooltips. */
export function formatDateTime(iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(t) ? '' : dateTime.format(t);
}

/** "for 5 minutes" style duration since `iso`. */
export function formatSince(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'for less than a minute';
  if (minutes < 60) return `for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `for ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `for ${days} days`;
}
