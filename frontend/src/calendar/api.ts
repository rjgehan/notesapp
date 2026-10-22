// The calendar's endpoint (API.md §25): notes dated by a frontmatter property. Daily notes come
// from the tree and tasks from the task API.
import { apiFetch, query } from '../api/client';
import type { DatedNotesResponse, LocalDate } from '../api/types';

export const calendarApi = {
  datedNotes: (from: LocalDate, to: LocalDate, properties: readonly string[]) =>
    apiFetch<DatedNotesResponse>('/api/notes/by-date' + query({ from, to, property: properties.join(',') || undefined })),
};

export const calendarKeys = {
  all: ['calendar'] as const,
  dated: (from: LocalDate, to: LocalDate, properties: readonly string[]) => ['calendar', 'dated', from, to, properties.join(',')] as const,
};
