// Pure task logic shared by the views, the store and the tests: the view rules of API.md §20.2
// (which tasks a view holds and in which order, as the server computes them), tags, links,
// subtask trees and the rows of a list.
import type { LocalDate, Task, TaskList, TaskPriority, TaskSection, TaskStatus, TaskView } from '../api/types';
import type { LinkIndex } from '../features/links';
import { resolve } from '../features/links';
import { findTags, findWikiLinks, isInternalDestination, parseMarkdownDestination } from '../features/syntax';
import { addDays, compareTaskDates, datePart } from './dates';
import { compareKeys } from './fractionalIndex';

/** Subtasks are at most three levels deep (API.md §20.1): depths 0, 1 and 2. */
export const MAX_DEPTH = 2;

export const PRIORITY_NAMES: Record<TaskPriority, string> = { 0: 'None', 1: 'Low', 2: 'Medium', 3: 'High' };

export function isClosed(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'open';
}

/** The date a task is scheduled for: its due date, else its start date. */
export function scheduled(task: Pick<Task, 'due' | 'start'>): string | null {
  return task.due ?? task.start;
}

/** Manual order: the fractional key, then the id (equal keys sort by id). */
export function compareOrder(a: Pick<Task, 'order' | 'id'>, b: Pick<Task, 'order' | 'id'>): number {
  return compareKeys(a.order, b.order) || compareKeys(a.id, b.id);
}

/** Lists by their order key (then id), as the server lists them. */
export function sortLists(lists: Iterable<TaskList>): TaskList[] {
  return [...lists].sort((a, b) => compareKeys(a.order, b.order) || compareKeys(a.id, b.id));
}

function listRank(lists: readonly TaskList[]): Map<string, number> {
  return new Map(lists.map((l, i) => [l.id, i]));
}

/** Today and Upcoming order: by date (all day before times), priority (high first), list order, manual order. */
export function scheduleComparator(lists: readonly TaskList[]): (a: Task, b: Task) => number {
  const rank = listRank(lists);
  return (a, b) => {
    const wa = scheduled(a);
    const wb = scheduled(b);
    if (wa !== wb) {
      if (wa === null) return 1;
      if (wb === null) return -1;
      const byDate = compareTaskDates(wa, wb);
      if (byDate !== 0) return byDate;
    }
    return b.priority - a.priority || (rank.get(a.listId) ?? Infinity) - (rank.get(b.listId) ?? Infinity) || compareOrder(a, b);
  };
}

function activeList(lists: ReadonlyMap<string, TaskList>, task: Task): boolean {
  const list = lists.get(task.listId);
  return list !== undefined && !list.archived && !task.archived;
}

function onOrBefore(value: string | null, today: LocalDate): boolean {
  return value !== null && datePart(value) <= today;
}

/** `view=today`: open tasks of active lists, due or starting today or earlier. */
export function inToday(task: Task, today: LocalDate, lists: ReadonlyMap<string, TaskList>): boolean {
  return task.status === 'open' && activeList(lists, task) && (onOrBefore(task.due, today) || onOrBefore(task.start, today));
}

/** `view=list&list=<id>&status=all`: every task of the list's file. */
export function inList(task: Task, listId: string): boolean {
  return task.listId === listId && !task.archived;
}

/** `view=list` without a list: the open tasks of every active list. */
export function inOpenLists(task: Task, lists: ReadonlyMap<string, TaskList>): boolean {
  return task.status === 'open' && activeList(lists, task);
}

/** `view=upcoming`: open tasks of active lists scheduled from today to today + days - 1. */
export function inUpcoming(task: Task, today: LocalDate, days: number, lists: ReadonlyMap<string, TaskList>): boolean {
  const when = scheduled(task);
  if (task.status !== 'open' || !activeList(lists, task) || when === null) return false;
  const day = datePart(when);
  return day >= today && day < addDays(today, days);
}

/** The filters of GET /api/tasks (API.md §20.2) that views share. */
export interface TaskFilter {
  list?: string;
  /** A tag, matching nested ones too (`home` matches `home/garden`), with or without '#'. */
  tag?: string;
  /** A comma-separated set of priorities, such as '2,3'. */
  priority?: string;
  /** 'all', or a comma-separated set of statuses. */
  status?: string;
}

/** The statuses a view holds: `status`, else the view's default (§20.2). */
export function statusesOf(status: string | undefined, view: TaskView): ReadonlySet<TaskStatus> {
  if (status === 'all') return new Set<TaskStatus>(['open', 'done', 'cancelled']);
  if (status) return new Set(status.split(',').map((s) => s.trim()) as TaskStatus[]);
  if (view === 'completed') return new Set<TaskStatus>(['done', 'cancelled']);
  return new Set<TaskStatus>(view === 'search' ? ['open', 'done', 'cancelled'] : ['open']);
}

/** The priorities of a `priority` parameter, or null for any. */
export function prioritiesOf(priority: string | undefined): ReadonlySet<number> | null {
  if (!priority) return null;
  const set = new Set(priority.split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p >= 0 && p <= 3));
  return set.size > 0 ? set : null;
}

/** The list, tag and priority filters, as the server applies them (`TaskQuery.matchesFilters`). */
export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter.list !== undefined && task.listId !== filter.list) return false;
  const priorities = prioritiesOf(filter.priority);
  if (priorities && !priorities.has(task.priority)) return false;
  if (filter.tag) {
    const wanted = filter.tag.replace(/^#/, '').toLowerCase();
    if (!taskTags(task).some((t) => t.toLowerCase() === wanted || t.toLowerCase().startsWith(wanted + '/'))) return false;
  }
  return true;
}

/** A filter from a URL's query (the Filter page): only the parameters the server knows, cleaned. */
export function filterFromParams(params: URLSearchParams): TaskFilter {
  const tag = params.get('tag')?.trim().replace(/^#/, '') || undefined;
  const priorities = prioritiesOf(params.get('priority') ?? undefined);
  const list = params.get('list') || undefined;
  return {
    ...(list ? { list } : {}),
    ...(tag ? { tag } : {}),
    ...(priorities ? { priority: [...priorities].sort().join(',') } : {}),
    ...(params.get('status') === 'all' ? { status: 'all' } : {}),
  };
}

/** `view=list`: the tasks of one list (archived or not), or of every active list; never archive files. */
export function inListView(task: Task, lists: ReadonlyMap<string, TaskList>, listId?: string): boolean {
  if (task.archived) return false;
  if (listId !== undefined) return task.listId === listId;
  const list = lists.get(task.listId);
  return list !== undefined && !list.archived;
}

/** Completed order (§20.2): `completedAt`, newest first (a task without one last), then id, descending. */
export function compareCompleted(a: Task, b: Task): number {
  const ta = a.completedAt ? Date.parse(a.completedAt) : -Infinity;
  const tb = b.completedAt ? Date.parse(b.completedAt) : -Infinity;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return compareKeys(b.id, a.id);
}

/** A task is overdue when its scheduled day is before today. */
export function isOverdue(task: Task, today: LocalDate): boolean {
  const when = scheduled(task);
  return when !== null && datePart(when) < today;
}

/** The ranges of `[[wikilinks]]` in a text, where `#` does not start a tag. */
function linkRanges(text: string): Array<[number, number]> {
  return findWikiLinks(text).map((l) => [l.from, l.to]);
}

/** `#tags` written in a title (outside links), without '#'. */
export function titleTags(title: string): string[] {
  const ranges = linkRanges(title);
  return findTags(title)
    .filter((t) => !ranges.some(([from, to]) => t.from >= from && t.from < to))
    .map((t) => t.tag);
}

/** The task's tags: `tags`, then the title's `#tags`, distinct ignoring case. */
export function taskTags(task: Pick<Task, 'tags' | 'title'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...task.tags, ...titleTags(task.title)]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

const MD_LINK = /\[[^\]\n]*\]\(([^)\n]+)\)/g;

/** Link targets written in task text: `[[wikilinks]]` (not embeds) and internal Markdown links. */
function textTargets(text: string): string[] {
  const out = findWikiLinks(text)
    .filter((l) => !l.embed && l.target !== '')
    .map((l) => l.target);
  for (const m of text.matchAll(MD_LINK)) {
    const dest = m[1].trim().split(/\s+"/)[0];
    if (isInternalDestination(dest)) {
      const { target } = parseMarkdownDestination(dest);
      if (target) out.push(target);
    }
  }
  return out;
}

/**
 * True when the task links to `notePath`: through `links`, or a link in its title or notes that
 * resolves to it from the list's file (the backlink rules of API.md §20.9).
 */
export function linksTo(task: Pick<Task, 'links' | 'title' | 'notes'>, notePath: string, listPath: string, index: LinkIndex): boolean {
  if (task.links.includes(notePath)) return true;
  const targets = textTargets(task.title + (task.notes ? '\n' + task.notes : ''));
  return targets.some((t) => resolve(t, listPath, index) === notePath);
}

// ---------- subtasks ----------

/** Children by parent id (null: the top level), each in manual order. */
export function childrenByParent(tasks: Iterable<Task>): Map<string | null, Task[]> {
  const all = [...tasks];
  const ids = new Set(all.map((t) => t.id));
  const map = new Map<string | null, Task[]>();
  for (const t of all) {
    // A parent that is not here (another file, a hand edit) leaves the task at the top level.
    const parent = t.parentId !== null && ids.has(t.parentId) ? t.parentId : null;
    const list = map.get(parent);
    if (list) list.push(t);
    else map.set(parent, [t]);
  }
  for (const list of map.values()) list.sort(compareOrder);
  return map;
}

/** Every descendant of `id`, depth first. */
export function descendants(id: string, children: ReadonlyMap<string | null, Task[]>): Task[] {
  const out: Task[] = [];
  const walk = (parent: string, guard: Set<string>) => {
    for (const c of children.get(parent) ?? []) {
      if (guard.has(c.id)) continue;
      guard.add(c.id);
      out.push(c);
      walk(c.id, guard);
    }
  };
  walk(id, new Set([id]));
  return out;
}

/** Levels below `id`: 0 for a task without subtasks. */
export function subtreeHeight(id: string, children: ReadonlyMap<string | null, Task[]>, guard = new Set<string>()): number {
  if (guard.has(id)) return 0;
  guard.add(id);
  let height = 0;
  for (const c of children.get(id) ?? []) height = Math.max(height, 1 + subtreeHeight(c.id, children, guard));
  return height;
}

/** The depth of a task among `byId` (0 at the top level). */
export function depthOf(task: Task, byId: ReadonlyMap<string, Task>): number {
  let depth = 0;
  const seen = new Set([task.id]);
  for (let p = task.parentId; p !== null; ) {
    const parent = byId.get(p);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth++;
    p = parent.parentId;
  }
  return depth;
}

// ---------- the rows of a list ----------

export interface SectionRow {
  kind: 'section';
  key: string;
  /** null: the tasks without a section, at the top (no header is shown for them). */
  section: TaskSection | null;
  count: number;
  collapsed: boolean;
}

export interface TaskRow {
  kind: 'task';
  key: string;
  task: Task;
  depth: number;
  sectionId: string | null;
  childCount: number;
  collapsed: boolean;
}

export type ListRow = SectionRow | TaskRow;

export interface RowOptions {
  showCompleted: boolean;
  /** Collapsed parents and sections (section ids, prefixed `section:`). */
  collapsed: ReadonlySet<string>;
}

/** Sections in order (then id). */
export function sortSections(sections: readonly TaskSection[]): TaskSection[] {
  return [...sections].sort((a, b) => compareKeys(a.order, b.order) || compareKeys(a.id, b.id));
}

/**
 * The rows of a list page: the tasks without a section first, then each section with its
 * header, each top-level task followed by its subtasks. A closed task is shown when
 * `showCompleted` is on, or when it still has an open subtask (the tree stays whole).
 */
export function buildRows(list: TaskList, tasks: readonly Task[], opts: RowOptions): ListRow[] {
  const own = tasks.filter((t) => inList(t, list.id));
  const children = childrenByParent(own);
  const openBelow = new Map<string, boolean>();
  const hasOpen = (t: Task, guard = new Set<string>()): boolean => {
    const known = openBelow.get(t.id);
    if (known !== undefined) return known;
    if (guard.has(t.id)) return false;
    guard.add(t.id);
    const result = !isClosed(t) || (children.get(t.id) ?? []).some((c) => hasOpen(c, guard));
    openBelow.set(t.id, result);
    return result;
  };
  const visible = (t: Task) => opts.showCompleted || hasOpen(t);

  const sections = sortSections(list.sections);
  const known = new Set(sections.map((s) => s.id));
  const groups = new Map<string | null, Task[]>([[null, []]]);
  for (const s of sections) groups.set(s.id, []);
  for (const t of children.get(null) ?? []) {
    // A section id this list does not have (a hand edit) counts as no section.
    const key = t.sectionId !== null && known.has(t.sectionId) ? t.sectionId : null;
    groups.get(key)!.push(t);
  }

  const rows: ListRow[] = [];
  const pushTask = (t: Task, depth: number, sectionId: string | null, guard: Set<string>) => {
    if (guard.has(t.id)) return;
    guard.add(t.id);
    const kids = (children.get(t.id) ?? []).filter(visible);
    const collapsed = kids.length > 0 && opts.collapsed.has(t.id);
    rows.push({ kind: 'task', key: t.id, task: t, depth, sectionId, childCount: kids.length, collapsed });
    if (!collapsed) for (const c of kids) pushTask(c, depth + 1, sectionId, guard);
  };
  for (const section of [null, ...sections]) {
    const top = (groups.get(section?.id ?? null) ?? []).filter(visible);
    const key = section ? `section:${section.id}` : 'section:';
    const collapsed = section !== null && opts.collapsed.has(key);
    rows.push({ kind: 'section', key, section, count: top.length, collapsed });
    if (collapsed) continue;
    const guard = new Set<string>();
    for (const t of top) pushTask(t, 0, section?.id ?? null, guard);
  }
  return rows;
}
