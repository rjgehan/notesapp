import { describe, expect, it } from 'vitest';
import { parseBoard, serializeBoard } from './format';
import {
  addCard,
  addLane,
  archiveCard,
  archiveLane,
  boardItems,
  deleteArchived,
  deleteCard,
  deleteLane,
  duplicateCard,
  editCard,
  findCard,
  insertsAtTop,
  moveCard,
  moveLane,
  renameLane,
  restoreCard,
  setLaneComplete,
  toggleCard,
} from './ops';

const board = parseBoard(['## To do', '', '- [ ] a', '- [ ] b', '', '', '## Done', '', '**Complete**', '- [x] c', '', '', ''].join('\n'));
const texts = (b: typeof board) => b.lanes.map((l) => l.cards.map((c) => `${c.check}${c.text}`));

describe('moveCard', () => {
  it('reorders within a lane', () => {
    expect(texts(moveCard(board, { lane: 0, index: 0 }, { lane: 0, index: 1 }))[0]).toEqual([' b', ' a']);
  });

  it('checks a card moved into a complete lane and unchecks it moved out', () => {
    const done = moveCard(board, { lane: 0, index: 1 }, { lane: 1, index: 0 });
    expect(texts(done)).toEqual([[' a'], ['xb', 'xc']]);
    const back = moveCard(done, { lane: 1, index: 1 }, { lane: 0, index: 0 });
    expect(texts(back)).toEqual([[' c', ' a'], ['xb']]);
  });

  it('ignores stale positions and never changes its input', () => {
    expect(moveCard(board, { lane: 0, index: 9 }, { lane: 1, index: 0 })).toBe(board);
    moveCard(board, { lane: 0, index: 0 }, { lane: 1, index: 0 });
    expect(texts(board)).toEqual([[' a', ' b'], ['xc']]);
  });
});

describe('cards', () => {
  it('adds at the end, or the top, checked in a complete lane', () => {
    expect(texts(addCard(board, 0, ' new '))[0]).toEqual([' a', ' b', ' new']);
    expect(texts(addCard(board, 0, 'new', true))[0]).toEqual([' new', ' a', ' b']);
    expect(texts(addCard(board, 1, 'new'))[1]).toEqual(['xc', 'xnew']);
    expect(insertsAtTop({ 'new-card-insertion-method': 'prepend-compact' })).toBe(true);
    expect(insertsAtTop({})).toBe(false);
  });

  it('edits, toggles, duplicates (without the block id) and deletes', () => {
    expect(texts(editCard(board, { lane: 0, index: 0 }, 'A\nmore'))[0]).toEqual([' A\nmore', ' b']);
    expect(editCard(board, { lane: 0, index: 0 }, 'a')).toBe(board);
    expect(texts(toggleCard(board, { lane: 0, index: 1 }))[0]).toEqual([' a', 'xb']);
    const withId = editCard(board, { lane: 0, index: 0 }, 'a ^id1\nline');
    expect(texts(duplicateCard(withId, { lane: 0, index: 0 }))[0]).toEqual([' a ^id1\nline', ' a\nline', ' b']);
    expect(texts(deleteCard(board, { lane: 0, index: 0 }))[0]).toEqual([' b']);
  });

  it('archives, restores and deletes archived cards, writing the archive section', () => {
    const archived = archiveCard(board, { lane: 0, index: 0 });
    expect(texts(archived)[0]).toEqual([' b']);
    expect(serializeBoard(archived)).toContain('\n***\n\n## Archive\n\n- [ ] a');
    const all = archiveLane(archived, 1);
    expect(all.archive.map((c) => c.text)).toEqual(['a', 'c']);
    expect(texts(restoreCard(all, 1, 0))[0]).toEqual([' b', 'xc']);
    expect(deleteArchived(all, 0).archive.map((c) => c.text)).toEqual(['c']);
  });

  it('finds a card again after other edits', () => {
    const changed = addCard(board, 0, 'z', true);
    expect(findCard(changed, { lane: 0, index: 0 }, 'a')).toEqual({ lane: 0, index: 1 });
    expect(findCard(changed, { lane: 0, index: 0 }, 'c')).toEqual({ lane: 1, index: 0 });
    expect(findCard(changed, { lane: 0, index: 0 }, 'gone')).toBeNull();
  });
});

describe('lanes', () => {
  it('adds, renames (with a limit), moves and deletes lanes', () => {
    const added = addLane(board, 'Later');
    expect(added.lanes.map((l) => l.title)).toEqual(['To do', 'Done', 'Later']);
    expect(serializeBoard(renameLane(board, 0, 'Next', 3))).toContain('## Next (3)\n');
    expect(moveLane(added, 2, 0).lanes.map((l) => l.title)).toEqual(['Later', 'To do', 'Done']);
    expect(moveLane(added, 0, -1)).toBe(added);
    expect(deleteLane(added, 1).lanes.map((l) => l.title)).toEqual(['To do', 'Later']);
  });

  it('marking a lane complete checks its cards; unmarking leaves them', () => {
    const on = setLaneComplete(board, 0, true);
    expect(texts(on)[0]).toEqual(['xa', 'xb']);
    expect(serializeBoard(on)).toContain('## To do\n\n**Complete**\n- [x] a');
    expect(texts(setLaneComplete(on, 0, false))[0]).toEqual(['xa', 'xb']);
  });
});

describe('boardItems', () => {
  it('keys cards by their text, so a moved card keeps its key, and equal cards differ', () => {
    const twins = addCard(board, 1, 'a');
    const before = boardItems(twins);
    expect(new Set(before.flat().map((i) => i.key)).size).toBe(4);
    const moved = boardItems(moveCard(twins, { lane: 0, index: 1 }, { lane: 1, index: 0 }));
    expect(moved[1][0].key).toBe(before[0][1].key);
    expect(moved[1][0]).toMatchObject({ lane: 1, index: 0 });
  });
});
