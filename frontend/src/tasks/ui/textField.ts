// The text-field logic of the task editors (fields.tsx): drafts saved as per-field PATCHes.
//
// A draft is let go only once the server has the text. One save of a field is in flight at a
// time, always based on the value the server last confirmed, so a retry (or the toast's Retry)
// never conflicts with an earlier save that failed. A save that fails (offline, a conflict, a
// refused value) keeps the draft: the field goes on showing the text, marked unsaved, and sends
// it again on the next blur or pause in typing, and when the connection comes back. A field that
// goes away with its text unsaved (the sheet closed) keeps it for the next time it is opened.
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Task } from '../../api/types';
import { normalizeTag, tagBodyLength } from '../../features/syntax';
import { useUi } from '../../state/ui';
import { updateTask } from '../mutations';

/** Text saves after this long without typing (notes), besides on blur. */
const IDLE_SAVE_MS = 1500;

type TextFieldName = 'title' | 'notes';

interface Draft {
  /** The text as typed. */
  value: string;
  /** The value the server last confirmed: the `base` of the next save. */
  base: string;
  /** The value being saved now, or null. */
  sending: string | null;
  /** The last save failed: the text is not on the server. */
  failed: boolean;
}

/** Unsaved drafts of fields that went away, by `${task id}:${field}` (shown again when it reopens). */
const kept = new Map<string, Draft>();

const keyOf = (task: Task, field: TextFieldName) => `${task.id}:${field}`;

/** The text as it is saved: a title on one line, trimmed. */
function saved(field: TextFieldName, value: string): string {
  return field === 'title' ? value.replace(/\s+/g, ' ').trim() : value;
}

const toField = (field: TextFieldName, v: string) => (field === 'notes' && v.trim() === '' ? null : v);

/** Forgets the drafts of fields that went away (tests). */
export function resetKeptDrafts(): void {
  kept.clear();
}

/**
 * A text field bound to one task field: a draft while focused, saved on blur, Enter (single
 * line), after a pause in typing (multi-line), and when the field goes away mid-edit.
 */
export function useTextField(task: Task, field: TextFieldName, opts: { multiline?: boolean; disabled?: boolean } = {}) {
  const [draft, setDraftState] = useState<Draft | null>(() => kept.get(keyOf(task, field)) ?? null);
  const current = task[field] ?? '';
  // The latest task and draft, for the timers, the save callbacks and the unmount save.
  const draftRef = useRef(draft);
  const taskRef = useRef(task);
  const focused = useRef(false);
  const [isFocused, setFocused] = useState(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connection = useUi((s) => s.connection);
  useLayoutEffect(() => {
    taskRef.current = task;
  });

  const setDraft = (d: Draft | null) => {
    draftRef.current = d;
    if (mounted.current) setDraftState(d);
  };

  /** Sends the draft if the server does not have it yet; lets it go once it does and the field is left. */
  const flush = () => {
    const d = draftRef.current;
    const t = taskRef.current;
    // One save at a time: the one in flight sends the rest when it settles.
    if (!d || d.sending !== null) return;
    const key = keyOf(t, field);
    const value = saved(field, d.value);
    // The task went away meanwhile (deleted on another device): nothing to save it into.
    if (t.id === '') return;
    // A title cannot be empty: the edit is dropped.
    if (field === 'title' && value === '') {
      kept.delete(key);
      setDraft(focused.current ? { value: d.base, base: d.base, sending: null, failed: false } : null);
      return;
    }
    if (value === d.base) {
      kept.delete(key);
      setDraft(focused.current ? { ...d, failed: false } : null);
      return;
    }
    setDraft({ ...d, sending: value });
    void updateTask(t, { [field]: toField(field, value) }, { [field]: toField(field, d.base) }).then((result) => {
      const now = draftRef.current;
      if (!now) return;
      if (result) {
        draftRef.current = { ...now, base: value, sending: null, failed: false };
        if (!mounted.current) kept.delete(key);
        // Typed on meanwhile, or the field was left: send the rest, or let the draft go.
        if (!focused.current || !mounted.current) flush();
        else setDraft(draftRef.current);
        return;
      }
      const failed = { ...now, sending: null, failed: true };
      if (mounted.current) setDraft(failed);
      else {
        draftRef.current = failed;
        kept.set(key, failed);
      }
    });
  };

  // Saves a pending edit when the field unmounts (the sheet closed with Esc mid-typing).
  useEffect(() => {
    mounted.current = true;
    const pending = timer;
    // A draft kept from the last time this field was shown is sent again.
    if (draftRef.current && !focused.current) flush();
    return () => {
      if (pending.current) clearTimeout(pending.current);
      mounted.current = false;
      focused.current = false;
      const d = draftRef.current;
      if (!d) return;
      if (d.failed || d.sending !== null) kept.set(keyOf(taskRef.current, field), d);
      flush();
    };
    // flush reads refs only; it runs again for a new field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  // Back online: an unsaved draft is sent again (a focused field sends on blur).
  useEffect(() => {
    if (connection === 'live' && draftRef.current?.failed && !focused.current) flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  const unsaved = draft !== null && (draft.failed || (!isFocused && saved(field, draft.value) !== draft.base));

  return {
    value: draft?.value ?? current,
    disabled: opts.disabled,
    'data-unsaved': unsaved ? 'true' : undefined,
    title: unsaved ? 'Not saved yet: it is sent again when you leave the field or the connection is back' : undefined,
    onFocus: () => {
      focused.current = true;
      setFocused(true);
      if (!draftRef.current) setDraft({ value: current, base: current, sending: null, failed: false });
    },
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = opts.multiline ? e.target.value : e.target.value.replace(/[\r\n]+/g, ' ');
      const d = draftRef.current ?? { value: current, base: current, sending: null, failed: false };
      setDraft({ ...d, value });
      if (opts.multiline) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          flush();
        }, IDLE_SAVE_MS);
      }
    },
    onBlur: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      focused.current = false;
      setFocused(false);
      if (draftRef.current) flush();
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const d = draftRef.current;
      if (e.key === 'Escape' && d && (d.value !== d.base || d.failed)) {
        // In a row editor Esc drops the edit, and a second Esc closes the editor. (A modal sheet
        // takes Esc first and closes, which saves the edit like any other way of leaving it.)
        e.preventDefault();
        e.stopPropagation();
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        kept.delete(keyOf(taskRef.current, field));
        const value = d.sending ?? current;
        setDraft({ value, base: d.sending === null ? current : d.base, sending: d.sending, failed: false });
        return;
      }
      if (!opts.multiline && e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
  };
}

/** A tag as typed (with or without '#'), normalized, or null when it is not a valid tag (API.md §15.6). */
export function cleanTag(raw: string): string | null {
  const body = raw.trim().replace(/^#/, '');
  if (body === '' || tagBodyLength(body) !== body.replace(/\/+$/, '').length) return null;
  return normalizeTag(body);
}
