// Choosing a list's color (API.md §20.5: `#rrggbb` or a lower-case color name), shown as its dot
// in the views. A palette readable on both themes, plus None; a color set by hand that is not in
// the palette is shown as the current one.
import { Check } from 'lucide-react';
import { Modal } from '../../components/overlays/Modal';
import { updateList } from '../mutations';
import { taskStore, useTaskStore } from '../store';
import { listColor } from './display';
import { useTaskUi } from './state';

const LIST_COLORS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'Red', value: '#e03131' },
  { name: 'Orange', value: '#e8590c' },
  { name: 'Yellow', value: '#f08c00' },
  { name: 'Green', value: '#2f9e44' },
  { name: 'Teal', value: '#0c8599' },
  { name: 'Blue', value: '#1971c2' },
  { name: 'Violet', value: '#7048e8' },
  { name: 'Pink', value: '#c2255c' },
  { name: 'Grey', value: '#868e96' },
];

export function ListColorDialog({ listId }: { listId: string }) {
  useTaskStore();
  const list = taskStore.list(listId);
  const close = () => useTaskUi.getState().closeListColor();
  if (!list) return null;
  const current = listColor(list)?.toLowerCase() ?? null;
  const choose = (color: string | null) => {
    close();
    if (color !== (list.color ?? null)) void updateList(list, { color });
  };
  const choices = [...LIST_COLORS];
  if (current && !choices.some((c) => c.value === current)) choices.push({ name: 'Current color', value: current });
  return (
    <Modal label={`Color of ${list.name}`} onClose={close}>
      <div className="dialog">
        <h2 className="dialog-title">Color of “{list.name}”</h2>
        <div className="task-color-choices" role="radiogroup" aria-label="Color">
          <button type="button" role="radio" aria-checked={current === null} aria-label="No color" title="No color" className="task-color-choice is-none" onClick={() => choose(null)}>
            {current === null && <Check size={14} aria-hidden />}
          </button>
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={current === c.value}
              aria-label={c.name}
              title={c.name}
              className="task-color-choice"
              style={{ background: c.value }}
              onClick={() => choose(c.value)}
            >
              {current === c.value && <Check size={14} aria-hidden />}
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
