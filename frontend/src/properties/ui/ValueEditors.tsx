// The value editors of the Properties editor (ROADMAP item 13, DESIGN §6.41), one per type. Each
// commits a typed value (`EditValue`) when you are done with it: text and numbers on Enter or when
// the field loses the focus, a checkbox, a date or a list item at once. A value that does not fit
// its type is shown as written, with a warning, and edited as YAML.
import { AlertTriangle, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useTags } from '../../api/hooks';
import type { PropertyType } from '../../api/types';
import { openTag } from '../../features/navigation';
import { TextWithLinks } from '../../views/markdown/PropertiesTable';
import { usePropertyValues } from '../api';
import { linkSuggestions, stringSuggestions, type Suggestion } from '../links';
import { cleanTag, DATE, fits, listItems, TYPE_LABELS } from '../model';
import type { EditValue } from '../yamlEdit';
import { SuggestInput } from './SuggestInput';

export interface ValueEditorProps {
  name: string;
  type: PropertyType;
  value: unknown;
  sourcePath: string;
  onCommit(value: EditValue): void;
  /** Shows the YAML for editing (a value that does not fit its type). */
  onEditYaml?: (() => void) | null;
}

/** Link completion first, then the property's values across the vault. */
function useSuggest(name: string, sourcePath: string, wanted: boolean, exclude: readonly string[] = [], commit = false) {
  const values = usePropertyValues(name, wanted).data?.values;
  return (text: string, caret: number): Suggestion[] => {
    const links = linkSuggestions(text, caret, sourcePath);
    if (links.length) return links;
    const options = (values ?? []).map((v) => v.value).filter((v) => !exclude.includes(v));
    return stringSuggestions(options, text, 8, commit);
  };
}

function TextValue({ name, value, sourcePath, onCommit }: ValueEditorProps) {
  const text = value === null || value === undefined ? '' : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const [focusNext, setFocusNext] = useState(false);
  const suggest = useSuggest(name, sourcePath, draft !== null);
  if (draft === null && text.includes('[[')) {
    // Links show as links until you edit the text (a click beside them, or Enter).
    return (
      <div
        className="property-text is-rendered"
        tabIndex={0}
        role="button"
        aria-label={`Edit ${name}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) return;
          setDraft(text);
          setFocusNext(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setDraft(text);
            setFocusNext(true);
          }
        }}
      >
        <TextWithLinks text={text} sourcePath={sourcePath} />
      </div>
    );
  }
  return (
    <SuggestInput
      className="property-text"
      aria-label={name}
      placeholder="Empty"
      enterKeyHint="done"
      autoFocus={focusNext}
      value={draft ?? text}
      suggest={draft !== null ? suggest : undefined}
      onFocus={() => {
        setFocusNext(false);
        if (draft === null) setDraft(text);
      }}
      onValueChange={setDraft}
      onCommit={(v, how) => {
        setDraft(null);
        if (v !== text) onCommit(v === '' ? null : v);
        if (how === 'enter') (document.activeElement as HTMLElement | null)?.blur();
      }}
      onCancel={() => {
        setDraft(null);
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    />
  );
}

function NumberValue({ name, value, onCommit }: ValueEditorProps) {
  const text = typeof value === 'number' ? String(value) : '';
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (v: string) => {
    setDraft(null);
    const trimmed = v.trim();
    if (trimmed === text) return;
    if (trimmed === '') onCommit(null);
    else if (Number.isFinite(Number(trimmed))) onCommit(Number(trimmed));
  };
  return (
    <input
      className="property-number"
      aria-label={name}
      inputMode="decimal"
      enterKeyHint="done"
      placeholder="Empty"
      value={draft ?? text}
      aria-invalid={draft !== null && draft.trim() !== '' && !Number.isFinite(Number(draft.trim()))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function CheckboxValue({ name, value, onCommit }: ValueEditorProps) {
  return <input type="checkbox" className="property-checkbox" aria-label={name} checked={value === true} onChange={() => onCommit(!(value === true))} />;
}

function DateValue({ name, type, value, onCommit }: ValueEditorProps) {
  const text = typeof value === 'string' ? value : '';
  // datetime-local wants `YYYY-MM-DDTHH:mm`; a date alone shows at midnight until it is changed.
  const shown = type === 'datetime' ? (DATE.test(text) ? `${text}T00:00` : text.replace(' ', 'T')) : text;
  return (
    <input
      type={type === 'datetime' ? 'datetime-local' : 'date'}
      className="property-date"
      aria-label={name}
      value={shown}
      onChange={(e) => {
        const v = e.target.value;
        if (v !== shown) onCommit(v === '' ? null : v);
      }}
    />
  );
}

function ListValue({ name, type, value, sourcePath, onCommit }: ValueEditorProps) {
  const items = listItems(type, value);
  const [draft, setDraft] = useState('');
  const tags = useTags();
  const isTags = type === 'tags';
  const valueSuggest = useSuggest(name, sourcePath, !isTags && draft !== '', items, true);
  const suggest = isTags
    ? (text: string) => stringSuggestions((tags.data?.tags ?? []).map((t) => t.tag).filter((t) => !items.includes(t)), cleanTag(text), 8, true)
    : valueSuggest;

  const add = (text: string) => {
    setDraft('');
    const parts = isTags ? text.split(/[,\s]+/).map(cleanTag) : [text.trim()];
    const added = parts.filter((p) => p !== '' && !items.includes(p));
    if (added.length) onCommit([...items, ...added]);
  };
  const remove = (i: number) => {
    const next = items.filter((_, j) => j !== i);
    onCommit(next.length ? next : null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (e.key === 'Backspace' && draft === '' && items.length > 0) {
      e.preventDefault();
      remove(items.length - 1);
      return true;
    }
    if (isTags && (e.key === ',' || e.key === ' ') && draft.trim() !== '') {
      e.preventDefault();
      add(draft);
      return true;
    }
    return false;
  };

  return (
    <div className="property-list">
      {items.map((item, i) => (
        <span key={`${item}-${i}`} className={`property-chip${isTags ? ' is-tag' : ''}`}>
          {isTags ? (
            <a
              href="#"
              className="tag"
              onClick={(e) => {
                e.preventDefault();
                openTag(item);
              }}
            >
              #{item}
            </a>
          ) : (
            <span className="property-chip-text">
              <TextWithLinks text={item} sourcePath={sourcePath} />
            </span>
          )}
          <button type="button" className="property-chip-remove" aria-label={`Remove ${item}`} title="Remove" onClick={() => remove(i)}>
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <SuggestInput
        className="property-list-input"
        aria-label={`Add to ${name}`}
        placeholder={items.length ? '' : 'Empty'}
        enterKeyHint="enter"
        value={draft}
        suggest={suggest}
        onKey={onKey}
        onValueChange={(v) => {
          // Phone keyboards may send no key event for a comma: a typed separator adds the tag too.
          if (isTags && /[,\s]$/.test(v) && v.trim() !== '') add(v);
          else setDraft(v);
        }}
        onCommit={(v) => add(v)}
        onCancel={() => setDraft('')}
      />
    </div>
  );
}

/** A value that does not fit its type, shown as written. */
function Mismatch({ name, type, value, onEditYaml }: ValueEditorProps) {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <span className="property-mismatch" title={`Not a ${TYPE_LABELS[type].toLowerCase()} value; change the type or edit it as YAML`}>
      <AlertTriangle size={14} aria-hidden />
      <code>{shown}</code>
      {onEditYaml && (
        <button type="button" className="property-mismatch-edit" aria-label={`Edit ${name} as YAML`} onClick={onEditYaml}>
          Edit
        </button>
      )}
    </span>
  );
}

/** The editor for a property's type, or the value as written when it does not fit. */
export function ValueEditor(props: ValueEditorProps) {
  if (!fits(props.type, props.value)) return <Mismatch {...props} />;
  switch (props.type) {
    case 'text':
      return <TextValue {...props} />;
    case 'number':
      return <NumberValue {...props} />;
    case 'checkbox':
      return <CheckboxValue {...props} />;
    case 'date':
    case 'datetime':
      return <DateValue {...props} />;
    case 'multitext':
    case 'tags':
    case 'aliases':
      return <ListValue {...props} />;
  }
}
