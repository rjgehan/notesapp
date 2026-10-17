// Test builders for tasks and lists (used by the tasks tests only).
import type { Task, TaskList, TaskSection } from '../api/types';

let seq = 0;

export function makeTask(fields: Partial<Task> = {}): Task {
  seq++;
  return {
    id: `T${String(seq).padStart(4, '0')}`,
    listId: 'L1',
    sectionId: null,
    parentId: null,
    title: `Task ${seq}`,
    notes: null,
    status: 'open',
    priority: 0,
    due: null,
    start: null,
    recurrence: null,
    reminders: [],
    tags: [],
    links: [],
    order: 'a0',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    completedAt: null,
    archived: false,
    ...fields,
  };
}

export function makeList(fields: Partial<TaskList> = {}): TaskList {
  return {
    id: 'L1',
    name: 'Home',
    color: null,
    icon: null,
    order: 'a0',
    archived: false,
    sections: [],
    path: 'Tasks/Home.tasks',
    writable: true,
    ...fields,
  };
}

export function makeSection(id: string, name: string, order: string): TaskSection {
  return { id, name, order };
}
