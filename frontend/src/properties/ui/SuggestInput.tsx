// A text field with a suggestion list (ROADMAP item 13): `[[` note completion, a property's
// values, tags, property names. Arrow keys move through the list, Enter or Tab picks, Escape
// closes it (a second Escape cancels the edit). Picking with the mouse or a tap keeps the focus.
import { useId, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import type { Suggestion } from '../links';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onKeyDown' | 'onBlur'>;

export interface SuggestInputProps extends InputProps {
  value: string;
  onValueChange(value: string): void;
  /** Enter (with no suggestion chosen) or leaving the field. */
  onCommit(value: string, how: 'enter' | 'blur'): void;
  /** Escape with no list open. */
  onCancel?(): void;
  suggest?(text: string, caret: number): Suggestion[];
  /** Keys before the field's own handling; true when handled. */
  onKey?(e: KeyboardEvent<HTMLInputElement>): boolean;
}

export function SuggestInput({ value, onValueChange, onCommit, onCancel, suggest, onKey, className, ...rest }: SuggestInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const items = useMemo(() => (focused && !dismissed && suggest ? suggest(value, caret) : []), [focused, dismissed, suggest, value, caret]);
  const open = items.length > 0;
  const index = Math.min(active, items.length - 1);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && input.current) {
      input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const pick = (item: Suggestion) => {
    const next = item.apply(value, input.current?.selectionStart ?? caret);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    setActive(0);
    onValueChange(next.text);
    if (item.commit) onCommit(next.text, 'enter');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (onKey?.(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit(value, 'enter');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    }
  };

  return (
    <span className={`property-suggest${className ? ' ' + className : ''}`}>
      <input
        ref={input}
        {...rest}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete={suggest ? 'list' : undefined}
        aria-activedescendant={open ? `${listId}-${index}` : undefined}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setDismissed(false);
          setActive(0);
          onValueChange(e.target.value);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
          onCommit(value, 'blur');
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="property-suggestions" role="listbox" id={listId}>
          {items.map((item, i) => (
            <li
              key={`${item.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'is-active' : undefined}
              // Keeps the focus in the field (a blur would commit what is typed so far).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(item)}
            >
              <span className="property-suggestion-label">{item.label}</span>
              {item.detail && <span className="property-suggestion-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
