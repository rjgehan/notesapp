import { describe, expect, it } from 'vitest';
import { cardMeta, cardToMd, isKanbanText, laneHeading, newBoardText, parseBoard, parseLaneTitle, serializeBoard } from './format';

// A board exactly as the Obsidian Kanban plugin writes one (boardToMd).
const SETTINGS = '%% kanban:settings\n```\n{"kanban-plugin":"basic","lane-width":300,"show-checkboxes":true}\n```\n%%';
const PLUGIN_BOARD = [
  '---',
  '',
  'kanban-plugin: basic',
  '',
  '---',
  '',
  '## To do',
  '',
  '- [ ] Buy [[Milk]] @{2026-10-21}',
  '- [ ] Two lines',
  '    second line',
  '',
  '',
  '## Doing (2)',
  '',
  '',
  '',
  '## Done',
  '',
  '**Complete**',
  '- [x] Shipped ^abc123',
  '',
  '',
  '***',
  '',
  '## Archive',
  '',
  '- [x] Old',
  '- [x] Older',
  '',
  SETTINGS,
].join('\n');

describe('isKanbanText', () => {
  it('is true for notes with kanban-plugin in their frontmatter only', () => {
    expect(isKanbanText(PLUGIN_BOARD)).toBe(true);
    expect(isKanbanText('---\ntitle: x\nkanban-plugin: board\n---\n')).toBe(true);
    expect(isKanbanText('---\ntitle: x\n---\nkanban-plugin: basic\n')).toBe(false);
    expect(isKanbanText('# kanban-plugin: basic')).toBe(false);
    expect(isKanbanText('')).toBe(false);
  });
});

describe('parseBoard', () => {
  const board = parseBoard(PLUGIN_BOARD);

  it('reads lanes, limits, the complete marker, cards and the archive', () => {
    expect(board.lanes.map((l) => [l.title, l.maxItems, l.complete, l.cards.length])).toEqual([
      ['To do', 0, false, 2],
      ['Doing', 2, false, 0],
      ['Done', 0, true, 1],
    ]);
    expect(board.lanes[0].cards[1]).toEqual({ check: ' ', text: 'Two lines\nsecond line' });
    expect(board.lanes[2].cards[0]).toEqual({ check: 'x', text: 'Shipped ^abc123' });
    expect(board.archive.map((c) => c.text)).toEqual(['Old', 'Older']);
    expect(board.settings).toEqual({ 'kanban-plugin': 'basic', 'lane-width': 300, 'show-checkboxes': true });
    expect(board.settingsBlock).toBe(SETTINGS);
    expect(board.problems).toEqual([]);
  });

  it('writes a board the plugin wrote back byte for byte', () => {
    expect(serializeBoard(board)).toBe(PLUGIN_BOARD);
  });

  it('keeps an unusual settings block verbatim', () => {
    const odd = PLUGIN_BOARD.replace(SETTINGS, '%% kanban:settings\n```\n{ "kanban-plugin" : "basic" ,\n  "x": [1,2] }\n```\n%%\n');
    const parsed = parseBoard(odd);
    expect(serializeBoard({ ...parsed, lanes: parsed.lanes.slice(0, 1) }).endsWith('{ "kanban-plugin" : "basic" ,\n  "x": [1,2] }\n```\n%%\n')).toBe(true);
    expect(parsed.settings).toEqual({ 'kanban-plugin': 'basic', x: [1, 2] });
  });

  it('reads hand-written boards: other list markers, no checkbox, other heading levels, no settings', () => {
    const b = parseBoard('---\nkanban-plugin: basic\n---\n# Ideas\n* first\n+ [x] second\n- [ ]\n### Later\n');
    expect(b.head).toBe('---\nkanban-plugin: basic\n---\n\n');
    expect(b.lanes.map((l) => l.title)).toEqual(['Ideas', 'Later']);
    expect(b.lanes[0].cards).toEqual([
      { check: ' ', text: 'first' },
      { check: 'x', text: 'second' },
      { check: ' ', text: '' },
    ]);
    expect(serializeBoard(b)).toBe('---\nkanban-plugin: basic\n---\n\n## Ideas\n\n- [ ] first\n- [x] second\n- [ ] \n\n\n## Later\n');
  });

  it('keeps text before the first lane', () => {
    const b = parseBoard('---\nkanban-plugin: basic\n---\nA board for the move.\n\n## A\n- [ ] x\n');
    expect(b.head).toBe('---\nkanban-plugin: basic\n---\nA board for the move.\n\n');
    expect(b.problems).toEqual([]);
  });

  it('reports lines the board cannot hold (with their file line), never dropping them silently', () => {
    const b = parseBoard('---\nkanban-plugin: basic\n---\n## A\n- [ ] x\n\nA stray paragraph\n***\n## B\n');
    expect(b.problems).toEqual([7, 8]);
  });

  it('keeps indented lines, sub-lists and loose blank lines inside a card', () => {
    const b = parseBoard('## A\n- [ ] Parent\n  - child\n\n    more\n- [ ] Next\n');
    expect(b.lanes[0].cards.map((c) => c.text)).toEqual(['Parent\n  - child\n\nmore', 'Next']);
  });

  it('does not take headings inside code blocks for lanes', () => {
    const b = parseBoard('## A\n- [ ] x\n```\n## not a lane\n```\n');
    expect(b.lanes).toHaveLength(1);
    expect(b.problems.length).toBeGreaterThan(0);
  });

  it('takes an Archive heading without a break before it for a lane', () => {
    const b = parseBoard('## Archive\n- [ ] x\n');
    expect(b.lanes.map((l) => l.title)).toEqual(['Archive']);
    expect(b.archive).toEqual([]);
  });
});

describe('lane titles', () => {
  it('parses and writes the card limit and line breaks as the plugin does', () => {
    expect(parseLaneTitle('Doing (3)')).toEqual({ title: 'Doing', maxItems: 3 });
    expect(parseLaneTitle('Doing(3)')).toEqual({ title: 'Doing', maxItems: 3 });
    expect(parseLaneTitle('Q (3) review')).toEqual({ title: 'Q (3) review', maxItems: 0 });
    expect(laneHeading({ title: 'Doing', maxItems: 3 })).toBe('## Doing (3)');
    expect(laneHeading({ title: 'Two\nlines', maxItems: 0 })).toBe('## Two<br>lines');
  });
});

describe('cards', () => {
  it('writes continuation lines indented by four spaces', () => {
    expect(cardToMd({ check: ' ', text: 'a\nb\n  c' })).toBe('- [ ] a\n    b\n      c');
  });

  it('reads dates, times and block ids for display', () => {
    expect(cardMeta('Call @{2026-10-21} @@{14:30} [[Bob]] ^x1')).toEqual({ body: 'Call [[Bob]]', date: '2026-10-21', time: '14:30', blockId: 'x1' });
    expect(cardMeta('Mail @[[2026-10-21]]').date).toBeNull();
    expect(cardMeta('Due !{2026-01-02}', { 'date-trigger': '!' }).date).toBe('2026-01-02');
    expect(cardMeta('email@{x}').date).toBeNull();
  });
});

describe('newBoardText', () => {
  it('is a plugin board with three lanes, the last one complete', () => {
    const text = newBoardText();
    expect(isKanbanText(text)).toBe(true);
    const b = parseBoard(text);
    expect(b.lanes.map((l) => [l.title, l.complete])).toEqual([
      ['To do', false],
      ['Doing', false],
      ['Done', true],
    ]);
    expect(serializeBoard(b)).toBe(text);
    expect(text.endsWith('%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%')).toBe(true);
  });
});
