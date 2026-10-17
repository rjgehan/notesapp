// The task endpoints (API.md §20, §18). Kept beside the feature rather than in api/endpoints.ts:
// the dev-only in-memory mock implements the vault API only, so task views need the server.
import { apiFetch, query } from '../api/client';
import type {
  CompleteTaskRequest,
  CreateTaskListRequest,
  CreateTaskRequest,
  LocalDate,
  ReorderRequest,
  ReorderTasksRequest,
  SectionRequest,
  Task,
  TaskListsResponse,
  TaskListWriteResult,
  TasksResponse,
  TaskView,
  TaskWriteResult,
  UpdateTaskListRequest,
  UpdateTaskRequest,
} from '../api/types';

/** The parameters of GET /api/tasks (§20.2). */
export interface TaskQueryParams {
  view: TaskView;
  list?: string;
  tag?: string;
  priority?: string;
  status?: string;
  q?: string;
  date?: LocalDate;
  tz?: string;
  days?: number;
  limit?: number;
  before?: string;
}

const id = (value: string) => encodeURIComponent(value);
const post = <T>(url: string, json: unknown, key?: string) => apiFetch<T>(url, { method: 'POST', json, idempotencyKey: key });

export const taskApi = {
  query: (q: TaskQueryParams) => apiFetch<TasksResponse>('/api/tasks' + query({ ...q })),
  get: (taskId: string) => apiFetch<Task>(`/api/tasks/${id(taskId)}`),
  create: (req: CreateTaskRequest, key?: string) => post<TaskWriteResult>('/api/tasks', req, key),
  update: (taskId: string, req: UpdateTaskRequest, key?: string) =>
    apiFetch<TaskWriteResult>(`/api/tasks/${id(taskId)}`, { method: 'PATCH', json: req, idempotencyKey: key }),
  complete: (taskId: string, req: CompleteTaskRequest, key?: string) => post<TaskWriteResult>(`/api/tasks/${id(taskId)}/complete`, req, key),
  uncomplete: (taskId: string, key?: string) => apiFetch<TaskWriteResult>(`/api/tasks/${id(taskId)}/uncomplete`, { method: 'POST', idempotencyKey: key }),
  reorder: (req: ReorderTasksRequest, key?: string) => post<TaskWriteResult>('/api/tasks/reorder', req, key),
  remove: (taskId: string, key?: string) => apiFetch<TaskWriteResult>(`/api/tasks/${id(taskId)}`, { method: 'DELETE', idempotencyKey: key }),

  lists: () => apiFetch<TaskListsResponse>('/api/tasks/lists'),
  createList: (req: CreateTaskListRequest, key?: string) => post<TaskListWriteResult>('/api/tasks/lists', req, key),
  updateList: (listId: string, req: UpdateTaskListRequest, key?: string) =>
    apiFetch<TaskListWriteResult>(`/api/tasks/lists/${id(listId)}`, { method: 'PATCH', json: req, idempotencyKey: key }),
  deleteList: (listId: string, key?: string) => apiFetch<TaskListWriteResult>(`/api/tasks/lists/${id(listId)}`, { method: 'DELETE', idempotencyKey: key }),
  reorderLists: (req: ReorderRequest, key?: string) => post<TaskListWriteResult>('/api/tasks/lists/reorder', req, key),
  createSection: (listId: string, req: SectionRequest, key?: string) => post<TaskListWriteResult>(`/api/tasks/lists/${id(listId)}/sections`, req, key),
  renameSection: (listId: string, sectionId: string, req: SectionRequest, key?: string) =>
    apiFetch<TaskListWriteResult>(`/api/tasks/lists/${id(listId)}/sections/${id(sectionId)}`, { method: 'PATCH', json: req, idempotencyKey: key }),
  deleteSection: (listId: string, sectionId: string, key?: string) =>
    apiFetch<TaskListWriteResult>(`/api/tasks/lists/${id(listId)}/sections/${id(sectionId)}`, { method: 'DELETE', idempotencyKey: key }),
};
