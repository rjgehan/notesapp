// One list (ROADMAP item 4), shown by its page (`/x/tasks/list/:id`) and by its file (the `tasks`
// file view): as a list, its sections and subtasks (three levels), drag to reorder with
// fractional order keys (also into another section, or under another task), and inline editing
// of a task's title, notes, due date, priority and tags; or as a board (Kanban, TaskBoard), with
// its sections or the statuses as columns. Keyboard: Enter opens a row's editor, Alt+↑/↓ move it,
// Alt+→/← indent and outdent.
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns3,
  CornerDownRight,
  Ellipsis,
  Eye,
  EyeOff,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  List as ListIcon,
  ListPlus,
  Maximize2,
  Pencil,
  Plus,
  SquareSplitVertical,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { Task, TaskList, TaskSection } from '../../api/types';
import { autoGrow } from '../../components/autoGrow';
import { useWorkspaceScroller } from '../../components/layout/workspaceScroller';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { navigateTo } from '../../features/navigation';
import { confirmAction, promptText } from '../../state/dialogs';
import { useToday } from '../dates';
import { buildRows, childrenByParent, isClosed, MAX_DEPTH, subtreeHeight, type ListRow, type SectionRow, type TaskRow } from '../model';
import { createSection, deleteSection, deleteTask, isPending, moveTask, renameSection, type Placement } from '../mutations';
import { loadParser } from '../quickadd/loadParser';
import { listParams, useTaskView } from '../queries';
import { Loading, LoadError, TaskFab, TaskProblems, TasksNav } from './common';
import { useTaskData } from './useTaskData';
import { gapAt, indent, INDENT_PX, moveDown, moveUp, outdent, project, rowsWithout, type Projection } from './drag';
import { DateTimeField, PriorityField, TagsField } from './fields';
import { useListLayout } from './layoutPref';
import { useTextField } from './textField';
import { listMenu } from './listActions';
import { ListDot, TaskCheck, TaskMeta, TaskTitle } from './parts';
import { openQuickAdd, openTaskDetail } from './state';
import { TaskBoard } from './TaskBoard';

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
}

function menuAt(e: MouseEvent, label: string, items: MenuEntry[]): MenuState {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4, label, items };
}

/** The inline editor of a list row: title, notes, due date, priority and tags. */
function InlineEditor({ task, readOnly, onClose }: { task: Task; readOnly: boolean; onClose(): void }) {
  const title = useTextField(task, 'title', { disabled: readOnly });
  const notes = useTextField(task, 'notes', { multiline: true, disabled: readOnly });
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (titleRef.current) autoGrow(titleRef.current);
    if (notesRef.current) autoGrow(notesRef.current);
  }, [title.value, notes.value]);

  return (
    <div
      className="task-inline-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <textarea ref={titleRef} className="task-inline-title" aria-label="Title" rows={1} maxLength={500} {...title} readOnly={readOnly} autoFocus={!readOnly} />
      <textarea ref={notesRef} className="task-inline-notes" aria-label="Notes" placeholder="Notes" rows={1} {...notes} readOnly={readOnly} />
      <div className="task-inline-props">
        <DateTimeField task={task} field="due" label="Due" disabled={readOnly} />
        <PriorityField task={task} disabled={readOnly} />
        <TagsField task={task} disabled={readOnly} />
        <div className="task-inline-actions">
          <button type="button" className="button button-small" onClick={() => openTaskDetail(task.id)}>
            <Maximize2 size={14} aria-hidden /> Details
          </button>
          <button type="button" className="button button-small" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  row: TaskRow;
  list: TaskList;
  today: string;
  expanded: boolean;
  readOnly: boolean;
  dragging: boolean;
  highlighted: boolean;
  subtasks: { done: number; total: number } | undefined;
  onExpand(id: string | null): void;
  onToggleCollapse(id: string): void;
  onMenu(e: MouseEvent, task: Task): void;
  onKey(e: KeyboardEvent, task: Task): void;
  onDragStart(e: PointerEvent<HTMLElement>, row: TaskRow): void;
  dragHandlers: {
    onPointerMove(e: PointerEvent<HTMLElement>): void;
    onPointerUp(e: PointerEvent<HTMLElement>): void;
    onPointerCancel(): void;
  };
}

function ListTaskRow({ row, list, today, expanded, readOnly, dragging, highlighted, subtasks, onExpand, onToggleCollapse, onMenu, onKey, onDragStart, dragHandlers }: RowProps) {
  const { task } = row;
  const pending = isPending(task);
  return (
    <li
      className={`task-row is-tree${isClosed(task) ? ' is-closed' : ''}${pending ? ' is-pending' : ''}${expanded ? ' is-expanded' : ''}${dragging ? ' is-dragging' : ''}${highlighted ? ' is-highlighted' : ''}`}
      style={{ '--task-depth': row.depth } as CSSProperties}
      data-row-key={row.key}
      data-task-id={task.id}
      tabIndex={-1}
      onKeyDown={(e) => e.target === e.currentTarget && onKey(e, task)}
    >
      {!readOnly && (
        <span
          className="task-drag-handle"
          aria-hidden
          title="Drag to move"
          onPointerDown={(e) => !pending && onDragStart(e, row)}
          {...dragHandlers}
        >
          <GripVertical size={15} />
        </span>
      )}
      {row.childCount > 0 ? (
        <button
          type="button"
          className="icon-button task-collapse"
          aria-label={row.collapsed ? `Show subtasks of “${task.title}”` : `Hide subtasks of “${task.title}”`}
          aria-expanded={!row.collapsed}
          onClick={() => onToggleCollapse(task.id)}
        >
          {row.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
      ) : (
        <span className="task-collapse-spacer" aria-hidden />
      )}
      <TaskCheck task={task} disabled={readOnly && !task.archived} />
      {expanded ? (
        <InlineEditor task={task} readOnly={readOnly || pending} onClose={() => onExpand(null)} />
      ) : (
        <div
          className="task-row-body"
          role="button"
          tabIndex={0}
          aria-label={`Edit “${task.title}”`}
          aria-expanded={false}
          onClick={() => !pending && onExpand(task.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if ((e.key === 'Enter' || e.key === ' ') && !pending) {
              e.preventDefault();
              onExpand(task.id);
              return;
            }
            onKey(e, task);
          }}
        >
          <span className="task-title">
            <TaskTitle task={task} listPath={list.path} />
          </span>
          <TaskMeta task={task} today={today} subtasks={subtasks} />
        </div>
      )}
      {!expanded && (
        <button type="button" className="icon-button task-row-more" aria-label={`More for “${task.title}”`} title="More" aria-haspopup="menu" disabled={pending} onClick={(e) => onMenu(e, task)}>
          <Ellipsis size={16} />
        </button>
      )}
    </li>
  );
}

function SectionHeader({ row, readOnly, onToggle, onMenu, onAdd }: { row: SectionRow; readOnly: boolean; onToggle(): void; onMenu(e: MouseEvent, s: TaskSection): void; onAdd(): void }) {
  const section = row.section;
  if (!section) return <li className="task-section-anchor" data-row-key={row.key} aria-hidden />;
  return (
    <li className="task-section" data-row-key={row.key}>
      <h2 className="task-section-title">
        <button type="button" className="task-section-toggle" aria-expanded={!row.collapsed} onClick={onToggle}>
          {row.collapsed ? <ChevronRight size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
          <span>{section.name}</span>
          <span className="tasks-count">{row.count}</span>
        </button>
      </h2>
      {!readOnly && (
        <>
          <button type="button" className="icon-button" aria-label={`Add task to ${section.name}`} title="Add task" onClick={onAdd}>
            <Plus size={16} />
          </button>
          <button type="button" className="icon-button" aria-label={`More for section ${section.name}`} title="More" aria-haspopup="menu" onClick={(e) => onMenu(e, section)}>
            <Ellipsis size={16} />
          </button>
        </>
      )}
    </li>
  );
}

interface DragState {
  task: Task;
  depth: number;
  height: number;
  startX: number;
  others: ListRow[];
  tops: number[];
  bottoms: number[];
  mids: number[];
  lastX: number;
  lastY: number;
  /** Where it lands now; read on release (state may not have rendered yet). */
  projection: Projection | null;
}

interface DropState {
  taskId: string;
  projection: Projection | null;
  lineTop: number;
}

const EDGE_PX = 48;
const SCROLL_STEP_PX = 12;

export interface ListScreenProps {
  listId: string;
  /** Extra header buttons (the file view's "Source"). */
  headerExtra?: ReactNode;
  /** A task to point out (a `#^id` link): its row is highlighted and scrolled into view. */
  highlight?: string | null;
  /** Shown by its file: the browser tab keeps the file's title. */
  asFile?: boolean;
}

function PageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

export function ListScreen({ listId: id, headerExtra, highlight = null, asFile = false }: ListScreenProps) {
  const today = useToday();
  const query = useTaskView(listParams(id), id !== '');
  const data = useTaskData();
  const list = data.listMap.get(id);
  const [layout, setLayout] = useListLayout(id);
  const [showCompleted, setShowCompleted] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const drag = useRef<DragState | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scroller = useWorkspaceScroller();
  const readOnly = list?.writable === false;

  useEffect(() => {
    void loadParser().catch(() => undefined);
  }, []);

  const own = useMemo(() => [...data.tasks.values()].filter((t) => t.listId === id && !t.archived), [data, id]);
  // A closed task that a link points out is shown even while completed tasks are hidden.
  const pointedOut = highlight ? own.find((t) => t.id === highlight) : undefined;
  const showClosed = showCompleted || (pointedOut !== undefined && isClosed(pointedOut));
  const rows = useMemo(() => (list ? buildRows(list, own, { showCompleted: showClosed, collapsed }) : []), [list, own, showClosed, collapsed]);
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    if (!highlight || scrolledTo.current === highlight || !rows.some((r) => r.kind === 'task' && r.task.id === highlight)) return;
    scrolledTo.current = highlight;
    requestAnimationFrame(() => document.querySelector(`[data-task-id="${CSS.escape(highlight)}"]`)?.scrollIntoView?.({ block: 'center' }));
  }, [highlight, rows]);
  const children = useMemo(() => childrenByParent(own), [own]);
  const completedCount = own.filter(isClosed).length;
  const openCount = own.length - completedCount;

  const subtaskCounts = (taskId: string) => {
    const kids = children.get(taskId);
    if (!kids?.length) return undefined;
    return { done: kids.filter(isClosed).length, total: kids.length };
  };

  const toggleCollapse = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const place = (task: Task, placement: Placement | null) => {
    if (placement) void moveTask(task, placement);
  };

  const focusRow = (taskId: string) => {
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"] .task-row-body`)?.focus());
  };

  const onKey = (e: KeyboardEvent, task: Task) => {
    if (!e.altKey || readOnly || isPending(task)) return;
    const all = data.tasks.values();
    const placement =
      e.key === 'ArrowUp' ? moveUp(task, all) : e.key === 'ArrowDown' ? moveDown(task, all) : e.key === 'ArrowRight' ? indent(task, all) : e.key === 'ArrowLeft' ? outdent(task, all) : undefined;
    if (placement === undefined) return;
    e.preventDefault();
    place(task, placement);
    focusRow(task.id);
  };

  const taskMenu = (e: MouseEvent, task: Task) => {
    const all = [...data.tasks.values()];
    const depth = rows.find((r): r is TaskRow => r.kind === 'task' && r.task.id === task.id)?.depth ?? 0;
    const items: MenuEntry[] = [
      { id: 'details', label: 'Details', icon: <Maximize2 size={16} />, run: () => openTaskDetail(task.id) },
      { id: 'edit', label: 'Edit inline', icon: <Pencil size={16} />, disabled: readOnly, run: () => setExpanded(task.id) },
    ];
    if (!readOnly) {
      items.push(
        { id: 'subtask', label: 'Add subtask', icon: <CornerDownRight size={16} />, disabled: depth >= MAX_DEPTH, run: () => openQuickAdd({ parentId: task.id }) },
        'separator',
        { id: 'up', label: 'Move up', icon: <ArrowUp size={16} />, disabled: !moveUp(task, all), run: () => place(task, moveUp(task, all)) },
        { id: 'down', label: 'Move down', icon: <ArrowDown size={16} />, disabled: !moveDown(task, all), run: () => place(task, moveDown(task, all)) },
        { id: 'indent', label: 'Make subtask of the task above', icon: <IndentIncrease size={16} />, disabled: !indent(task, all), run: () => place(task, indent(task, all)) },
        { id: 'outdent', label: 'Move out of its parent', icon: <IndentDecrease size={16} />, disabled: !outdent(task, all), run: () => place(task, outdent(task, all)) },
      );
      if (task.parentId === null && list && list.sections.length > 0) {
        for (const target of [null, ...list.sections]) {
          if ((target?.id ?? null) === task.sectionId) continue;
          items.push({
            id: `section-${target?.id ?? ''}`,
            label: target ? `Move to section “${target.name}”` : 'Move out of the section',
            icon: <SquareSplitVertical size={16} />,
            run: () => place(task, { parentId: null, sectionId: target?.id ?? null, afterId: null }),
          });
        }
      }
      items.push('separator', { id: 'delete', label: 'Delete…', icon: <Trash2 size={16} />, danger: true, run: () => void deleteTask(task) });
    }
    setMenu(menuAt(e, `${task.title} actions`, items));
  };

  const sectionMenu = (e: MouseEvent, section: TaskSection) => {
    if (!list) return;
    setMenu(
      menuAt(e, `${section.name} actions`, [
        {
          id: 'rename',
          label: 'Rename section…',
          icon: <Pencil size={16} />,
          run: async () => {
            const name = await promptText({ title: 'Rename section', label: 'Name', value: section.name, confirmLabel: 'Rename' });
            if (name?.trim() && name.trim() !== section.name) await renameSection(list, section.id, name);
          },
        },
        {
          id: 'delete',
          label: 'Delete section…',
          icon: <Trash2 size={16} />,
          danger: true,
          run: async () => {
            const ok = await confirmAction({ title: 'Delete section?', message: `“${section.name}” is removed; its tasks stay in the list, without a section.`, confirmLabel: 'Delete section', danger: true });
            if (ok) await deleteSection(list, section.id);
          },
        },
      ]),
    );
  };

  const addSection = async () => {
    if (!list) return;
    const name = await promptText({ title: 'New section', label: 'Name', value: '', confirmLabel: 'Add' });
    if (name?.trim()) await createSection(list, name);
  };

  // ---------- drag to reorder ----------

  const stopScrolling = () => {
    if (scrollTimer.current) clearInterval(scrollTimer.current);
    scrollTimer.current = null;
  };

  const track = () => {
    const d = drag.current;
    const ul = listRef.current;
    if (!d || !ul) return;
    const y = d.lastY - ul.getBoundingClientRect().top;
    const gap = Math.max(1, gapAt(d.mids, y));
    const projection = project(d.others, gap, d, d.lastX - d.startX);
    d.projection = projection;
    const lineTop = gap < d.others.length ? d.tops[gap] : (d.bottoms[d.others.length - 1] ?? 0);
    setDrop({ taskId: d.task.id, projection, lineTop });
  };

  const autoScroll = () => {
    const d = drag.current;
    const el = scroller.current;
    if (!d || !el) return stopScrolling();
    const rect = el.getBoundingClientRect();
    const step = d.lastY < rect.top + EDGE_PX ? -SCROLL_STEP_PX : d.lastY > rect.bottom - EDGE_PX ? SCROLL_STEP_PX : 0;
    if (step === 0) return stopScrolling();
    el.scrollBy?.(0, step);
    track();
  };

  const onDragStart = (e: PointerEvent<HTMLElement>, row: TaskRow) => {
    const ul = listRef.current;
    if (e.button !== 0 || !ul) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setExpanded(null);
    const others = rowsWithout(rows, row.task.id);
    const ulTop = ul.getBoundingClientRect().top;
    const elements = new Map([...ul.querySelectorAll<HTMLElement>('[data-row-key]')].map((el) => [el.dataset.rowKey, el]));
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const r of others) {
      const rect = elements.get(r.key)?.getBoundingClientRect();
      tops.push(rect ? rect.top - ulTop : 0);
      bottoms.push(rect ? rect.bottom - ulTop : 0);
    }
    drag.current = {
      task: row.task,
      depth: row.depth,
      height: subtreeHeight(row.task.id, children),
      startX: e.clientX,
      others,
      tops,
      bottoms,
      mids: tops.map((t, i) => (t + bottoms[i]) / 2),
      lastX: e.clientX,
      lastY: e.clientY,
      projection: null,
    };
    track();
  };

  const dragHandlers = {
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      track();
      if (!scrollTimer.current) scrollTimer.current = setInterval(autoScroll, 16);
    },
    onPointerUp: () => {
      const d = drag.current;
      drag.current = null;
      stopScrolling();
      setDrop(null);
      if (d?.projection) place(d.task, d.projection);
    },
    onPointerCancel: () => {
      drag.current = null;
      stopScrolling();
      setDrop(null);
    },
  };

  useEffect(() => {
    if (!drop) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      drag.current = null;
      stopScrolling();
      setDrop(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drop]);

  useEffect(() => stopScrolling, []);

  // ---------- render ----------

  if (!list) {
    return (
      <div className="page tasks-page">
        {!asFile && <PageTitle title="Task list" />}
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <LoadError error={query.error} retry={() => void query.refetch()} />
        ) : (
          <div className="empty-state">
            <h2>This list no longer exists</h2>
            <p>It may have been deleted or moved to the trash on another device.</p>
            <div className="empty-state-actions">
              <button type="button" className="button" onClick={() => navigateTo('/x/tasks')}>
                All lists
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const board = layout !== 'list';
  const listActions: MenuEntry[] = [
    { id: 'section', label: 'Add section…', icon: <ListPlus size={16} />, disabled: readOnly, run: () => void addSection() },
    {
      id: 'completed',
      label: showCompleted ? 'Hide completed tasks' : `Show completed tasks (${completedCount})`,
      icon: showCompleted ? <EyeOff size={16} /> : <Eye size={16} />,
      disabled: layout === 'board-status',
      run: () => setShowCompleted(!showCompleted),
    },
    'separator',
    ...listMenu(list),
  ];
  const staying = drop ? new Set(rowsWithout(rows, drop.taskId).map((r) => r.key)) : null;
  const draggedKeys = staying ? new Set(rows.filter((r) => !staying.has(r.key)).map((r) => r.key)) : null;
  const isEmpty = rows.every((r) => r.kind === 'section');

  return (
    <div className={`page tasks-page tasks-list-page${board ? ' is-board' : ''}`}>
      {!asFile && <PageTitle title={list.name} />}
      <TasksNav />
      <header className="page-header">
        <div className="tasks-list-heading">
          <h1 className="page-title">
            <ListDot list={list} /> {list.name}
          </h1>
          <p className="tasks-subtitle">
            {openCount} open{completedCount > 0 ? ` · ${completedCount} completed` : ''}
            {list.archived ? ' · archived' : ''}
          </p>
        </div>
        <div className="tasks-header-actions">
          <div className="segmented tasks-layout" role="radiogroup" aria-label="Show as">
            <button type="button" role="radio" aria-checked={!board} className={!board ? 'is-active' : ''} title="List" onClick={() => setLayout('list')}>
              <ListIcon size={14} aria-hidden /> List
            </button>
            <button type="button" role="radio" aria-checked={board} className={board ? 'is-active' : ''} title="Board" onClick={() => setLayout(layout === 'board-status' ? 'board-status' : 'board-section')}>
              <Columns3 size={14} aria-hidden /> Board
            </button>
          </div>
          {board && (
            <select className="select tasks-board-group" aria-label="Columns" value={layout} onChange={(e) => setLayout(e.target.value as 'board-section' | 'board-status')}>
              <option value="board-section">By section</option>
              <option value="board-status">By status</option>
            </select>
          )}
          {!readOnly && (
            <button type="button" className="button tasks-add-button" onClick={() => openQuickAdd({ listId: list.id })}>
              <Plus size={14} aria-hidden /> Add task
            </button>
          )}
          {headerExtra}
          <button type="button" className="icon-button" aria-label="List actions" title="List actions" aria-haspopup="menu" onClick={(e) => setMenu(menuAt(e, `${list.name} actions`, listActions))}>
            <Ellipsis size={18} />
          </button>
        </div>
      </header>
      {readOnly && <p className="banner banner-warning">This list was written by a newer version of NotesApp; it is shown here but cannot be changed.</p>}
      <TaskProblems problems={query.data?.problems ?? []} only={list.path} />
      {query.isPending && own.length === 0 ? (
        <Loading />
      ) : query.isError && own.length === 0 ? (
        <LoadError error={query.error} retry={() => void query.refetch()} />
      ) : board ? (
        <TaskBoard
          list={list}
          tasks={own}
          group={layout === 'board-status' ? 'status' : 'section'}
          showCompleted={showClosed}
          readOnly={readOnly}
          today={today}
          onSectionMenu={sectionMenu}
          onAddSection={() => void addSection()}
        />
      ) : (
        <div className="task-tree-wrap">
          <ul ref={listRef} className="task-list task-tree" aria-label={list.name}>
            {rows.map((row) =>
              row.kind === 'section' ? (
                <SectionHeader
                  key={row.key}
                  row={row}
                  readOnly={readOnly}
                  onToggle={() => toggleCollapse(row.key)}
                  onMenu={sectionMenu}
                  onAdd={() => openQuickAdd({ listId: list.id, sectionId: row.section?.id ?? null })}
                />
              ) : (
                <ListTaskRow
                  key={row.key}
                  row={row}
                  list={list}
                  today={today}
                  expanded={expanded === row.task.id}
                  readOnly={readOnly}
                  dragging={draggedKeys?.has(row.key) ?? false}
                  highlighted={row.task.id === highlight}
                  subtasks={subtaskCounts(row.task.id)}
                  onExpand={setExpanded}
                  onToggleCollapse={toggleCollapse}
                  onMenu={taskMenu}
                  onKey={onKey}
                  onDragStart={onDragStart}
                  dragHandlers={dragHandlers}
                />
              ),
            )}
          </ul>
          {drop && drop.projection && <div className="task-drop-line" style={{ top: drop.lineTop, left: 8 + drop.projection.depth * INDENT_PX }} aria-hidden />}
          {isEmpty && (
            <div className="empty-state">
              <h2>{completedCount > 0 && !showCompleted ? 'All done' : 'No tasks yet'}</h2>
              {!readOnly && (
                <div className="empty-state-actions">
                  <button type="button" className="button button-primary" onClick={() => openQuickAdd({ listId: list.id })}>
                    <Plus size={14} aria-hidden /> Add a task
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
      {!readOnly && <TaskFab onClick={() => openQuickAdd({ listId: list.id })} />}
    </div>
  );
}
