import { describe, expect, it } from 'vitest';
import { setKanbanAsMarkdown, showsKanbanAsMarkdown } from './detect';

describe('boards shown as Markdown', () => {
  it('are remembered per path until switched back', () => {
    expect(showsKanbanAsMarkdown('B.md')).toBe(false);
    setKanbanAsMarkdown('B.md', true);
    expect(showsKanbanAsMarkdown('B.md')).toBe(true);
    expect(showsKanbanAsMarkdown('C.md')).toBe(false);
    setKanbanAsMarkdown('B.md', false);
    expect(showsKanbanAsMarkdown('B.md')).toBe(false);
  });
});
