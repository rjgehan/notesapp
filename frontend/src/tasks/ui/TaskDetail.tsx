// The task detail sheet (ROADMAP item 4): every field of a task, each saved on its own as a
// per-field PATCH (API.md §20.4). Full screen on phones. The task stays live while it is open:
// changes from other devices show up in the fields that are not being edited.
import { Bell, ExternalLink, FileText, Plus, Trash2, X } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTree, useVaultSettings } from '../../api/hooks';
import type { LocalDateTime, Task, TaskList, TaskReminder } from '../../api/types';
import { autoGrow } from '../../components/autoGrow';
import { Modal } from '../../components/overlays/Modal';
import { formatDateTime } from '../../features/format';
import { fuzzyRank } from '../../features/fuzzy';
import { navigateTo, openLink, openPath, openTag } from '../../features/navigation';
import { displayName } from '../../features/paths';
import { usePrefs } from '../../state/prefs';
import { makeRenderContext } from '../../render/context';
import { renderNote } from '../../render/render';
import { useUi } from '../../state/ui';
import { datePart, useToday } from '../dates';
import { childrenByParent, depthOf, isClosed, MAX_DEPTH } from '../model';
import { createTask, deleteTask, isPending, updateTask } from '../mutations';
import { useTaskById } from '../queries';
import { reminderPresets } from '../reminderPresets';
import { taskStore, useTaskStore } from '../store';
import { DateTimeField, PriorityField, StatusField, TagsField } from './fields';
import { RepeatField } from './RepeatField';
import { useTextField } from './textField';
import { ListDot, TaskCheck, TaskTitle } from './parts';
import { listRoute, openListSource, openTaskDetail, useTaskUi } from './state';

function close(): void {
  useTaskUi.getState().closeDetail();
}

function Field({ label, children, id }: { label: string; children: React.ReactNode; id?: string }) {
  return (
    <div className="task-field">
      <span className="task-field-label" id={id}>
        {label}
      </span>
      <div className="task-field-control">{children}</div>
    </div>
  );
}

function RemindersField({ task, disabled }: { task: Task; disabled?: boolean }) {
  const today = useToday();
  const save = (reminders: TaskReminder[]) => void updateTask(task, { reminders }, { reminders: task.reminders });
  const add = (at: LocalDateTime) => {
    if (!task.reminders.some((r) => r.at === at)) save([...task.reminders, { at }]);
  };
  const custom = () => {
    const day = task.due ? datePart(task.due) : today;
    add(task.due && task.due.length > 10 ? task.due : `${day}T09:00`);
  };
  const presets = reminderPresets(task);
  return (
    <div className="task-reminders">
      {task.reminders.map((r, i) => (
        <div key={r.at} className="task-reminder">
          <input
            type="datetime-local"
            className="text-input"
            aria-label={`Reminder ${i + 1}`}
            value={r.at}
            disabled={disabled}
            onChange={(e) => {
              if (!e.target.value) return;
              const at = e.target.value.slice(0, 16);
              save(task.reminders.map((x, j) => (j === i ? { at } : x)).filter((x, j, all) => all.findIndex((y) => y.at === x.at) === j));
            }}
          />
          {!disabled && (
            <button type="button" className="icon-button" aria-label={`Remove reminder ${i + 1}`} onClick={() => save(task.reminders.filter((_, j) => j !== i))}>
              <X size={15} />
            </button>
          )}
        </div>
      ))}
      {!disabled && task.reminders.length < 20 && (
        <div className="task-reminder-add">
          <Bell size={14} aria-hidden />
          <select
            className="select"
            aria-label="Add reminder"
            value=""
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'custom') custom();
              else if (value) add(value);
            }}
          >
            <option value="">Add reminder…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.at}>
                {p.label} ({formatDateTime(p.at)})
              </option>
            ))}
            <option value="custom">Custom time…</option>
          </select>
        </div>
      )}
      <p className="task-field-note">
        Sent by the routes switched on in <a href="/settings/reminders" onClick={(e) => { e.preventDefault(); close(); navigateTo('/settings/reminders'); }}>Settings › Reminders</a>.
      </p>
    </div>
  );
}

function LinksField({ task, disabled }: { task: Task; disabled?: boolean }) {
  const tree = useTree().data;
  const [query, setQuery] = useState('');
  const listId = useId();
  const suggestions = useMemo(() => {
    if (!tree || query.trim() === '') return [];
    return fuzzyRank(query, tree.notes, [(n) => n.path], 8)
      .map((r) => r.item.path)
      .filter((p) => !task.links.includes(p));
  }, [tree, query, task.links]);
  const save = (links: string[]) => void updateTask(task, { links }, { links: task.links });
  return (
    <div className="task-links-field">
      <ul className="task-link-list">
        {task.links.map((p) => (
          <li key={p} className="task-link-item">
            <button
              type="button"
              className={`link-button task-link-open${tree?.byPath.has(p) ? '' : ' is-unresolved'}`}
              title={p}
              onClick={() => {
                close();
                openPath(p);
              }}
            >
              <FileText size={14} aria-hidden /> {displayName(p)}
            </button>
            {!disabled && (
              <button type="button" className="icon-button" aria-label={`Remove link to ${displayName(p)}`} onClick={() => save(task.links.filter((x) => x !== p))}>
                <X size={15} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && task.links.length < 50 && (
        <div className="task-link-add">
          <input
            className="text-input"
            aria-label="Link a note"
            placeholder="Link a note…"
            value={query}
            aria-controls={listId}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {suggestions.length > 0 && (
            <ul id={listId} className="task-link-suggestions" role="listbox" aria-label="Notes">
              {suggestions.map((p) => (
                <li key={p} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      save([...task.links, p]);
                      setQuery('');
                    }}
                  >
                    <FileText size={14} aria-hidden /> {p}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Notes: rendered Markdown (sanitized by the reading-view pipeline), a textarea while editing. */
function NotesField({ task, listPath, disabled }: { task: Task; listPath: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const field = useTextField(task, 'notes', { multiline: true, disabled });
  const area = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const tree = useTree().data;
  const settings = useVaultSettings();
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  const notes = task.notes ?? '';
  // Notes the server does not have yet stay in the textarea rather than the rendered view.
  const asText = editing || (!notes && !disabled) || field['data-unsaved'] === 'true';

  useLayoutEffect(() => {
    if (!area.current) return;
    autoGrow(area.current);
    if (editing && document.activeElement !== area.current) area.current.focus();
  }, [editing, field.value]);

  useLayoutEffect(() => {
    const el = preview.current;
    if (!el || !tree || asText) return;
    el.replaceChildren(renderNote(notes, makeRenderContext(listPath, tree, settings, loadRemoteImages)).fragment);
    for (const box of el.querySelectorAll('input')) box.disabled = true;
  }, [notes, tree, settings, loadRemoteImages, listPath, asText]);

  if (asText) {
    return (
      <textarea
        ref={area}
        className="text-input task-notes-input"
        aria-label="Notes"
        placeholder="Notes (Markdown)"
        rows={editing ? 4 : 2}
        {...field}
        onFocus={() => {
          field.onFocus();
          setEditing(true);
        }}
        onBlur={() => {
          field.onBlur();
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      ref={preview}
      className="markdown-rendered task-notes-preview"
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? undefined : 0}
      aria-label={disabled ? undefined : 'Edit notes'}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          setEditing(true);
        }
      }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const link = target.closest<HTMLAnchorElement>('a.internal-link');
        if (link) {
          e.preventDefault();
          const href = link.dataset.href ?? '';
          const hash = href.indexOf('#');
          close();
          void openLink(hash < 0 ? href : href.slice(0, hash), hash < 0 ? null : href.slice(hash + 1), listPath);
          return;
        }
        const tag = target.closest<HTMLAnchorElement>('a.tag');
        if (tag) {
          e.preventDefault();
          close();
          openTag(tag.dataset.tag ?? '');
          return;
        }
        if (target.closest('a')) return;
        if (!disabled) setEditing(true);
      }}
    />
  );
}

function SubtasksField({ task, tasks, readOnly }: { task: Task; tasks: ReadonlyMap<string, Task>; readOnly: boolean }) {
  const [title, setTitle] = useState('');
  const children = useMemo(() => childrenByParent([...tasks.values()].filter((t) => t.listId === task.listId && !t.archived)), [tasks, task.listId]);
  const kids = children.get(task.id) ?? [];
  const canAdd = !readOnly && !task.archived && depthOf(task, tasks) < MAX_DEPTH;
  const list = taskStore.list(task.listId);
  return (
    <div className="task-subtasks">
      {kids.length > 0 && (
        <ul className="task-list task-subtask-list">
          {kids.map((k) => (
            <li key={k.id} className={`task-row is-compact${isClosed(k) ? ' is-closed' : ''}`}>
              <TaskCheck task={k} />
              <div className="task-row-body" onClick={() => !isPending(k) && openTaskDetail(k.id)}>
                <span className="task-title">
                  <TaskTitle task={k} listPath={list?.path ?? ''} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <form
          className="task-subtask-add"
          onSubmit={(e) => {
            e.preventDefault();
            const t = title.replace(/\s+/g, ' ').trim();
            if (!t) return;
            setTitle('');
            void createTask({ title: t, parentId: task.id });
          }}
        >
          <Plus size={15} aria-hidden />
          <input className="text-input" aria-label="Add subtask" placeholder="Add subtask…" value={title} onChange={(e) => setTitle(e.target.value)} enterKeyHint="done" />
        </form>
      )}
    </div>
  );
}

function ListField({ task, lists, disabled }: { task: Task; lists: TaskList[]; disabled?: boolean }) {
  const list = lists.find((l) => l.id === task.listId);
  const sections = list?.sections ?? [];
  return (
    <div className="task-list-field">
      <select
        className="select"
        aria-label="List"
        value={task.listId}
        disabled={disabled}
        onChange={(e) => void updateTask(task, { listId: e.target.value }, { listId: task.listId })}
      >
        {lists
          .filter((l) => l.id === task.listId || (l.writable && !l.archived))
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
      </select>
      {task.parentId === null && sections.length > 0 && (
        <select
          className="select"
          aria-label="Section"
          value={task.sectionId ?? ''}
          disabled={disabled}
          onChange={(e) => void updateTask(task, { sectionId: e.target.value || null }, { sectionId: task.sectionId })}
        >
          <option value="">No section</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function useTask(id: string): { task: Task | undefined; missing: boolean } {
  useTaskStore();
  const known = taskStore.task(id);
  const fetched = useTaskById(id, known !== undefined);
  return { task: known, missing: known === undefined && fetched.data === false };
}

export default function TaskDetail({ id }: { id: string }) {
  const { task, missing } = useTask(id);
  useTaskStore();
  const tasks = taskStore.tasks();
  const lists = taskStore.lists();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const list = task ? taskStore.list(task.listId) : undefined;
  const readOnly = !task || isPending(task) || task.archived || list?.writable === false;
  const title = useTextField(task ?? PLACEHOLDER, 'title', { disabled: readOnly });

  useLayoutEffect(() => {
    if (titleRef.current) autoGrow(titleRef.current);
  }, [title.value]);

  if (!task) {
    return (
      <Modal label="Task" onClose={close} variant="sheet" className="task-detail">
        <div className="dialog">
          <h2 className="dialog-title">{missing ? 'This task no longer exists' : 'Loading…'}</h2>
          {missing && <p className="dialog-message">It was deleted, perhaps on another device. The list’s history keeps a copy.</p>}
          <div className="dialog-actions">
            <button type="button" className="button" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const parent = task.parentId ? tasks.get(task.parentId) : undefined;
  const section = task.sectionId && list ? list.sections.find((s) => s.id === task.sectionId) : undefined;
  const openList = () => {
    close();
    useUi.getState().setDrawerOpen(false);
    navigateTo(listRoute(task.listId));
  };

  return (
    <Modal label={`Task: ${task.title}`} onClose={close} variant="sheet" className="task-detail">
      <div className="task-detail-head">
        <TaskCheck task={task} />
        <textarea ref={titleRef} className="task-detail-title" aria-label="Title" rows={1} maxLength={500} {...title} readOnly={readOnly} />
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="task-detail-body">
        <nav className="task-breadcrumb" aria-label="Where">
          <button type="button" className="link-button" onClick={openList}>
            <ListDot list={list} /> {list?.name ?? 'List'}
          </button>
          {section && <span> › {section.name}</span>}
          {parent && (
            <span>
              {' › '}
              <button type="button" className="link-button" onClick={() => openTaskDetail(parent.id)}>
                {parent.title}
              </button>
            </span>
          )}
        </nav>
        {list?.writable === false && <p className="field-warning">This list was written by a newer version of NotesApp and is read-only here.</p>}
        {task.archived && <p className="field-warning">This task is archived. Reopen it to change it.</p>}
        {/[[#]/.test(task.title) && (
          <p className="task-title-preview">
            <TaskTitle task={task} listPath={list?.path ?? ''} />
          </p>
        )}

        <Field label="Status">
          <StatusField task={task} disabled={readOnly} />
        </Field>
        <Field label="Due">
          <DateTimeField task={task} field="due" label="Due" disabled={readOnly} />
        </Field>
        <Field label="Start">
          <DateTimeField task={task} field="start" label="Start" disabled={readOnly} />
        </Field>
        <Field label="Priority">
          <PriorityField task={task} disabled={readOnly} />
        </Field>
        <Field label="Repeat">
          <RepeatField task={task} disabled={readOnly} />
        </Field>
        <Field label="Reminders">
          <RemindersField task={task} disabled={readOnly} />
        </Field>
        <Field label="Tags">
          <TagsField task={task} disabled={readOnly} />
        </Field>
        <Field label="Related notes">
          <LinksField task={task} disabled={readOnly} />
        </Field>
        <Field label="List">
          <ListField task={task} lists={lists} disabled={readOnly} />
        </Field>
        <div className="task-field task-field-wide">
          <span className="task-field-label">Notes</span>
          <NotesField task={task} listPath={list?.path ?? ''} disabled={readOnly} />
        </div>
        <div className="task-field task-field-wide">
          <span className="task-field-label">Subtasks</span>
          <SubtasksField task={task} tasks={tasks} readOnly={readOnly} />
        </div>
      </div>
      <footer className="task-detail-foot">
        <span className="task-detail-dates">
          {task.createdAt && <span title={formatDateTime(task.createdAt)}>Created {formatDateTime(task.createdAt)}</span>}
          {task.completedAt && <span> · {task.status === 'cancelled' ? 'Cancelled' : 'Completed'} {formatDateTime(task.completedAt)}</span>}
        </span>
        <span className="task-detail-actions">
          {list && (
            <button
              type="button"
              className="icon-button"
              aria-label="Open the list file (JSON)"
              title={`Open ${list.path}`}
              onClick={() => {
                close();
                openListSource(list.path);
              }}
            >
              <ExternalLink size={16} />
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="button button-danger button-small"
              onClick={() => {
                void deleteTask(task).then((deleted) => deleted && close());
              }}
            >
              <Trash2 size={14} aria-hidden /> Delete
            </button>
          )}
        </span>
      </footer>
    </Modal>
  );
}

/** Stands in for a task that has not loaded yet (hooks run before the early return). */
const PLACEHOLDER: Task = {
  id: '',
  listId: '',
  sectionId: null,
  parentId: null,
  title: '',
  notes: null,
  status: 'open',
  priority: 0,
  due: null,
  start: null,
  recurrence: null,
  reminders: [],
  tags: [],
  links: [],
  order: 'a0',
  createdAt: null,
  updatedAt: null,
  completedAt: null,
  archived: false,
};
