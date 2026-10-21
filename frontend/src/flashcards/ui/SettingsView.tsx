// Flashcard settings (API.md §34.5), kept in `.notesapp/srs.json` so every device studies the same
// way. Only the fields changed here are sent; a field left as it was keeps whatever another device
// set meanwhile.
import { useId, useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import type { FlashcardConfig, FlashcardsResponse } from '../../api/types';
import { toast } from '../../state/toasts';
import { flashcardApi } from '../api';
import { changedFields, configOf, draftOf, type Draft } from '../configForm';
import { flashcardKeys } from '../store';

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="fc-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="fc-field-hint">{hint}</p>}
    </div>
  );
}

export function SettingsView({ config, onDone }: { config: FlashcardConfig; onDone(): void }) {
  const [base] = useState(config);
  const [draft, setDraft] = useState(() => draftOf(config));
  const [saving, setSaving] = useState(false);
  const result = configOf(draft);
  const error = typeof result === 'string' ? result : null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (typeof result === 'string') return;
    const changes = changedFields(base, result);
    if (Object.keys(changes).length === 0) {
      onDone();
      return;
    }
    setSaving(true);
    try {
      const saved = await flashcardApi.config(changes);
      queryClient.setQueryData<FlashcardsResponse>(flashcardKeys.state, (data) => (data ? { ...data, config: saved } : data));
      void queryClient.invalidateQueries({ queryKey: flashcardKeys.notes });
      toast('Flashcard settings saved');
      onDone();
    } catch (e) {
      toast(errorMessage(e), { kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const text = (key: keyof Draft, opts: { inputMode?: 'numeric' | 'decimal' | 'text'; placeholder?: string } = {}) => (id: string) => (
    <input
      id={id}
      className="text-input"
      value={draft[key] as string}
      inputMode={opts.inputMode}
      placeholder={opts.placeholder}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={(e) => set(key, e.target.value as never)}
    />
  );

  return (
    <form
      className="fc-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section className="status-card">
        <h2 className="status-card-title">Where cards come from</h2>
        <Field label="Flashcard tags" hint="Notes with one of these tags (or a nested one, like #flashcards/spanish) hold cards. Nested tags are decks.">
          {text('tags', { placeholder: '#flashcards' })}
        </Field>
        <label className="fc-check">
          <input type="checkbox" checked={draft.foldersAsDecks} onChange={(e) => set('foldersAsDecks', e.target.checked)} />
          Use folders as decks (every note with cards counts, tagged or not)
        </label>
      </section>
      <section className="status-card">
        <h2 className="status-card-title">Daily limits</h2>
        <div className="fc-field-row">
          <Field label="New cards a day">{text('newPerDay', { inputMode: 'numeric' })}</Field>
          <Field label="Reviews a day">{text('reviewsPerDay', { inputMode: 'numeric' })}</Field>
          <Field label="A new day starts at" hint="Hour, 0–23">
            {text('dayStartsAt', { inputMode: 'numeric' })}
          </Field>
        </div>
      </section>
      <section className="status-card">
        <h2 className="status-card-title">Scheduling (FSRS)</h2>
        <div className="fc-field-row">
          <Field label="Desired retention (%)" hint="Higher means more reviews">
            {text('retention', { inputMode: 'numeric' })}
          </Field>
          <Field label="Maximum interval (days)">{text('maximumInterval', { inputMode: 'numeric' })}</Field>
        </div>
        <div className="fc-field-row">
          <Field label="Learning steps" hint="For example 1m 10m">
            {text('learningSteps')}
          </Field>
          <Field label="Relearning steps">{text('relearningSteps')}</Field>
        </div>
        <label className="fc-check">
          <input type="checkbox" checked={draft.fuzz} onChange={(e) => set('fuzz', e.target.checked)} />
          Spread due dates a little, so cards learned together come back on different days
        </label>
      </section>
      {error && (
        <p className="fc-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="fc-form-actions">
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving || error !== null}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
