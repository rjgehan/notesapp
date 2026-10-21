import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../api/types';
import { buildVaultTree } from '../../api/vaultTree';
import { dayjs } from '../dates';
import { linkOf, weekDailyNotes, weekDays } from './actions';

function entry(path: string): FileEntry {
  const name = path.split('/').pop()!;
  return { path, name, basename: name.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 1, mtime: '2026-10-20T10:00:00.000Z', version: null, aliases: [] };
}

describe('Ask your vault actions', () => {
  it('a week runs Monday to Sunday', () => {
    const days = weekDays(dayjs('2026-10-21T15:00:00')); // a Wednesday
    expect(days.map((d) => d.format('YYYY-MM-DD'))).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(weekDays(dayjs('2026-10-25T09:00:00'))[0].format('YYYY-MM-DD')).toBe('2026-10-19'); // a Sunday
  });

  it("this week's daily notes are the ones that exist, oldest first", () => {
    const tree = buildVaultTree({ eventId: 'b.1', folders: [{ path: 'Daily', name: 'Daily' }], files: [entry('Daily/2026-10-21.md'), entry('Daily/2026-10-19.md'), entry('Daily/2026-10-12.md'), entry('Other.md')] });
    expect(weekDailyNotes(tree, { format: 'YYYY-MM-DD', folder: 'Daily' }, dayjs('2026-10-22T08:00:00'))).toEqual(['Daily/2026-10-19.md', 'Daily/2026-10-21.md']);
  });

  it('cites a note by its path without .md', () => {
    expect(linkOf('Projects/Plan.md')).toBe('Projects/Plan');
    expect(linkOf('Drawings/Sketch.excalidraw')).toBe('Drawings/Sketch.excalidraw');
  });
});
