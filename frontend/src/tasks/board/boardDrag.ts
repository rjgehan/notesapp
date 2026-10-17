// Where a dragged card lands on a board, and the keyboard's single-step moves. Pure, so it is
// tested without a DOM; the Board component measures and calls these. A board is columns of cards
// (ROADMAP items 4 and 15): a move names the card, its column, the target column and the index the
// card takes there among the other cards (the dragged card itself left out).

export interface BoardMove {
  itemKey: string;
  from: string;
  to: string;
  /** The card's index in the target column, counted without the card itself. */
  index: number;
}

export interface ColumnLayout {
  id: string;
  left: number;
  right: number;
  /** The vertical middles of the column's cards, in order, the dragged card left out. */
  mids: number[];
  /** Cards cannot be dropped here. */
  locked?: boolean;
}

/** The column under (or nearest to) `x`, or null when every column is locked. */
export function columnAt(columns: readonly ColumnLayout[], x: number): ColumnLayout | null {
  let best: ColumnLayout | null = null;
  let bestDistance = Infinity;
  for (const c of columns) {
    if (c.locked) continue;
    const distance = x < c.left ? c.left - x : x > c.right ? x - c.right : 0;
    if (distance < bestDistance) {
      best = c;
      bestDistance = distance;
    }
  }
  return best;
}

/** The index under a pointer at `y`: before the first card whose middle is below it. */
export function indexAt(mids: readonly number[], y: number): number {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}

/** Where a card dragged to (x, y) lands, or null when it cannot land anywhere. */
export function dropAt(columns: readonly ColumnLayout[], x: number, y: number): { column: string; index: number } | null {
  const column = columnAt(columns, x);
  return column ? { column: column.id, index: indexAt(column.mids, y) } : null;
}

/** A drop that leaves the card where it is (same column, same place) changes nothing. */
export function isNoop(columns: ReadonlyArray<{ id: string; keys: readonly string[] }>, move: BoardMove): boolean {
  if (move.from !== move.to) return false;
  const keys = columns.find((c) => c.id === move.from)?.keys ?? [];
  return keys.indexOf(move.itemKey) === move.index;
}

/**
 * Alt+arrow on a focused card: up and down within its column, left and right into the next
 * column that accepts cards, at the same height (or last). Null at an edge.
 */
export function keyboardMove(
  columns: ReadonlyArray<{ id: string; keys: readonly string[]; locked?: boolean }>,
  itemKey: string,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
): BoardMove | null {
  const from = columns.findIndex((c) => c.keys.includes(itemKey));
  if (from < 0) return null;
  const column = columns[from];
  const at = column.keys.indexOf(itemKey);
  if (key === 'ArrowUp') return at > 0 ? { itemKey, from: column.id, to: column.id, index: at - 1 } : null;
  if (key === 'ArrowDown') return at < column.keys.length - 1 ? { itemKey, from: column.id, to: column.id, index: at + 1 } : null;
  const step = key === 'ArrowLeft' ? -1 : 1;
  for (let i = from + step; i >= 0 && i < columns.length; i += step) {
    if (columns[i].locked) continue;
    return { itemKey, from: column.id, to: columns[i].id, index: Math.min(at, columns[i].keys.length) };
  }
  return null;
}
