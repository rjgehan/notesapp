// A new habit, or a habit's settings (DESIGN §6.35). The form writes the habit note's frontmatter;
// everything else in the note stays as it is.
import { useId, useState } from 'react';
import { DAY_ORDER, EVERY_DAY, propertyKey, scheduleValue, type Habit, type Schedule } from '../model';
import { HABIT_COLORS, habitColor } from '../colors';
import { createHabit, habitFileName, updateHabit, type HabitFields } from '../actions';
import { newNameError } from '../../features/paths';
import type { PropertyValue } from '../frontmatterEdit';

type Mode = 'daily' | 'weekdays' | 'weekends' | 'days' | 'weekly';

const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function modeOf(s: Schedule): Mode {
  if (s.kind === 'weekly') return 'weekly';
  const v = scheduleValue(s);
  return v === 'daily' || v === 'weekdays' || v === 'weekends' ? v : 'days';
}

function scheduleOf(mode: Mode, days: number[], times: number): Schedule {
  switch (mode) {
    case 'daily':
      return EVERY_DAY;
    case 'weekdays':
      return { kind: 'days', days: [1, 2, 3, 4, 5] };
    case 'weekends':
      return { kind: 'days', days: [0, 6] };
    case 'weekly':
      return { kind: 'weekly', times };
    default:
      return days.length ? { kind: 'days', days: [...days].sort((a, b) => a - b) } : EVERY_DAY;
  }
}

export function HabitForm({ habit, folder, today, onDone }: { habit: Habit | null; folder: string; today: string; onDone(path: string | null): void }) {
  const id = useId();
  const [name, setName] = useState(habit?.name ?? '');
  const [mode, setMode] = useState<Mode>(habit ? modeOf(habit.schedule) : 'daily');
  const [days, setDays] = useState<number[]>(habit?.schedule.kind === 'days' ? habit.schedule.days : [1, 3, 5]);
  const [times, setTimes] = useState(habit?.schedule.kind === 'weekly' ? habit.schedule.times : 3);
  const [color, setColor] = useState<string | null>(habit?.color ?? null);
  const [property, setProperty] = useState(habit?.property ?? '');
  const [maxGap, setMaxGap] = useState(habit?.maxGap ?? 0);
  const [archived, setArchived] = useState(habit?.archived ?? false);
  const [saving, setSaving] = useState(false);

  const fileName = habitFileName(name);
  const nameError = !habit && name.trim() !== '' ? (fileName ? newNameError(fileName + '.md') : 'Use letters or digits in the name.') : null;
  const defaultProperty = propertyKey(habit ? habit.path.slice(habit.path.lastIndexOf('/') + 1, -3) : fileName || name);
  const schedule = scheduleOf(mode, days, times);
  const valid = name.trim() !== '' && nameError === null && (mode !== 'days' || days.length > 0);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const fields: HabitFields = { name: name.trim(), schedule, color, property: property.trim() || defaultProperty, maxGap };
    if (!habit) {
      const path = await createHabit(folder, fields, today);
      setSaving(false);
      if (path) onDone(path);
      return;
    }
    const changes: Record<string, PropertyValue | null> = {};
    const baseName = habit.path.slice(habit.path.lastIndexOf('/') + 1, -3);
    if (fields.name !== habit.name) changes.title = fields.name === baseName ? null : fields.name;
    if (scheduleValue(schedule) !== scheduleValue(habit.schedule)) changes.schedule = scheduleValue(schedule);
    if (color !== habit.color) changes.color = color;
    if (fields.property !== habit.property) changes.property = fields.property === defaultProperty ? null : fields.property;
    if (maxGap !== habit.maxGap) changes.maxGap = maxGap > 0 ? maxGap : null;
    if (archived !== habit.archived) changes.archived = archived ? true : null;
    const ok = Object.keys(changes).length === 0 || (await updateHabit(habit, changes));
    setSaving(false);
    if (ok) onDone(habit.path);
  };

  return (
    <form
      className="hb-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="hb-field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} className="text-input" value={name} placeholder="Exercise" autoFocus={!habit} onChange={(e) => setName(e.target.value)} aria-invalid={nameError !== null} />
        {nameError && <p className="hb-error">{nameError}</p>}
        {!habit && fileName && !nameError && <p className="hb-hint">Saved as {folder ? `${folder}/` : ''}{fileName}.md</p>}
      </div>

      <fieldset className="hb-field">
        <legend>How often</legend>
        <div className="hb-segments" role="radiogroup">
          {(
            [
              ['daily', 'Every day'],
              ['weekdays', 'Weekdays'],
              ['weekends', 'Weekends'],
              ['days', 'Chosen days'],
              ['weekly', 'Times a week'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={`hb-segment${mode === m ? ' is-selected' : ''}`} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'days' && (
          <div className="hb-weekdays" role="group" aria-label="Days">
            {DAY_ORDER.map((d) => (
              <button
                key={d}
                type="button"
                className={`hb-weekday${days.includes(d) ? ' is-selected' : ''}`}
                aria-pressed={days.includes(d)}
                aria-label={DAY_NAMES[d]}
                onClick={() => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]))}
              >
                {DAY_SHORT[d]}
              </button>
            ))}
          </div>
        )}
        {mode === 'weekly' && (
          <div className="hb-times">
            <label htmlFor={`${id}-times`}>Times a week</label>
            <input id={`${id}-times`} className="text-input" type="number" inputMode="numeric" min={1} max={7} value={times} onChange={(e) => setTimes(Math.min(7, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
        )}
      </fieldset>

      <fieldset className="hb-field">
        <legend>Colour</legend>
        <div className="hb-swatches" role="radiogroup">
          <button type="button" role="radio" aria-checked={color === null} className={`hb-swatch is-auto${color === null ? ' is-selected' : ''}`} aria-label="Automatic" title="Automatic" onClick={() => setColor(null)} style={{ background: habit ? habitColor({ color: null, path: habit.path }) : undefined }}>
            A
          </button>
          {HABIT_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} className={`hb-swatch${color === c ? ' is-selected' : ''}`} aria-label={c} title={c} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </fieldset>

      <div className="hb-field">
        <label htmlFor={`${id}-property`}>Daily-note property</label>
        <input id={`${id}-property`} className="text-input" value={property === defaultProperty ? '' : property} placeholder={defaultProperty} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setProperty(e.target.value)} />
        <p className="hb-hint">
          A daily note with <code>{(property.trim() || defaultProperty) + ': true'}</code> in its properties checks this habit in too.
        </p>
      </div>

      <div className="hb-field">
        <label htmlFor={`${id}-gap`}>Missed days a streak survives</label>
        <input id={`${id}-gap`} className="text-input hb-narrow" type="number" inputMode="numeric" min={0} max={30} value={maxGap} onChange={(e) => setMaxGap(Math.min(30, Math.max(0, Number(e.target.value) || 0)))} />
      </div>

      {habit && (
        <label className="hb-check-label">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived (kept, but not in the list)
        </label>
      )}

      <div className="hb-form-actions">
        <button type="button" className="button" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={!valid || saving}>
          {saving ? 'Saving…' : habit ? 'Save' : 'Create habit'}
        </button>
      </div>
    </form>
  );
}
