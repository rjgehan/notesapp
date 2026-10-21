// The habits of the vault, for the page and the panel (DESIGN §6.35).
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useVaultSettings } from '../api/hooks';
import type { HabitsResponse } from '../api/types';
import { dailyNoteDate } from '../features/daily';
import { habitApi, habitKeys } from './api';
import { dailyValues, habitOf, type Habit } from './model';

export interface HabitData {
  loading: boolean;
  error: unknown;
  data: HabitsResponse | undefined;
  habits: Habit[];
  /** Daily-note values by day. */
  byDay: Map<string, Map<string, unknown>>;
  /** The daily note of each day that has values. */
  dailyPaths: Map<string, string>;
}

export function useHabits(): HabitData {
  const query = useQuery({ queryKey: habitKeys.all, queryFn: habitApi.list, staleTime: 0 });
  const settings = useVaultSettings();
  const format = settings.dailyNotes.format;
  const data = query.data;
  const byDay = useMemo(() => (data ? dailyValues(data.daily, { format }, data.dailyFolder) : new Map<string, Map<string, unknown>>()), [data, format]);
  const dailyPaths = useMemo(() => {
    const out = new Map<string, string>();
    if (!data) return out;
    for (const note of data.daily) {
      const date = dailyNoteDate(note.path, { format, folder: data.dailyFolder });
      if (date) out.set(date.format('YYYY-MM-DD'), note.path);
    }
    return out;
  }, [data, format]);
  const habits = useMemo(
    () => (data ? data.habits.map((h) => habitOf(h, byDay)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : []),
    [data, byDay],
  );
  return { loading: query.isPending, error: query.error, data, habits, byDay, dailyPaths };
}
