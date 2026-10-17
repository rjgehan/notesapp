// The text-field logic of the task editors (fields.tsx): drafts saved as per-field PATCHes.
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Task } from '../../api/types';
import { normalizeTag, tagBodyLength } from '../../features/syntax';
import { updateTask } from '../mutations';

/** Text saves after this long without typing (notes), besides on blur. */
const IDLE_SAVE_MS = 1500;

interface Draft {
  value: string;
  /** The value the server had when this edit started (or when the last part of it was sent). */
  base: string;
}

/** Sends a draft if it differs from its base; returns the draft with the sent value as its new base. */
function sendDraft(task: Task, field: 'title' | 'notes', d: Draft): Draft {
  // The task went away meanwhile (deleted on another device): nothing to save it into.
  if (task.id === '') return d;
  const value = field === 'title' ? d.value.replace(/\s+/g, ' ').trim() : d.value;
  // A title cannot be empty: the edit is dropped.
  if (field === 'title' && value === '') return { value: d.base, base: d.base };
  if (value === d.base) return d;
  const toField = (v: string) => (field === 'notes' && v.trim() === '' ? null : v);
  void updateTask(task, { [field]: toField(value) }, { [field]: toField(d.base) });
  return { value: d.value, base: value };
}

/**
 * A text field bound to one task field: a draft while focused, saved on blur, Enter (single
 * line), after a pause in typing (multi-line), and when the field goes away mid-edit.
 */
export function useTextField(task: Task, field: 'title' | 'notes', opts: { multiline?: boolean; disabled?: boolean } = {}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = task[field] ?? '';
  // The latest task and draft, for the idle timer and the unmount save.
  const latest = useRef({ task, draft });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    latest.current = { task, draft };
  });

  // Saves a pending edit when the field unmounts (the sheet closed with Esc mid-typing).
  useEffect(() => {
    const state = latest;
    const pending = timer;
    return () => {
      if (pending.current) clearTimeout(pending.current);
      const { task: t, draft: d } = state.current;
      if (d) sendDraft(t, field, d);
    };
  }, [field]);

  return {
    value: draft?.value ?? current,
    disabled: opts.disabled,
    onFocus: () => setDraft((d) => d ?? { value: current, base: current }),
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = opts.multiline ? e.target.value : e.target.value.replace(/[\r\n]+/g, ' ');
      setDraft({ value, base: draft?.base ?? current });
      if (opts.multiline) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          const { task: t, draft: d } = latest.current;
          if (d) setDraft(sendDraft(t, field, d));
        }, IDLE_SAVE_MS);
      }
    },
    onBlur: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (draft) sendDraft(task, field, draft);
      latest.current = { task, draft: null };
      setDraft(null);
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape' && draft && draft.value !== draft.base) {
        // In a row editor Esc drops the edit, and a second Esc closes the editor. (A modal sheet
        // takes Esc first and closes, which saves the edit like any other way of leaving it.)
        e.preventDefault();
        e.stopPropagation();
        setDraft({ value: draft.base, base: draft.base });
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
