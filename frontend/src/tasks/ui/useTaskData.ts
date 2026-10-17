import { useMemo } from 'react';
import type { Task, TaskList } from '../../api/types';
import { taskStore, useTaskStore } from '../store';

export interface TaskData {
  version: number;
  tasks: ReadonlyMap<string, Task>;
  lists: TaskList[];
  listMap: ReadonlyMap<string, TaskList>;
}

/** The store's tasks and lists, re-rendering on every change. */
export function useTaskData(): TaskData {
  const version = useTaskStore();
  return useMemo(() => ({ version, tasks: taskStore.tasks(), lists: taskStore.lists(), listMap: taskStore.listMapView() }), [version]);
}
