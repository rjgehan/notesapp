// What the habits page and panel do (DESIGN §6.35): check-ins, new habits and habit changes, each
// shown at once (the query is patched) and then written to the notes; the query is refetched after.
import { isProblem } from '../api/client';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import type { HabitsResponse } from '../api/types';
import { toastError } from '../features/errors';
import { joinPath } from '../features/paths';
import { newIdempotencyKey } from '../state/clientId';
import { toast } from '../state/toasts';
import { applyWriteResult } from '../sync/treePatch';
import { habitKeys } from './api';
import { setProperty, yamlScalar, type PropertyValue } from './frontmatterEdit';
import { dailyValue, isCheckedValue, propertyKey, scheduleValue, type Habit, type Schedule } from './model';
import { editNote, withEntry } from './write';

function patch(fn: (data: HabitsResponse) => HabitsResponse): void {
  queryClient.setQueryData<HabitsResponse>(habitKeys.all, (data) => (data ? fn(data) : data));
}

function refetch(): void {
  void queryClient.invalidateQueries({ queryKey: habitKeys.all });
}

export interface CheckInContext {
  byDay: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
  dailyPaths: ReadonlyMap<string, string>;
}

/**
 * Marks `habit` done or not done on `day`. Done adds the day to the habit note's `entries`; not
 * done removes it there, and sets the daily note's property to false when that is what checked it.
 */
export async function setCheckIn(habit: Habit, day: string, done: boolean, ctx: CheckInContext): Promise<void> {
  const dailyPath = ctx.dailyPaths.get(day);
  const clearDaily = !done && dailyPath !== undefined && isCheckedValue(dailyValue(habit, ctx.byDay, day));
  const key = habit.property.toLowerCase();
  patch((data) => ({
    ...data,
    habits: data.habits.map((h) => {
      if (h.path !== habit.path) return h;
      const raw = h.properties.entries;
      const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
      const entries = done ? [...new Set([...list, day])].sort() : list.filter((d) => !d.startsWith(day));
      return { ...h, properties: { ...h.properties, entries } };
    }),
    daily: clearDaily
      ? data.daily.map((n) => (n.path === dailyPath ? { ...n, values: Object.fromEntries(Object.entries(n.values).map(([k, v]) => [k, k.toLowerCase() === key ? false : v])) } : n))
      : data.daily,
  }));
  try {
    await editNote(habit.path, (text) => withEntry(text, day, done));
    if (clearDaily) await editNote(dailyPath, (text) => setProperty(text, habit.property, false));
  } catch (e) {
    toastError(e, habit.name);
  } finally {
    refetch();
  }
}

export interface HabitFields {
  name: string;
  schedule: Schedule;
  color: string | null;
  property: string;
  maxGap: number;
}

/** The frontmatter of a new habit note. */
export function newHabitContent(f: HabitFields, fileName: string, today: string): string {
  const lines = ['---'];
  if (f.name !== fileName) lines.push(`title: ${yamlScalar(f.name)}`);
  if (f.color) lines.push(`color: ${yamlScalar(f.color)}`);
  lines.push(`schedule: ${yamlScalar(scheduleValue(f.schedule))}`);
  if (f.property && f.property !== propertyKey(fileName)) lines.push(`property: ${yamlScalar(f.property)}`);
  if (f.maxGap > 0) lines.push(`maxGap: ${f.maxGap}`);
  lines.push(`created: ${today}`, 'entries: []', '---', '');
  return lines.join('\n');
}

/** A file name for a habit: its name without the characters file names cannot hold. */
export function habitFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** Creates the habit note; returns its path, or null when it failed (a toast says why). */
export async function createHabit(folder: string, f: HabitFields, today: string): Promise<string | null> {
  const fileName = habitFileName(f.name);
  if (!fileName) return null;
  const path = joinPath(folder, fileName + '.md');
  const content = newHabitContent(f, fileName, today);
  try {
    const result = await api.createFile({ path, content, onConflict: 'fail' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, content);
    refetch();
    return result.file.path;
  } catch (e) {
    if (isProblem(e, 'already-exists') || isProblem(e, 'case-collision')) toast(`A note named ${fileName} already exists`, { kind: 'error' });
    else toastError(e);
    return null;
  }
}

/** Changes properties of a habit note; null removes one. */
export async function updateHabit(habit: Habit, changes: Record<string, PropertyValue | null>): Promise<boolean> {
  patch((data) => ({
    ...data,
    habits: data.habits.map((h) => {
      if (h.path !== habit.path) return h;
      const properties = { ...h.properties };
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete properties[k];
        else properties[k] = v;
      }
      return { ...h, properties };
    }),
  }));
  try {
    await editNote(habit.path, (text) => Object.entries(changes).reduce((t, [k, v]) => setProperty(t, k, v), text));
    return true;
  } catch (e) {
    toastError(e, habit.name);
    return false;
  } finally {
    refetch();
  }
}
