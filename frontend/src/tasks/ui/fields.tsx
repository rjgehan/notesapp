// Field editors shared by the inline row editor and the detail sheet. Each change is a PATCH of
// that one field with the value the user started from as its `base` (API.md §20.4), so an edit
// made meanwhile on another device is a conflict rather than silently overwritten. Text is kept
// as a local draft while it is being edited; the task underneath stays live.
import { Flag, X } from 'lucide-react';
import { useState } from 'react';
import type { Task, TaskDate, TaskPriority } from '../../api/types';
import { datePart, joinDate, timePart } from '../dates';
import { PRIORITY_NAMES } from '../model';
import { updateTask } from '../mutations';
import { cleanTag } from './textField';

/** A date with an optional time (`due` or `start`). */
export function DateTimeField({ task, field, label, disabled }: { task: Task; field: 'due' | 'start'; label: string; disabled?: boolean }) {
  const value = task[field];
  const date = value ? datePart(value) : '';
  const time = value ? (timePart(value) ?? '') : '';
  const set = (next: TaskDate | null) => void updateTask(task, { [field]: next }, { [field]: value });
  return (
    <div className="task-date-field" role="group" aria-label={label}>
      <input
        type="date"
        className="text-input task-date-input"
        aria-label={`${label} date`}
        value={date}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value) set(joinDate(e.target.value, time || null));
          else set(null);
        }}
      />
      <input
        type="time"
        className="text-input task-time-input"
        aria-label={`${label} time`}
        value={time}
        disabled={disabled || !date}
        onChange={(e) => date && set(joinDate(date, e.target.value || null))}
      />
      {value && !disabled && (
        <button type="button" className="icon-button" aria-label={`Clear ${label.toLowerCase()}`} title={`Clear ${label.toLowerCase()}`} onClick={() => set(null)}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export function PriorityField({ task, disabled }: { task: Task; disabled?: boolean }) {
  return (
    <div className="segmented task-priority-field" role="radiogroup" aria-label="Priority">
      {([0, 1, 2, 3] as TaskPriority[]).map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={task.priority === p}
          className={`${task.priority === p ? 'is-active' : ''} priority-${p}`}
          disabled={disabled}
          onClick={() => void updateTask(task, { priority: p }, { priority: task.priority })}
        >
          {p > 0 && <Flag size={13} aria-hidden />} {PRIORITY_NAMES[p]}
        </button>
      ))}
    </div>
  );
}

export function TagsField({ task, disabled }: { task: Task; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = (tags: string[]) => void updateTask(task, { tags }, { tags: task.tags });
  const add = () => {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...task.tags];
    for (const p of parts) {
      const tag = cleanTag(p);
      if (tag === null) {
        setError(`“${p}” is not a valid tag`);
        return;
      }
      if (!next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    setError(null);
    setText('');
    save(next);
  };
  return (
    <div className="task-tags-field">
      <ul className="task-chips">
        {task.tags.map((t) => (
          <li key={t} className="task-chip">
            <span className="task-chip-label">#{t}</span>
            {!disabled && (
              <button type="button" className="task-chip-dismiss" aria-label={`Remove tag ${t}`} onClick={() => save(task.tags.filter((x) => x !== t))}>
                <X size={12} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <input
          className="text-input task-tag-input"
          aria-label="Add tags"
          placeholder="Add tag…"
          value={text}
          aria-invalid={error !== null}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
