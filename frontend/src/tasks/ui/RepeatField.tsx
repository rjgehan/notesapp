// The Repeat field of the detail sheet (ROADMAP item 4, "Recurrence"): common rules in a menu,
// and a rule editor for the others: the usual shapes as controls (every N days, weeks on chosen
// days, months on a day or "the second Tuesday", years; ending never, after N times or on a date),
// a rule typed in words (rrule's text parser), or a raw RRULE checked against the server's subset
// (API.md §20.6). Rules read as text through rrule's toText, with a preview of the next dates.
import { Pencil } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { LocalDate, Task } from '../../api/types';
import { datePart, formatTaskDate, useToday } from '../dates';
import { updateTask } from '../mutations';
import {
  defaultDraft,
  draftFromRule,
  recurrenceLabel,
  recurrencePresets,
  recurrenceText,
  ruleFromDraft,
  ruleFromText,
  upcomingOccurrences,
  validateRule,
  WEEKDAYS,
  type Freq,
  type RuleDraft,
  type Weekday,
} from '../recurrence';

const UNITS: Record<Freq, [string, string]> = { DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'] };
const DAY_NAMES: Record<Weekday, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const POSITIONS: Array<[number, string]> = [
  [1, 'first'],
  [2, 'second'],
  [3, 'third'],
  [4, 'fourth'],
  [-1, 'last'],
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Mode = 'simple' | 'words' | 'rrule';

/** The rule an editor state stands for, or the reason it cannot be set. */
function resultOf(mode: Mode, draft: RuleDraft, words: string, raw: string): { rrule: string } | { error: string } | null {
  if (mode === 'simple') {
    if (!Number.isInteger(draft.interval) || draft.interval < 1) return { error: 'Repeat every 1 or more' };
    if (draft.end === 'count' && (!Number.isInteger(draft.count) || draft.count < 1)) return { error: 'End after 1 or more times' };
    return validateRule(ruleFromDraft(draft));
  }
  if (mode === 'words') {
    if (words.trim() === '') return null;
    const rule = ruleFromText(words.trim().toLowerCase().startsWith('every') ? words : `every ${words}`);
    return rule ? validateRule(rule) : { error: 'Not a supported rule' };
  }
  return raw.trim() === '' ? null : validateRule(raw);
}

function NumberInput({ value, onChange, label, max }: { value: number; onChange(n: number): void; label: string; max: number }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      className="text-input task-rule-number"
      aria-label={label}
      min={1}
      max={max}
      value={Number.isNaN(value) ? '' : value}
      onChange={(e) => onChange(e.target.value === '' ? NaN : Math.floor(Number(e.target.value)))}
    />
  );
}

/** "On day 14" or "on the second Tuesday", for monthly and yearly rules. */
function MonthDayControls({ draft, set, name }: { draft: RuleDraft; set(patch: Partial<RuleDraft>): void; name: string }) {
  return (
    <div className="task-rule-choices" role="radiogroup" aria-label="On">
      <label className="task-rule-choice">
        <input type="radio" name={name} checked={draft.monthBy === 'day'} onChange={() => set({ monthBy: 'day' })} />
        <span>on day</span>
        <select className="select" aria-label="Day of the month" value={draft.monthDay} disabled={draft.monthBy !== 'day'} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          <option value={-1}>last</option>
        </select>
      </label>
      <label className="task-rule-choice">
        <input type="radio" name={name} checked={draft.monthBy === 'weekday'} onChange={() => set({ monthBy: 'weekday' })} />
        <span>on the</span>
        <select className="select" aria-label="Which week" value={draft.setPos} disabled={draft.monthBy !== 'weekday'} onChange={(e) => set({ setPos: Number(e.target.value) })}>
          {POSITIONS.map(([n, label]) => (
            <option key={n} value={n}>
              {label}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Weekday" value={draft.weekday} disabled={draft.monthBy !== 'weekday'} onChange={(e) => set({ weekday: e.target.value as Weekday })}>
          {WEEKDAYS.map((w) => (
            <option key={w} value={w}>
              {DAY_NAMES[w]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function SimpleEditor({ draft, set }: { draft: RuleDraft; set(patch: Partial<RuleDraft>): void }) {
  const name = useId();
  return (
    <div className="task-rule-simple">
      <div className="task-rule-row">
        <span>Every</span>
        <NumberInput value={draft.interval} onChange={(interval) => set({ interval })} label="Interval" max={99999} />
        <select className="select" aria-label="Unit" value={draft.freq} onChange={(e) => set({ freq: e.target.value as Freq })}>
          {(Object.keys(UNITS) as Freq[]).map((f) => (
            <option key={f} value={f}>
              {draft.interval === 1 ? UNITS[f][0] : UNITS[f][1]}
            </option>
          ))}
        </select>
      </div>
      {draft.freq === 'WEEKLY' && (
        <div className="task-rule-weekdays" role="group" aria-label="On these days">
          {WEEKDAYS.map((w) => {
            const on = draft.byDay.includes(w);
            return (
              <button
                key={w}
                type="button"
                className={`task-rule-day${on ? ' is-active' : ''}`}
                aria-pressed={on}
                aria-label={DAY_NAMES[w]}
                title={DAY_NAMES[w]}
                onClick={() => set({ byDay: on ? draft.byDay.filter((d) => d !== w) : [...draft.byDay, w] })}
              >
                {DAY_NAMES[w].slice(0, 2)}
              </button>
            );
          })}
        </div>
      )}
      {draft.freq === 'YEARLY' && (
        <div className="task-rule-row">
          <span>in</span>
          <select className="select" aria-label="Month" value={draft.month} onChange={(e) => set({ month: Number(e.target.value) })}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}
      {(draft.freq === 'MONTHLY' || draft.freq === 'YEARLY') && <MonthDayControls draft={draft} set={set} name={`${name}-on`} />}
      <div className="task-rule-choices" role="radiogroup" aria-label="Ends">
        <span className="task-rule-legend">Ends</span>
        <label className="task-rule-choice">
          <input type="radio" name={`${name}-end`} checked={draft.end === 'never'} onChange={() => set({ end: 'never' })} />
          <span>never</span>
        </label>
        <label className="task-rule-choice">
          <input type="radio" name={`${name}-end`} checked={draft.end === 'count'} onChange={() => set({ end: 'count' })} />
          <span>after</span>
          <NumberInput value={draft.count} onChange={(count) => set({ count, end: 'count' })} label="Times" max={99999} />
          <span>times</span>
        </label>
        <label className="task-rule-choice">
          <input type="radio" name={`${name}-end`} checked={draft.end === 'until'} onChange={() => set({ end: 'until' })} />
          <span>on</span>
          <input type="date" className="text-input" aria-label="End date" value={draft.until} onChange={(e) => e.target.value && set({ until: e.target.value, end: 'until' })} />
        </label>
      </div>
    </div>
  );
}

/** The rule editor: the common shapes as controls, a rule in words, or a raw RRULE. */
export function RuleEditor({ rrule, date, onSave, onCancel }: { rrule: string | null; date: LocalDate; onSave(rrule: string): void; onCancel(): void }) {
  const initialDraft = rrule ? draftFromRule(rrule, date) : defaultDraft(date);
  const [mode, setMode] = useState<Mode>(initialDraft ? 'simple' : 'rrule');
  const [draft, setDraft] = useState<RuleDraft>(initialDraft ?? defaultDraft(date));
  const [words, setWords] = useState('');
  const [raw, setRaw] = useState(rrule ?? '');
  const result = resultOf(mode, draft, words, raw);
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const switchTo = (next: Mode) => {
    // The rule carries over between the views where it can.
    const current = result && 'rrule' in result ? result.rrule : null;
    if (next === 'rrule' && current) setRaw(current);
    if (next === 'simple' && current) {
      const d = draftFromRule(current, date);
      if (d) setDraft(d);
    }
    setMode(next);
  };

  return (
    <form
      className="task-rule-editor"
      aria-label="Custom repeat"
      onSubmit={(e) => {
        e.preventDefault();
        if (result && 'rrule' in result) onSave(result.rrule);
      }}
    >
      <div className="segmented task-rule-modes" role="radiogroup" aria-label="Rule as">
        {(
          [
            ['simple', 'Choose'],
            ['words', 'In words'],
            ['rrule', 'RRULE'],
          ] as Array<[Mode, string]>
        ).map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-active' : ''} onClick={() => switchTo(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'simple' && <SimpleEditor draft={draft} set={set} />}
      {mode === 'words' && (
        <input
          className="text-input"
          aria-label="Repeat, in words"
          placeholder="every 2 weeks on monday and friday"
          value={words}
          onChange={(e) => setWords(e.target.value)}
          autoCapitalize="off"
          enterKeyHint="done"
          autoFocus
        />
      )}
      {mode === 'rrule' && (
        <input
          className="text-input task-rule-raw"
          aria-label="RRULE"
          placeholder="FREQ=MONTHLY;BYDAY=2TU"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      )}
      <p className={`task-rule-result${result && 'error' in result ? ' field-error' : ''}`} aria-live="polite">
        {result === null ? '' : 'error' in result ? result.error : recurrenceLabel(result.rrule)}
      </p>
      <div className="task-rule-actions">
        <button type="button" className="button button-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-small button-primary" disabled={!result || !('rrule' in result)}>
          Set
        </button>
      </div>
    </form>
  );
}

/** The next dates of a repeating task, as a short preview. */
function NextDates({ task }: { task: Task }) {
  const today = useToday();
  const anchor = task.due ?? task.start;
  const dates = useMemo(() => (task.recurrence ? upcomingOccurrences(task.recurrence.rrule, anchor, today) : []), [task.recurrence, anchor, today]);
  if (!task.recurrence || dates.length === 0) return null;
  return <p className="task-field-note">Then {dates.map((d) => formatTaskDate(d, today)).join(', ')}</p>;
}

export function RepeatField({ task, disabled }: { task: Task; disabled?: boolean }) {
  const today = useToday();
  const [editing, setEditing] = useState(false);
  const presets = recurrencePresets(task.due ?? task.start);
  const rrule = task.recurrence?.rrule ?? null;
  const preset = rrule === null ? 'none' : (presets.find((p) => p.rrule === rrule)?.id ?? 'current');
  const set = (next: Task['recurrence']) => void updateTask(task, { recurrence: next }, { recurrence: task.recurrence });
  const anchorDate = task.due ?? task.start;
  return (
    <div className="task-repeat-field">
      <select
        className="select"
        aria-label="Repeat"
        value={preset}
        disabled={disabled}
        onChange={(e) => {
          const id = e.target.value;
          if (id === 'custom') {
            setEditing(true);
            return;
          }
          setEditing(false);
          if (id === 'none') set(null);
          else if (id !== 'current') set({ rrule: presets.find((p) => p.id === id)!.rrule, from: task.recurrence?.from ?? 'due' });
        }}
      >
        <option value="none">Does not repeat</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {preset === 'current' && <option value="current">{recurrenceLabel(rrule!)}</option>}
        <option value="custom">Custom…</option>
      </select>
      {task.recurrence && !disabled && !editing && (
        <button type="button" className="icon-button" aria-label="Edit the rule" title="Edit the rule" onClick={() => setEditing(true)}>
          <Pencil size={15} />
        </button>
      )}
      {task.recurrence && (
        <select
          className="select"
          aria-label="Repeat from"
          value={task.recurrence.from}
          disabled={disabled}
          onChange={(e) => set({ rrule: task.recurrence!.rrule, from: e.target.value as 'due' | 'completion' })}
        >
          <option value="due">from the due date</option>
          <option value="completion">from completion</option>
        </select>
      )}
      {editing && !disabled && (
        <RuleEditor
          rrule={rrule}
          date={anchorDate ? datePart(anchorDate) : today}
          onCancel={() => setEditing(false)}
          onSave={(next) => {
            setEditing(false);
            set({ rrule: next, from: task.recurrence?.from ?? 'due' });
          }}
        />
      )}
      {task.recurrence && <span className="visually-hidden">Repeats {recurrenceText(task.recurrence.rrule)}</span>}
      <NextDates task={task} />
      {task.recurrence && !task.due && !task.start && <p className="field-warning">A repeating task counts from its due date: set one.</p>}
    </div>
  );
}
