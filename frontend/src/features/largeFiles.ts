// The large-file policy (ROADMAP item 23, DESIGN §5.8 and §6.11): files over the server's threshold
// stay in the vault but their versions are not kept in git history.
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { StatusResponse } from '../api/types';
import { formatBytes } from './format';

/** "25 MB" for a threshold in bytes; whole megabytes and kilobytes are shown without decimals. */
export function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return formatBytes(bytes);
}

/** The threshold from the last /api/status, or null when the policy is off or the status is not loaded. */
export function largeFileLimit(status = queryClient.getQueryData<StatusResponse>(queryKeys.status())): number | null {
  const limit = status?.git.largeFiles.limitBytes ?? null;
  return limit !== null && limit > 0 ? limit : null;
}

/** True when a file of `size` bytes is kept out of history. */
export function isLargeFile(size: number, status?: StatusResponse): boolean {
  const limit = largeFileLimit(status);
  return limit !== null && size > limit;
}
