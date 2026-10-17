// Fuzzy picker shell shared by the quick switcher, the command palette and the template picker:
// an ARIA combobox over a listbox with aria-activedescendant (DESIGN §6.19). The input is focused
// synchronously in a layout effect, inside the gesture that opened it, so iOS shows the keyboard.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Modal } from './Modal';

export interface PickOptions {
  shift: boolean;
  viaKeyboard: boolean;
}

interface Props<T> {
  label: string;
  placeholder: string;
  query: string;
  onQuery(query: string): void;
  items: readonly T[];
  itemKey(item: T): string;
  renderItem(item: T): ReactNode;
  onPick(item: T, opts: PickOptions): void;
  onClose(): void;
  /** Extra keys (return true when handled), e.g. Shift-Enter to create. */
  onKey?(e: KeyboardEvent<HTMLInputElement>, active: T | undefined): boolean;
  empty?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Picker<T>({ label, placeholder, query, onQuery, items, itemKey, renderItem, onPick, onClose, onKey, empty, footer, className }: Props<T>) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [active, setActive] = useState(0);
  const [shownQuery, setShownQuery] = useState(query);
  if (shownQuery !== query) {
    // A new query starts at the best match.
    setShownQuery(query);
    setActive(0);
  }
  const index = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const activeItem = index >= 0 ? items[index] : undefined;
  const optionId = (i: number) => `${listId}-option-${i}`;

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (index < 0) return;
    list.current?.querySelector(`#${CSS.escape(optionId(index))}`)?.scrollIntoView({ block: 'nearest' });
  });

  const move = (delta: number) => {
    if (items.length === 0) return;
    setActive((index + delta + items.length) % items.length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (onKey?.(e, activeItem)) {
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'PageDown':
        move(Math.min(8, items.length - 1 - index) || 0);
        break;
      case 'PageUp':
        move(-Math.min(8, index) || 0);
        break;
      case 'Enter':
        if (activeItem !== undefined) onPick(activeItem, { shift: e.shiftKey, viaKeyboard: true });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <Modal label={label} onClose={onClose} variant="sheet" className={`picker${className ? ' ' + className : ''}`}>
      <div className="picker-input-row">
        <input
          ref={input}
          className="picker-input"
          role="combobox"
          aria-label={label}
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={index >= 0 ? optionId(index) : undefined}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <button type="button" className="picker-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div ref={list} id={listId} className="picker-list" role="listbox" aria-label={label}>
        {items.length === 0 && empty && <div className="picker-empty">{empty}</div>}
        {items.map((item, i) => (
          <div
            key={itemKey(item)}
            id={optionId(i)}
            role="option"
            aria-selected={i === index}
            className={`picker-item${i === index ? ' is-active' : ''}`}
            onPointerMove={() => i !== index && setActive(i)}
            // Keep the input focused (and the iOS keyboard up) while tapping an option.
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => onPick(item, { shift: e.shiftKey, viaKeyboard: false })}
          >
            {renderItem(item)}
          </div>
        ))}
      </div>
      {footer && <div className="picker-footer">{footer}</div>}
    </Modal>
  );
}
