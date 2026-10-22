// Scripts in notes (ROADMAP items 40 and 17): `GET /api/notes/query` (API.md §40.1), the metadata
// of many notes at once from the server's index. Tags and properties repeat as parameters.
import { apiFetch } from '../api/client';
import type { NotesQueryResponse } from '../api/types';

export interface NotesFilter {
  path?: string | null;
  tag?: readonly string[];
  folder?: string | null;
  /** `name`, `name=value` or `name!=value`. */
  prop?: readonly string[];
  linksTo?: string | null;
  q?: string | null;
  tasks?: boolean;
  limit?: number;
}

export function notesQueryUrl(f: NotesFilter): string {
  const params = new URLSearchParams();
  if (f.path) params.append('path', f.path);
  for (const t of f.tag ?? []) params.append('tag', t);
  if (f.folder) params.append('folder', f.folder);
  for (const p of f.prop ?? []) params.append('prop', p);
  if (f.linksTo) params.append('linksTo', f.linksTo);
  if (f.q) params.append('q', f.q);
  if (f.tasks) params.append('tasks', 'true');
  if (f.limit !== undefined) params.append('limit', String(f.limit));
  // encodeURIComponent, not URLSearchParams' `+` for spaces (API.md §1.3).
  const qs = [...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return '/api/notes/query' + (qs ? `?${qs}` : '');
}

export function queryNotes(f: NotesFilter): Promise<NotesQueryResponse> {
  return apiFetch<NotesQueryResponse>(notesQueryUrl(f));
}
