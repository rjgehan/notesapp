// The quick-add dialog (ROADMAP item 4): one line, parsed as you type into chips (date, repeat,
// priority, tags, list, links) that can be dismissed before saving. Bundled eagerly so the field
// takes focus inside the key press or tap that opened it (iOS shows the keyboard only then); the
// parser, with chrono-node and rrule, is a lazy chunk loaded as the dialog opens.
import { AtSign, CalendarDays, CornerDownRight, Flag, Hash, Link2, ListPlus, Repeat, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isTransient } from '../../api/client';
import type { CreateTaskRequest } from '../../api/types';
import { Modal } from '../../components/overlays/Modal';
import { displayName } from '../../features/paths';
import { formatTaskDate, localToday } from '../dates';
import { PRIORITY_NAMES } from '../model';
import { createList, createTask, inboxList } from '../mutations';
import { ensureLists } from '../queries';
import { taskStore, useTaskStore } from '../store';
import { openQuickAdd, useTaskUi, type QuickAddContext } from '../ui/state';
import { loadParser, type ParserModule } from './loadParser';

function useParser(): ParserModule | null {
  const [parser, setParser] = useState<ParserModule | null>(null);
  useEffect(() => {
    let live = true;
    loadParser().then(
      (m) => live && setParser(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return parser;
}

interface Chip {
  key: string;
  icon: ReactNode;
  label: string;
  title?: string;
  /** Dismissal; absent for chips that cannot be dropped. */
  dismiss?: () => void;
}

const EXAMPLE = 'Pay rent tomorrow 9am every month !high #home @Bills [[Apartment]]';

export function QuickAddDialog({ context }: { context: QuickAddContext }) {
  const [text, setText] = useState(context.text ?? '');
  const [ignore, setIgnore] = useState<ReadonlySet<string>>(() => new Set());
  const [dropped, setDropped] = useState<ReadonlySet<'due' | 'links'>>(() => new Set());
  const [now] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const parser = useParser();
  const version = useTaskStore();
  const close = () => useTaskUi.getState().closeQuickAdd();

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    void ensureLists().catch(() => undefined);
  }, []);

  const lists = useMemo(() => (version >= 0 ? taskStore.lists() : []), [version]);
  const parent = context.parentId ? taskStore.task(context.parentId) : undefined;
  const parsed = useMemo(
    () => (parser ? parser.parseQuickAdd(text, { now, lists, ignore, noList: context.parentId !== undefined }) : null),
    [parser, text, now, lists, ignore, context.parentId],
  );

  const contextList = context.listId ? lists.find((l) => l.id === context.listId) : parent ? lists.find((l) => l.id === parent.listId) : undefined;
  const links = context.links && !dropped.has('links') ? context.links : [];
  const title = parsed ? parsed.title : text.trim();
  const today = localToday(now);

  const dismiss = (key: string) => () => setIgnore((s) => new Set([...s, key]));
  const chips: Chip[] = [];
  if (parent) chips.push({ key: 'parent', icon: <CornerDownRight size={13} />, label: `Subtask of ${parent.title}` });
  for (const part of parsed?.parts ?? []) {
    switch (part.kind) {
      case 'due':
        chips.push({ key: part.key, icon: <CalendarDays size={13} />, label: parsed!.due ? formatTaskDate(parsed!.due, today) : part.text, title: part.text, dismiss: dismiss(part.key) });
        break;
      case 'recurrence':
        chips.push({ key: part.key, icon: <Repeat size={13} />, label: parser!.ruleText(parsed!.recurrence!.rrule), title: part.text, dismiss: dismiss(part.key) });
        break;
      case 'priority':
        chips.push({ key: part.key, icon: <Flag size={13} />, label: `${PRIORITY_NAMES[parsed!.priority ?? 0]} priority`, title: part.text, dismiss: dismiss(part.key) });
        break;
      case 'tag':
        chips.push({ key: part.key, icon: <Hash size={13} />, label: part.text.slice(1), dismiss: dismiss(part.key) });
        break;
      case 'list':
        chips.push({
          key: part.key,
          icon: parsed!.list?.id ? <AtSign size={13} /> : <ListPlus size={13} />,
          label: parsed!.list?.id ? parsed!.list.name : `New list “${parsed!.list?.name}”`,
          dismiss: dismiss(part.key),
        });
        break;
      case 'link':
        chips.push({ key: part.key, icon: <Link2 size={13} />, label: part.text.slice(2, -2), title: 'Stays in the title as a link' });
        break;
    }
  }
  if (parsed?.dueImplied && parsed.due) {
    chips.push({ key: 'implied', icon: <CalendarDays size={13} />, label: `${formatTaskDate(parsed.due, today)} (first)`, dismiss: dismiss(parser!.IMPLIED_DUE) });
  }
  if (!parsed?.due && context.due && !dropped.has('due')) {
    chips.push({ key: 'ctx-due', icon: <CalendarDays size={13} />, label: formatTaskDate(context.due, today), dismiss: () => setDropped((s) => new Set([...s, 'due'])) });
  }
  if (links.length) {
    chips.push({ key: 'ctx-links', icon: <Link2 size={13} />, label: `Linked to ${links.map(displayName).join(', ')}`, dismiss: () => setDropped((s) => new Set([...s, 'links'])) });
  }
  const target = parsed?.list ? null : (contextList ?? (!parent ? inboxList() : undefined));
  const section = target && context.sectionId && target.id === context.listId ? target.sections.find((s) => s.id === context.sectionId) : undefined;
  const where = parsed?.list || parent ? null : target ? target.name + (section ? ` › ${section.name}` : '') : 'Inbox';

  const submit = async () => {
    if (busy) return;
    const p = parsed ?? (await loadParser()).parseQuickAdd(text, { now, lists, ignore, noList: context.parentId !== undefined });
    if (p.title === '') return;
    let listId = p.list?.id ?? (p.list ? null : context.listId);
    if (p.list && p.list.id === null) {
      setBusy(true);
      const created = await createList(p.list.name);
      setBusy(false);
      // The list could not be created: the dialog stays open with the text.
      if (!created) return;
      listId = created.id;
    }
    const req: CreateTaskRequest = { title: p.title };
    if (context.parentId) req.parentId = context.parentId;
    else if (listId) req.listId = listId;
    if (!context.parentId && listId && listId === context.listId && context.sectionId) req.sectionId = context.sectionId;
    const dueValue = p.due ?? (context.due && !dropped.has('due') ? context.due : null);
    if (dueValue) req.due = dueValue;
    if (p.recurrence) req.recurrence = p.recurrence;
    if (p.priority !== null) req.priority = p.priority;
    if (p.tags.length) req.tags = p.tags;
    if (links.length) req.links = links;
    const typed = text;
    close();
    // The dialog closes at once; a failed save other than going offline (which offers Retry)
    // gives the typed text back, so nothing typed is lost.
    void createTask(req, taskStore, (e) => {
      if (!isTransient(e)) openQuickAdd({ ...context, text: typed });
    });
  };

  return (
    <Modal label="Add task" onClose={close} className="quick-add" describedBy={hintId}>
      <form
        className="quick-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="quick-add-row">
          <input
            ref={input}
            className="quick-add-input"
            aria-label="Task"
            placeholder="Add a task…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            autoCapitalize="sentences"
            spellCheck
            enterKeyHint="done"
          />
          <button type="submit" className="button button-primary" disabled={busy || title === ''}>
            Add
          </button>
        </div>
        {chips.length > 0 && (
          <ul className="quick-add-chips" aria-label="Recognized">
            {chips.map((c) => (
              <li key={c.key} className="task-chip" title={c.title}>
                <span className="task-chip-icon" aria-hidden>
                  {c.icon}
                </span>
                <span className="task-chip-label">{c.label}</span>
                {c.dismiss && (
                  <button type="button" className="task-chip-dismiss" aria-label={`Keep “${c.title ?? c.label}” as text`} title="Keep as text" onClick={c.dismiss}>
                    <X size={12} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p id={hintId} className="quick-add-hint">
          {where && <span className="quick-add-where">Adds to {where}. </span>}
          Try “{EXAMPLE}”.
        </p>
      </form>
    </Modal>
  );
}
