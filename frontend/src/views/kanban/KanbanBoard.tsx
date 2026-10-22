// A note in the Obsidian Kanban plugin's format, shown as a board (ROADMAP item 15, DESIGN §6.8.4).
// The lanes are the generic Board's columns (item 4's board), the cards its items. The board is
// read from the note's text on every change and every edit is written back as text through the
// note's DocumentSession, so autosave, drafts, history, conflicts and live sync are the note's
// own, and links in cards are ordinary links of the note (backlinks, search, moves).
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Ellipsis,
  FileText,
  ListPlus,
  Pencil,
  Plus,
  SquareSplitVertical,
  Trash2,
} from 'lucide-react';
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';
import { MarkdownSnippet } from '../../render/MarkdownSnippet';
import { confirmAction, promptText } from '../../state/dialogs';
import type { DocumentSession } from '../../sync/DocumentSession';
import { useSessionChangeCount } from '../../sync/useTextDocument';
import { Board, type BoardColumn, type BoardMove } from '../../tasks/board/Board';
import { CardEditor } from '../canvas/CardEditor';
import { cardMeta, laneHeading, laneTitleText, parseBoard, parseLaneTitle, serializeBoard, type KanbanBoard as Model } from './format';
import {
  addCard,
  addLane,
  archiveCard,
  archiveLane,
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
  boardItems,
  hashText,
  type BoardItem as Item,
  type CardRef,
} from './ops';
import './kanban.css';

interface Props {
  session: DocumentSession;
  readOnly: boolean;
  onShowMarkdown(): void;
}

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
}

const laneId = (lane: number) => `lane:${lane}`;
const laneOf = (id: string) => Number(id.slice(5));

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CardView({ item, path, settings, editable, onToggle, onEdit, onMenu }: {
  item: Item;
  path: string;
  settings: Record<string, unknown>;
  editable: boolean;
  onToggle(): void;
  onEdit(): void;
  onMenu(e: MouseEvent): void;
}) {
  const meta = cardMeta(item.card.text, settings);
  const done = item.card.check !== ' ';
  const showCheckbox = settings['show-checkboxes'] === true;
  const overdue = meta.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) && meta.date < todayIso() && !done;
  return (
    <div className={`kanban-card${done ? ' is-done' : ''}`}>
      {showCheckbox && (
        <input
          type="checkbox"
          className="kanban-card-check task-list-item-checkbox"
          checked={done}
          disabled={!editable}
          aria-label={done ? 'Mark as not done' : 'Mark as done'}
          onChange={onToggle}
        />
      )}
      <div
        className="kanban-card-main"
        onClick={(e) => {
          if (!editable || (e.target as HTMLElement).closest('a, button, input, audio, video, iframe')) return;
          onEdit();
        }}
      >
        {meta.body === '' && meta.date === null && meta.time === null ? (
          <span className="kanban-card-empty muted">Empty card</span>
        ) : (
          <MarkdownSnippet markdown={meta.body} path={path} className="kanban-card-text" />
        )}
        {(meta.date !== null || meta.time !== null || (done && !showCheckbox)) && (
          <span className="kanban-card-meta">
            {done && !showCheckbox && (
              <span className="kanban-chip is-done" title="Done">
                <Check size={12} aria-hidden /> Done
              </span>
            )}
            {meta.date !== null && (
              <span className={`kanban-chip${overdue ? ' is-overdue' : ''}`} title={overdue ? 'Overdue' : 'Date'}>
                <CalendarDays size={12} aria-hidden /> {meta.date}
              </span>
            )}
            {meta.time !== null && (
              <span className="kanban-chip" title="Time">
                <Clock size={12} aria-hidden /> {meta.time}
              </span>
            )}
          </span>
        )}
      </div>
      <button type="button" className="icon-button kanban-card-more" aria-label="Card actions" title="More" aria-haspopup="menu" onClick={onMenu}>
        <Ellipsis size={16} />
      </button>
    </div>
  );
}

export default function KanbanBoard({ session, readOnly, onShowMarkdown }: Props) {
  useSessionChangeCount(session);
  const text = session.getText();
  const board = useMemo(() => parseBoard(text), [text]);
  const items = useMemo(() => boardItems(board), [board]);
  const editable = !readOnly && board.problems.length === 0;
  const path = session.path;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<{ key: string; ref: CardRef; original: string } | null>(null);
  const [adding, setAdding] = useState<{ lane: number; seq: number } | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const draft = useRef('');

  /** Applies an edit to the note's current text (which may be newer than this render's). */
  const write = (fn: (b: Model) => Model) => {
    if (!editable) return;
    const current = parseBoard(session.getText());
    if (current.problems.length > 0) return;
    const next = fn(current);
    if (next !== current) session.setText(serializeBoard(next));
  };

  // The open editors, also as refs: an editor's Enter, Esc and blur can all end it, and only the
  // first of them (for the editor that is still the current one) commits.
  const editingNow = useRef<typeof editing>(null);
  const addingNow = useRef<typeof adding>(null);

  const startEdit = (item: Item) => {
    if (!editable) return;
    commitAdd(false);
    draft.current = item.card.text;
    editingNow.current = { key: item.key, ref: { lane: item.lane, index: item.index }, original: item.card.text };
    setEditing(editingNow.current);
  };

  function finishEdit() {
    const e = editingNow.current;
    if (!e) return;
    editingNow.current = null;
    setEditing(null);
    const value = draft.current;
    if (value.trim() === e.original.trim()) return;
    write((b) => {
      const at = findCard(b, e.ref, e.original);
      // The card went away while it was being edited (another device): the text is kept as a new card.
      if (!at) return b.lanes[e.ref.lane] ? addCard(b, e.ref.lane, value) : b;
      return editCard(b, at, value);
    });
  }

  function commitAdd(keepOpen: boolean, seq?: number) {
    const a = addingNow.current;
    if (!a || (seq !== undefined && seq !== a.seq)) return;
    const value = draft.current.trim();
    draft.current = '';
    if (value !== '') write((b) => addCard(b, a.lane, value, insertsAtTop(b.settings)));
    addingNow.current = keepOpen && value !== '' ? { lane: a.lane, seq: a.seq + 1 } : null;
    setAdding(addingNow.current);
  }

  const startAdd = (lane: number) => {
    if (!editable) return;
    finishEdit();
    commitAdd(false);
    draft.current = '';
    addingNow.current = { lane, seq: (adding?.seq ?? 0) + 1 };
    setAdding(addingNow.current);
  };

  const onMove = (move: BoardMove) => {
    const fromLane = laneOf(move.from);
    const index = items[fromLane]?.findIndex((i) => i.key === move.itemKey) ?? -1;
    if (index < 0) return;
    write((b) => moveCard(b, { lane: fromLane, index }, { lane: laneOf(move.to), index: move.index }));
  };

  const at = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 4 };
  };

  const cardMenu = (e: MouseEvent, item: Item) => {
    const ref = { lane: item.lane, index: item.index };
    const done = item.card.check !== ' ';
    const entries: MenuEntry[] = [
      { id: 'edit', label: 'Edit', icon: <Pencil size={16} />, disabled: !editable, run: () => startEdit(item) },
      { id: 'done', label: done ? 'Mark as not done' : 'Mark as done', icon: <Check size={16} />, disabled: !editable, run: () => write((b) => toggleCard(b, ref)) },
    ];
    board.lanes.forEach((lane, l) => {
      if (l === item.lane) return;
      entries.push({
        id: `to-${l}`,
        label: `Move to “${laneTitleText(lane.title)}”`,
        icon: <SquareSplitVertical size={16} />,
        disabled: !editable,
        run: () => write((b) => moveCard(b, ref, { lane: l, index: b.lanes[l]?.cards.length ?? 0 })),
      });
    });
    entries.push(
      'separator',
      { id: 'duplicate', label: 'Duplicate', icon: <Copy size={16} />, disabled: !editable, run: () => write((b) => duplicateCard(b, ref)) },
      { id: 'archive', label: 'Archive', icon: <Archive size={16} />, disabled: !editable, run: () => write((b) => archiveCard(b, ref)) },
      { id: 'delete', label: 'Delete', icon: <Trash2 size={16} />, danger: true, disabled: !editable, run: () => write((b) => deleteCard(b, ref)) },
    );
    setMenu({ ...at(e), label: 'Card actions', items: entries });
  };

  const renameLanePrompt = (lane: number) => {
    const current = board.lanes[lane];
    if (!current) return;
    void promptText({
      title: 'Rename lane',
      label: 'Name (a number in brackets limits the cards, as in “Doing (3)”)',
      value: laneHeading(current).slice(3).replace(/<br>/g, ' '),
      confirmLabel: 'Rename',
      validate: (v) => (v.trim() === '' ? 'A lane needs a name.' : null),
    }).then((value) => {
      if (value === null) return;
      const { title, maxItems } = parseLaneTitle(value);
      write((b) => renameLane(b, lane, title, maxItems));
    });
  };

  const addLanePrompt = () => {
    void promptText({ title: 'Add lane', label: 'Name', value: '', confirmLabel: 'Add', validate: (v) => (v.trim() === '' ? 'A lane needs a name.' : null) }).then((value) => {
      if (value === null) return;
      const { title, maxItems } = parseLaneTitle(value);
      write((b) => renameLane(addLane(b, title), b.lanes.length, title, maxItems));
    });
  };

  const laneMenu = (e: MouseEvent, lane: number) => {
    const current = board.lanes[lane];
    if (!current) return;
    const name = laneTitleText(current.title);
    const entries: MenuEntry[] = [
      { id: 'add', label: 'Add card', icon: <Plus size={16} />, run: () => startAdd(lane) },
      { id: 'rename', label: 'Rename…', icon: <Pencil size={16} />, run: () => renameLanePrompt(lane) },
      { id: 'left', label: 'Move lane left', icon: <ArrowLeft size={16} />, disabled: lane === 0, run: () => write((b) => moveLane(b, lane, lane - 1)) },
      { id: 'right', label: 'Move lane right', icon: <ArrowRight size={16} />, disabled: lane === board.lanes.length - 1, run: () => write((b) => moveLane(b, lane, lane + 1)) },
      {
        id: 'complete',
        label: current.complete ? 'Stop marking cards here as done' : 'Mark cards here as done',
        icon: <CheckCheck size={16} />,
        run: () => write((b) => setLaneComplete(b, lane, !current.complete)),
      },
      'separator',
      { id: 'archive', label: 'Archive all cards', icon: <Archive size={16} />, disabled: current.cards.length === 0, run: () => write((b) => archiveLane(b, lane)) },
      {
        id: 'delete',
        label: 'Delete lane…',
        icon: <Trash2 size={16} />,
        danger: true,
        run: () => {
          const drop = () => write((b) => deleteLane(b, lane));
          if (current.cards.length === 0) return drop();
          void confirmAction({
            title: 'Delete lane',
            message: `“${name}” and its ${current.cards.length === 1 ? 'card' : `${current.cards.length} cards`} will be deleted. The note’s history keeps them.`,
            confirmLabel: 'Delete',
            danger: true,
          }).then((ok) => ok && drop());
        },
      },
    ];
    setMenu({ ...at(e), label: `${name} lane actions`, items: entries.map((m) => (m === 'separator' ? m : { ...m, disabled: m.disabled || !editable })) });
  };

  const columns: Array<BoardColumn<Item>> = board.lanes.map((lane, l) => {
    const name = laneTitleText(lane.title);
    const over = lane.maxItems > 0 && lane.cards.length > lane.maxItems;
    const isAdding = adding?.lane === l;
    return {
      id: laneId(l),
      title: name,
      items: items[l],
      accent: over ? 'var(--text-error)' : lane.complete ? 'var(--text-success)' : null,
      actions: (
        <span className="board-column-actions">
          {lane.maxItems > 0 && (
            <span className={`kanban-limit${over ? ' is-over' : ''}`} title={`At most ${lane.maxItems} cards`}>
              / {lane.maxItems}
            </span>
          )}
          {lane.complete && (
            <span className="kanban-lane-done" title="Cards moved here are marked as done">
              <CheckCheck size={14} aria-label="Marks cards as done" />
            </span>
          )}
          {editable && (
            <button type="button" className="icon-button" aria-label={`Add card to ${name}`} title="Add card" onClick={() => startAdd(l)}>
              <Plus size={16} />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={`More for lane ${name}`} title="More" aria-haspopup="menu" onClick={(e) => laneMenu(e, l)}>
            <Ellipsis size={16} />
          </button>
        </span>
      ),
      footer: !editable ? undefined : isAdding ? (
        <div className="kanban-add-editor">
          <CardEditor
            key={adding.seq}
            text=""
            canvasPath={path}
            className="kanban-card-editor"
            onChange={(v) => (draft.current = v)}
            onEnter={() => commitAdd(true, adding.seq)}
            onDone={() => commitAdd(false, adding.seq)}
            onSave={() => commitAdd(true, adding.seq)}
            onBlur={() => commitAdd(false, adding.seq)}
          />
        </div>
      ) : (
        <button type="button" className="board-add" onClick={() => startAdd(l)}>
          <Plus size={14} aria-hidden /> Add card
        </button>
      ),
      empty: isAdding ? undefined : <span className="muted">No cards</span>,
    };
  });

  return (
    <div className="kanban-view">
      <div className="kanban-toolbar">
        {editable && (
          <button type="button" className="button button-small" onClick={addLanePrompt}>
            <ListPlus size={14} aria-hidden /> Add lane
          </button>
        )}
        <button type="button" className={`button button-small${showArchive ? ' is-active' : ''}`} aria-pressed={showArchive} onClick={() => setShowArchive((v) => !v)}>
          <Archive size={14} aria-hidden /> Archive{board.archive.length > 0 ? ` (${board.archive.length})` : ''}
        </button>
        <button type="button" className="button button-small" onClick={onShowMarkdown} title="Show this board as Markdown text">
          <FileText size={14} aria-hidden /> Open as Markdown
        </button>
      </div>
      {board.problems.length > 0 && !readOnly && (
        <p className="note-warning kanban-warning" role="note">
          {board.problems.length === 1 ? `Line ${board.problems[0]} is` : `Lines ${board.problems.slice(0, 5).join(', ')}${board.problems.length > 5 ? '…' : ''} are`} not part of a card or a lane, so the board is shown
          without editing (editing would drop {board.problems.length === 1 ? 'it' : 'them'}). Open it as Markdown to move {board.problems.length === 1 ? 'it' : 'them'} into a card.
        </p>
      )}
      {showArchive && (
        <section className="kanban-archive" aria-label="Archived cards">
          <h2 className="kanban-archive-title">Archived cards</h2>
          {board.archive.length === 0 ? (
            <p className="muted">No archived cards. A card’s menu archives it.</p>
          ) : (
            <ul className="kanban-archive-list">
              {board.archive.map((card, i) => (
                <li key={`${i}.${hashText(card.text)}`} className="kanban-archive-item">
                  <MarkdownSnippet markdown={cardMeta(card.text, board.settings).body || ' '} path={path} className="kanban-card-text" />
                  {editable && (
                    <span className="kanban-archive-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Restore to the first lane"
                        title={board.lanes.length ? `Restore to “${laneTitleText(board.lanes[0].title)}”` : 'Add a lane first'}
                        disabled={board.lanes.length === 0}
                        onClick={() => write((b) => restoreCard(b, i, 0))}
                      >
                        <ArchiveRestore size={16} />
                      </button>
                      <button type="button" className="icon-button" aria-label="Delete archived card" title="Delete" onClick={() => write((b) => deleteArchived(b, i))}>
                        <Trash2 size={16} />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {board.lanes.length === 0 && !editable ? (
        <p className="muted">This board has no lanes.</p>
      ) : (
        <Board
          label={`${session.path} board`}
          columns={columns}
          itemKey={(i) => i.key}
          itemLabel={(i) => cardMeta(i.card.text).body.split('\n')[0] || 'Empty card'}
          canDrag={(i) => editable && editing?.key !== i.key}
          onMove={onMove}
          onOpen={startEdit}
          renderCard={(item) =>
            editing?.key === item.key ? (
              <div className="kanban-edit">
                <CardEditor
                  text={item.card.text}
                  canvasPath={path}
                  className="kanban-card-editor"
                  onChange={(v) => (draft.current = v)}
                  onEnter={finishEdit}
                  onDone={finishEdit}
                  onSave={finishEdit}
                  onBlur={finishEdit}
                />
              </div>
            ) : (
              <CardView
                item={item}
                path={path}
                settings={board.settings}
                editable={editable}
                onToggle={() => write((b) => toggleCard(b, { lane: item.lane, index: item.index }))}
                onEdit={() => startEdit(item)}
                onMenu={(e) => cardMenu(e, item)}
              />
            )
          }
          trailing={
            editable ? (
              <button type="button" className="board-add-column" onClick={addLanePrompt}>
                <ListPlus size={14} aria-hidden /> Add lane
              </button>
            ) : undefined
          }
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
