// The habit endpoint (API.md §35). Check-ins are note edits through the vault API (write.ts).
import { apiFetch } from '../api/client';
import type { HabitsResponse } from '../api/types';

export const habitApi = {
  list: () => apiFetch<HabitsResponse>('/api/habits'),
};

export const habitKeys = {
  all: ['habits'] as const,
};
