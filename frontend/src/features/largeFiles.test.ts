import { afterEach, describe, expect, it } from 'vitest';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { StatusResponse } from '../api/types';
import { formatLimit, isLargeFile, largeFileLimit } from './largeFiles';

function status(limitBytes: number | null): StatusResponse {
  return { git: { largeFiles: { limitBytes, files: 0, bytes: 0 } } } as StatusResponse;
}

afterEach(() => {
  queryClient.clear();
});

describe('large-file policy (ROADMAP item 23)', () => {
  it('formats thresholds the way they are configured', () => {
    expect(formatLimit(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatLimit(1024)).toBe('1 KB');
    expect(formatLimit(1500)).toBe('1.5 KB');
  });

  it('a file is large only when it is strictly over the threshold', () => {
    expect(isLargeFile(1024, status(1024))).toBe(false);
    expect(isLargeFile(1025, status(1024))).toBe(true);
  });

  it('nothing is large while the policy is off or the status is unknown', () => {
    expect(isLargeFile(10 ** 9, status(null))).toBe(false);
    expect(isLargeFile(10 ** 9)).toBe(false);
    expect(largeFileLimit()).toBeNull();
    queryClient.setQueryData(queryKeys.status(), status(2048));
    expect(largeFileLimit()).toBe(2048);
    expect(isLargeFile(4096)).toBe(true);
  });
});
