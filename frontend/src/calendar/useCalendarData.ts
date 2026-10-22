// What the calendar shows for a range of days (DESIGN §6.32): each day's daily note, from the tree;
// its tasks, from the task store, and the coming occurrences of repeating tasks; and the notes a
// frontmatter property dates (API.md §25). All are live: SSE keeps the tree current, task events
// (plus the refetch after a hand edit of a `.tasks` file) keep the store current, and note events
// refetch the dated notes (register.ts).
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTree, useVaultSettings } from '../api/hooks';
import type { DatedNote, FileEntry, LocalDate, Task } from '../api/types';
import { EMPTY_TREE, buildVaultTree } from '../api/vaultTree';
import { dailyNoteEntry } from '../features/daily';
import { dayjs } from '../features/dates';
import type { TaskQueryParams } from '../tasks/api';
import { addDays, useToday } from '../tasks/dates';
import { useTaskView } from '../tasks/queries';
import { useTaskData, type TaskData } from '../tasks/ui/useTaskData';
import { calendarApi, calendarKeys } from './api';
import { tasksByDay } from './model';
import { useCalendarPrefs } from './prefs';
import { repeatsByDay } from './repeats';

/** Every task of every active list, closed ones too, so a day shows what was done on it. */
export const CALENDAR_TASKS: TaskQueryParams = { view: 'list', status: 'all' };

const EMPTY = buildVaultTree(EMPTY_TREE);

export interface CalendarData {
  notes: ReadonlyMap<LocalDate, FileEntry>;
  /** Notes dated by a property, without the day's own daily note. */
  dated: ReadonlyMap<LocalDate, DatedNote[]>;
  tasks: ReadonlyMap<LocalDate, Task[]>;
  /** Repeating tasks on the later days their rule produces (repeats.ts). */
  repeats: ReadonlyMap<LocalDate, Task[]>;
  taskData: TaskData;
  tasksLoading: boolean;
  tasksError: unknown;
  retryTasks(): void;
}

export function useCalendarData(days: readonly LocalDate[]): CalendarData {
  const today = useToday();
  const tree = useTree().data ?? EMPTY;
  const daily = useVaultSettings().dailyNotes;
  const query = useTaskView(CALENDAR_TASKS);
  const taskData = useTaskData();
  const properties = useCalendarPrefs((s) => s.properties);
  const first = days[0];
  const last = days[days.length - 1];
  const datedQuery = useQuery({
    queryKey: calendarKeys.dated(first ?? '', last ?? '', properties),
    queryFn: () => calendarApi.datedNotes(first, last, properties),
    enabled: Boolean(first && last),
    staleTime: 0,
    placeholderData: (previous) => previous,
  });
  const { folder, format } = daily;
  const notes = useMemo(() => {
    const map = new Map<LocalDate, FileEntry>();
    if (!first || !last) return map;
    // `days` is a new array on every render; its ends name the range.
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const entry = dailyNoteEntry({ folder, format }, tree, dayjs(day, 'YYYY-MM-DD'));
      if (entry) map.set(day, entry);
    }
    return map;
  }, [tree, folder, format, first, last]);
  const datedNotes = datedQuery.data?.notes;
  const dated = useMemo(() => {
    const map = new Map<LocalDate, DatedNote[]>();
    for (const n of datedNotes ?? []) {
      if (n.day < first || n.day > last || notes.get(n.day)?.path === n.path) continue;
      const bucket = map.get(n.day);
      if (bucket) bucket.push(n);
      else map.set(n.day, [n]);
    }
    return map;
  }, [datedNotes, notes, first, last]);
  const tasks = useMemo(
    () => (first && last ? tasksByDay(taskData.tasks.values(), taskData.listMap, taskData.lists, first, last) : new Map<LocalDate, Task[]>()),
    [taskData, first, last],
  );
  const repeats = useMemo(
    () => (first && last ? repeatsByDay(taskData.tasks.values(), taskData.listMap, first, last, today) : new Map<LocalDate, Task[]>()),
    [taskData, first, last, today],
  );
  return {
    notes,
    dated,
    tasks,
    repeats,
    taskData,
    tasksLoading: query.isPending,
    tasksError: query.isError ? query.error : null,
    retryTasks: () => void query.refetch(),
  };
}
