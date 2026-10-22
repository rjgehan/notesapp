import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api/queryClient';
import { calendarKeys } from './api';
import { REFRESH_DEBOUNCE_MS, scheduleDatedRefresh } from './register';

describe('the dated notes follow note events (API.md §25.1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refetches once for a burst of note events', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    scheduleDatedRefresh({ path: 'Meetings/Kickoff.md' });
    scheduleDatedRefresh({ file: { path: 'Trips/Lisbon.md' } });
    scheduleDatedRefresh({ from: 'Old', to: 'New' });
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: calendarKeys.all });
  });

  it('ignores files that cannot hold frontmatter', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    scheduleDatedRefresh({ path: 'Attachments/photo.png' });
    scheduleDatedRefresh({ path: 'Tasks/Home.tasks' });
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
