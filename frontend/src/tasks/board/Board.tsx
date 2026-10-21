// A board: columns of cards that drag between and within columns (ROADMAP item 4's Kanban view,
// and the base of item 15's boards). Generic: the caller gives the columns, renders the cards and
// turns a move into writes; the board only does layout, dragging and keyboard moves.
//
// Dragging uses pointer events, as the list page does: a card's handle starts a drag with any
// pointer (it has `touch-action: none`, so a finger drags it instead of scrolling), and a mouse can
// also drag the card itself once it has moved a few pixels (a click still opens it). The dragged
// card follows the pointer; a line shows where it lands. Near the board's sides it scrolls
// sideways, near the workspace's top and bottom up and down; Esc cancels. The keyboard does the
// same in single steps: Alt+↑/↓ within a column, Alt+←/→ to the next column.
import { GripVertical } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useWorkspaceScroller } from '../../components/layout/workspaceScroller';
import { dropAt, isNoop, keyboardMove, type BoardMove, type ColumnLayout } from './boardDrag';

export type { BoardMove } from './boardDrag';

export interface BoardColumn<T> {
  id: string;
  title: string;
  items: readonly T[];
  /** Cards cannot be dropped here (for example a column sorted by completion time). */
  locked?: boolean;
  /** A color for the column's top edge. */
  accent?: string | null;
  /** Shown next to the title: a menu button, an add button. */
  actions?: ReactNode;
  /** Shown below the cards (an add button). */
  footer?: ReactNode;
  /** Shown instead of the cards when there are none. */
  empty?: ReactNode;
}

export interface BoardProps<T> {
  label: string;
  columns: ReadonlyArray<BoardColumn<T>>;
  itemKey(item: T): string;
  /** A card's name, for its handle's label. */
  itemLabel(item: T): string;
  renderCard(item: T): ReactNode;
  onMove(move: BoardMove): void;
  /** Enter on a focused card. */
  onOpen?(item: T): void;
  /** Cards that cannot move (a placeholder being created, a read-only list). */
  canDrag?(item: T): boolean;
  /** After the columns: an "Add section" column, for example. */
  trailing?: ReactNode;
}

interface DragState {
  key: string;
  from: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  pointerId: number;
  /** A mouse press on the card's body becomes a drag only after it moves a few pixels. */
  started: boolean;
  target: { column: string; index: number } | null;
}

interface DropLine {
  column: string;
  top: number;
}

const DRAG_THRESHOLD_PX = 5;
const EDGE_PX = 48;
const SCROLL_STEP_PX = 14;
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"]';

export function Board<T>({ label, columns, itemKey, itemLabel, renderCard, onMove, onOpen, canDrag = () => true, trailing }: BoardProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const workspace = useWorkspaceScroller();
  const drag = useRef<DragState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const [line, setLine] = useState<DropLine | null>(null);
  const keyed = columns.map((c) => ({ id: c.id, keys: c.items.map(itemKey), locked: c.locked }));

  const stopScrolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  /** Measures the columns now (they scroll while dragging), without the dragged card. */
  const layouts = (dragKey: string): Array<ColumnLayout & { tops: number[]; bottoms: number[]; listTop: number }> => {
    const root = scroller.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('[data-board-column]')].map((col) => {
      const rect = col.getBoundingClientRect();
      const list = col.querySelector<HTMLElement>('.board-cards');
      const cards = [...col.querySelectorAll<HTMLElement>('[data-board-card]')].filter((c) => c.dataset.boardCard !== dragKey);
      const rects = cards.map((c) => c.getBoundingClientRect());
      return {
        id: col.dataset.boardColumn ?? '',
        left: rect.left,
        right: rect.right,
        locked: col.dataset.locked === 'true',
        mids: rects.map((r) => (r.top + r.bottom) / 2),
        tops: rects.map((r) => r.top),
        bottoms: rects.map((r) => r.bottom),
        listTop: list?.getBoundingClientRect().top ?? rect.top,
      };
    });
  };

  const track = () => {
    const d = drag.current;
    if (!d || !d.started) return;
    const all = layouts(d.key);
    const target = dropAt(all, d.x, d.y);
    d.target = target;
    setDragging({ key: d.key, dx: d.x - d.startX, dy: d.y - d.startY });
    if (!target) {
      setLine(null);
      return;
    }
    const col = all.find((c) => c.id === target.column)!;
    const y = target.index < col.tops.length ? col.tops[target.index] - 4 : col.bottoms.length > 0 ? col.bottoms[col.bottoms.length - 1] + 4 : col.listTop + 4;
    setLine({ column: target.column, top: y - col.listTop });
  };

  const autoScroll = () => {
    const d = drag.current;
    const board = scroller.current;
    if (!d || !board) return stopScrolling();
    const rect = board.getBoundingClientRect();
    const dx = d.x < rect.left + EDGE_PX ? -SCROLL_STEP_PX : d.x > rect.right - EDGE_PX ? SCROLL_STEP_PX : 0;
    const page = workspace.current;
    const pageRect = page?.getBoundingClientRect();
    const dy = pageRect ? (d.y < pageRect.top + EDGE_PX ? -SCROLL_STEP_PX : d.y > pageRect.bottom - EDGE_PX ? SCROLL_STEP_PX : 0) : 0;
    if (dx === 0 && dy === 0) return stopScrolling();
    if (dx !== 0) board.scrollBy?.({ left: dx });
    if (dy !== 0) page?.scrollBy?.({ top: dy });
    track();
  };

  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    stopScrolling();
    setDragging(null);
    setLine(null);
    if (!d || !d.started) return;
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    if (!commit || !d.target) return;
    const move: BoardMove = { itemKey: d.key, from: d.from, to: d.target.column, index: d.target.index };
    if (!isNoop(keyed, move)) onMove(move);
  };

  const begin = (e: PointerEvent<HTMLElement>, key: string, from: string, started: boolean) => {
    drag.current = { key, from, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, pointerId: e.pointerId, started, target: null };
    // A press on the card's body captures the pointer only once it drags: a captured pointer's
    // click would go to the card, not to the title or button under it.
    if (started) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      track();
    }
  };

  const pointer = {
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      // The button came up outside the card before it captured the pointer: no drag.
      if (e.pointerType === 'mouse' && e.buttons === 0) return end(false);
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.started) {
        if (Math.hypot(d.x - d.startX, d.y - d.startY) < DRAG_THRESHOLD_PX) return;
        d.started = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      track();
      if (!timer.current) timer.current = setInterval(autoScroll, 16);
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
  };

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => stopScrolling, []);

  const focusCard = (key: string) => {
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-board-card="${CSS.escape(key)}"]`)?.focus());
  };

  const onCardKey = (e: KeyboardEvent<HTMLElement>, item: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' && onOpen) {
      e.preventDefault();
      onOpen(item);
      return;
    }
    if (!e.altKey || !canDrag(item)) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const key = itemKey(item);
    const move = keyboardMove(keyed, key, e.key);
    e.preventDefault();
    if (!move) return;
    onMove(move);
    focusCard(key);
  };

  return (
    <div className={`board${dragging ? ' is-dragging' : ''}`} role="region" aria-label={label}>
      <div ref={scroller} className="board-columns">
        {columns.map((column) => (
          <section
            key={column.id}
            className={`board-column${line?.column === column.id ? ' is-target' : ''}`}
            data-board-column={column.id}
            data-locked={column.locked ? 'true' : undefined}
            aria-label={column.title}
            style={column.accent ? { borderTopColor: column.accent } : undefined}
          >
            <header className="board-column-head">
              <h2 className="board-column-title">
                <span className="board-column-name">{column.title}</span>
                <span className="tasks-count">{column.items.length}</span>
              </h2>
              {column.actions}
            </header>
            <ul className="board-cards">
              {column.items.map((item) => {
                const key = itemKey(item);
                const movable = canDrag(item);
                const isDragged = dragging?.key === key;
                return (
                  <li
                    key={key}
                    className={`board-card${isDragged ? ' is-dragging' : ''}`}
                    data-board-card={key}
                    tabIndex={0}
                    style={isDragged ? { transform: `translate(${dragging.dx}px, ${dragging.dy}px)` } : undefined}
                    onKeyDown={(e) => onCardKey(e, item)}
                    onClickCapture={(e) => {
                      if (!suppressClick.current) return;
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPointerDown={(e) => {
                      // A mouse can drag the card itself; touch drags by the handle, so the board scrolls.
                      if (!movable || e.button !== 0 || e.pointerType !== 'mouse' || (e.target as HTMLElement).closest(INTERACTIVE)) return;
                      begin(e, key, column.id, false);
                    }}
                    {...pointer}
                  >
                    {movable && (
                      <span
                        className="board-card-handle"
                        aria-hidden
                        title={`Drag “${itemLabel(item)}” (or Alt+arrow keys)`}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.stopPropagation();
                          begin(e, key, column.id, true);
                        }}
                      >
                        <GripVertical size={15} aria-hidden />
                      </span>
                    )}
                    <div className="board-card-body">{renderCard(item)}</div>
                  </li>
                );
              })}
              {column.items.length === 0 && column.empty && <li className="board-empty">{column.empty}</li>}
              {line?.column === column.id && <li className="board-drop-line" style={{ top: line.top }} aria-hidden />}
            </ul>
            {column.footer}
          </section>
        ))}
        {trailing}
      </div>
    </div>
  );
}
