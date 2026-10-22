// The calendar's per-device preferences (DESIGN §6.32): the first day of the week (the locale's
// by default), whether week numbers show, and the frontmatter properties that date a note
// (`date` by default, API.md §25.1). Device conveniences like the theme, so they live in
// localStorage; without storage the defaults hold.
import { create } from 'zustand';
import { localeWeekStart, type Weekday } from './model';

export interface CalendarPrefs {
  weekStart: 'locale' | Weekday;
  weekNumbers: boolean;
  /** Frontmatter keys, at most `MAX_PROPERTIES`. */
  properties: string[];
}

export const CALENDAR_PREFS_KEY = 'notesapp:calendar';

export const MAX_PROPERTIES = 5;

export const DEFAULT_PROPERTIES = ['date'];

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = { weekStart: 'locale', weekNumbers: true, properties: DEFAULT_PROPERTIES };

/** Comma-separated keys as the server takes them: trimmed, at most 64 characters, no repeats (ignoring case). */
export function parseProperties(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const name = part.trim();
    if (!name || name.length > 64 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, MAX_PROPERTIES);
}

function load(): CalendarPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(CALENDAR_PREFS_KEY) ?? '{}') as Partial<CalendarPrefs> | null;
    const ws = parsed?.weekStart;
    const props = Array.isArray(parsed?.properties) ? parseProperties(parsed.properties.filter((p) => typeof p === 'string').join(',')) : [];
    return {
      weekStart: typeof ws === 'number' && Number.isInteger(ws) && ws >= 0 && ws <= 6 ? (ws as Weekday) : 'locale',
      weekNumbers: typeof parsed?.weekNumbers === 'boolean' ? parsed.weekNumbers : true,
      properties: props.length > 0 ? props : DEFAULT_PROPERTIES,
    };
  } catch {
    return { ...DEFAULT_CALENDAR_PREFS };
  }
}

interface CalendarPrefsState extends CalendarPrefs {
  update(patch: Partial<CalendarPrefs>): void;
}

export const useCalendarPrefs = create<CalendarPrefsState>()((set, get) => ({
  ...load(),
  update(patch) {
    set(patch);
    const { weekStart, weekNumbers, properties } = get();
    try {
      localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify({ weekStart, weekNumbers, properties }));
    } catch {
      // Private mode or quota: the choice holds for this page load.
    }
  },
}));

/** The first day of the week this device uses. */
export function useWeekStart(): Weekday {
  const pref = useCalendarPrefs((s) => s.weekStart);
  return pref === 'locale' ? localeWeekStart() : pref;
}
