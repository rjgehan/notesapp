import { describe, expect, it } from 'vitest';
import { reminderPresets } from './reminderPresets';

const NOW = new Date(2026, 9, 16, 12, 2); // 2026-10-16 12:02, local

describe('reminder presets', () => {
  it('offers times relative to a timed due date and to now', () => {
    const presets = reminderPresets({ due: '2026-10-17T10:30', reminders: [] }, NOW);
    expect(presets.map((p) => `${p.id} ${p.at}`)).toEqual([
      'due 2026-10-17T10:30',
      'due-15 2026-10-17T10:15',
      'due-60 2026-10-17T09:30',
      'day-before 2026-10-16T18:00',
      'in-1h 2026-10-16T13:05',
      'tomorrow 2026-10-17T09:00',
    ]);
  });

  it('uses the morning of an all-day due date and leaves out past and existing times', () => {
    const presets = reminderPresets({ due: '2026-10-16', reminders: [{ at: '2026-10-17T09:00' }] }, NOW);
    // 9:00 today and 18:00 yesterday are past; tomorrow 9:00 is already set.
    expect(presets.map((p) => p.id)).toEqual(['in-1h']);
  });

  it('without a due date offers only the times relative to now', () => {
    expect(reminderPresets({ due: null, reminders: [] }, NOW).map((p) => p.label)).toEqual(['In 1 hour', 'Tomorrow at 9:00']);
  });
});
