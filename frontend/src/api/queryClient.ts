import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Problems are terminal (API.md §3); only transient failures are worth retrying.
        retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 4,
        retryDelay: (attempt) => Math.min(30_000, 1000 * 2 ** attempt),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();
