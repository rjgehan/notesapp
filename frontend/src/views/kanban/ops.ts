// Edits of a Kanban board (ROADMAP item 15, DESIGN §6.8.4), as the Obsidian Kanban plugin makes
// them. Pure: each takes a board and returns a new one (the input is never changed), or the same
// board when the edit does not apply (a stale position).
import type { KanbanBoard, KanbanCard, KanbanLane } from './format';

export interface CardRef {
  lane: number;
  index: number;
}

function cardAt(board: KanbanBoard, ref: CardRef): KanbanCard | undefined {
  return board.lanes[ref.lane]?.cards[ref.index];
}

function withLanes(board: KanbanBoard, lanes: KanbanLane[]): KanbanBoard {
  return { ...board, lanes };
}

function replaceLane(board: KanbanBoard, index: number, fn: (lane: KanbanLane) => KanbanLane): KanbanBoard {
  if (!board.lanes[index]) return board;
  return withLanes(
    board,
    board.lanes.map((l, i) => (i === index ? fn(l) : l)),
  );
}

const isChecked = (check: string) => check !== ' ';

/**
 * Moves a card to `to.index` among the target lane's other cards. Into a lane marked
 * `**Complete**` the card is checked; out of one into a lane that is not, unchecked (the plugin).
 */
export function moveCard(board: KanbanBoard, from: CardRef, to: CardRef): KanbanBoard {
  const card = cardAt(board, from);
  const target = board.lanes[to.lane];
  if (!card || !target) return board;
  const source = board.lanes[from.lane];
  let moved = card;
  if (from.lane !== to.lane) {
    if (target.complete && !isChecked(card.check)) moved = { ...card, check: 'x' };
    else if (!target.complete && source.complete && isChecked(card.check)) moved = { ...card, check: ' ' };
  }
  const lanes = board.lanes.map((l) => ({ ...l, cards: [...l.cards] }));
  lanes[from.lane].cards.splice(from.index, 1);
  const dest = lanes[to.lane].cards;
  dest.splice(Math.max(0, Math.min(to.index, dest.length)), 0, moved);
  return withLanes(board, lanes);
}

/** Where new cards go: the plugin's `new-card-insertion-method` ('prepend…' or 'append'). */
export function insertsAtTop(settings: Record<string, unknown>): boolean {
  const method = settings['new-card-insertion-method'];
  return typeof method === 'string' && method.startsWith('prepend');
}

export function addCard(board: KanbanBoard, lane: number, text: string, top = false): KanbanBoard {
  const target = board.lanes[lane];
  if (!target) return board;
  const card: KanbanCard = { text: text.trim(), check: target.complete ? 'x' : ' ' };
  return replaceLane(board, lane, (l) => ({ ...l, cards: top ? [card, ...l.cards] : [...l.cards, card] }));
}

export function editCard(board: KanbanBoard, ref: CardRef, text: string): KanbanBoard {
  const card = cardAt(board, ref);
  if (!card || card.text === text.trim()) return board;
  return replaceLane(board, ref.lane, (l) => ({ ...l, cards: l.cards.map((c, i) => (i === ref.index ? { ...c, text: text.trim() } : c)) }));
}

export function toggleCard(board: KanbanBoard, ref: CardRef): KanbanBoard {
  const card = cardAt(board, ref);
  if (!card) return board;
  return replaceLane(board, ref.lane, (l) => ({ ...l, cards: l.cards.map((c, i) => (i === ref.index ? { ...c, check: isChecked(c.check) ? ' ' : 'x' } : c)) }));
}

export function deleteCard(board: KanbanBoard, ref: CardRef): KanbanBoard {
  if (!cardAt(board, ref)) return board;
  return replaceLane(board, ref.lane, (l) => ({ ...l, cards: l.cards.filter((_, i) => i !== ref.index) }));
}

export function duplicateCard(board: KanbanBoard, ref: CardRef): KanbanBoard {
  const card = cardAt(board, ref);
  if (!card) return board;
  // A block id names one card: the copy goes without it.
  const copy = { ...card, text: card.text.replace(/^([^\n]*?)\s+\^[a-zA-Z0-9-]+(?=\n|$)/, '$1') };
  return replaceLane(board, ref.lane, (l) => ({ ...l, cards: [...l.cards.slice(0, ref.index + 1), copy, ...l.cards.slice(ref.index + 1)] }));
}

/** Archives a card: it goes to the end of the archive section (created when missing). */
export function archiveCard(board: KanbanBoard, ref: CardRef): KanbanBoard {
  const card = cardAt(board, ref);
  if (!card) return board;
  return { ...deleteCard(board, ref), archive: [...board.archive, card] };
}

/** Archives every card of a lane, in order. */
export function archiveLane(board: KanbanBoard, lane: number): KanbanBoard {
  const target = board.lanes[lane];
  if (!target || target.cards.length === 0) return board;
  return { ...replaceLane(board, lane, (l) => ({ ...l, cards: [] })), archive: [...board.archive, ...target.cards] };
}

/** Puts an archived card back at the end of a lane. */
export function restoreCard(board: KanbanBoard, index: number, lane: number): KanbanBoard {
  const card = board.archive[index];
  if (!card || !board.lanes[lane]) return board;
  const restored = replaceLane(board, lane, (l) => ({ ...l, cards: [...l.cards, card] }));
  return { ...restored, archive: board.archive.filter((_, i) => i !== index) };
}

export function deleteArchived(board: KanbanBoard, index: number): KanbanBoard {
  if (!board.archive[index]) return board;
  return { ...board, archive: board.archive.filter((_, i) => i !== index) };
}

export function addLane(board: KanbanBoard, title: string): KanbanBoard {
  return withLanes(board, [...board.lanes, { title: title.trim(), maxItems: 0, complete: false, cards: [] }]);
}

/** Renames a lane; `Title (N)` sets the card limit, as typing it in the plugin does. */
export function renameLane(board: KanbanBoard, lane: number, title: string, maxItems?: number): KanbanBoard {
  return replaceLane(board, lane, (l) => ({ ...l, title: title.trim().replace(/\n/g, '<br>'), maxItems: maxItems ?? l.maxItems }));
}

export function moveLane(board: KanbanBoard, from: number, to: number): KanbanBoard {
  if (!board.lanes[from] || to < 0 || to >= board.lanes.length || from === to) return board;
  const lanes = [...board.lanes];
  const [lane] = lanes.splice(from, 1);
  lanes.splice(to, 0, lane);
  return withLanes(board, lanes);
}

export function deleteLane(board: KanbanBoard, lane: number): KanbanBoard {
  if (!board.lanes[lane]) return board;
  return withLanes(
    board,
    board.lanes.filter((_, i) => i !== lane),
  );
}

/** Marks a lane `**Complete**` (its cards are checked) or not (they are left as they are). */
export function setLaneComplete(board: KanbanBoard, lane: number, complete: boolean): KanbanBoard {
  return replaceLane(board, lane, (l) => ({ ...l, complete, cards: complete ? l.cards.map((c) => (isChecked(c.check) ? c : { ...c, check: 'x' })) : l.cards }));
}

/**
 * Finds a card again after the text changed under an open editor: at its old place when it is
 * still the same card there, else the first card of that lane with the same text, else anywhere.
 */
export function findCard(board: KanbanBoard, ref: CardRef, text: string): CardRef | null {
  if (cardAt(board, ref)?.text === text) return ref;
  const lane = board.lanes[ref.lane];
  const inLane = lane ? lane.cards.findIndex((c) => c.text === text) : -1;
  if (inLane >= 0) return { lane: ref.lane, index: inLane };
  for (let l = 0; l < board.lanes.length; l++) {
    const i = board.lanes[l].cards.findIndex((c) => c.text === text);
    if (i >= 0) return { lane: l, index: i };
  }
  return null;
}

// ---------- keys for the view ----------

export interface BoardItem extends CardRef {
  key: string;
  card: KanbanCard;
}

/** A short, stable hash of a card's text: its key survives moves, so focus and the drag follow it. */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The board's cards with keys made of their text's hash and its occurrence (two equal cards differ). */
export function boardItems(board: KanbanBoard): BoardItem[][] {
  const seen = new Map<string, number>();
  return board.lanes.map((lane, l) =>
    lane.cards.map((card, index) => {
      const h = hashText(card.text);
      const n = seen.get(h) ?? 0;
      seen.set(h, n + 1);
      return { key: `${h}.${n}`, lane: l, index, card };
    }),
  );
}
