// Sheet tabs below the grid (DESIGN §6.21.5): switch, add, rename (double-click or the menu),
// delete, and reorder (drag on desktop, Move left/right in the menu everywhere). The active tab's
// ⋯ button opens its menu, so nothing depends on right-click or long-press.
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Trash } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';

interface Props {
  sheets: ReadonlyArray<{ id: string; name: string }>;
  activeId: string;
  editable: boolean;
  /** `pointer`: chosen with a click, so the grid takes the keys (arrow keys stay in the tabs). */
  onSelect(id: string, pointer?: boolean): void;
  onAdd(): void;
  onRename(id: string): void;
  onDelete(id: string): void;
  onMove(id: string, index: number): void;
}

const DRAG_TYPE = 'application/x-notesapp-sheet';

export function SheetTabs({ sheets, activeId, editable, onSelect, onAdd, onRename, onDelete, onMove }: Props) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const openMenu = (id: string, x: number, y: number) => setMenu({ id, x, y });

  const items = (id: string): MenuEntry[] => {
    const index = sheets.findIndex((s) => s.id === id);
    return [
      { id: 'rename', label: 'Rename', icon: <Pencil size={16} />, disabled: !editable, run: () => onRename(id) },
      { id: 'left', label: 'Move left', icon: <ChevronLeft size={16} />, disabled: !editable || index <= 0, run: () => onMove(id, index - 1) },
      { id: 'right', label: 'Move right', icon: <ChevronRight size={16} />, disabled: !editable || index >= sheets.length - 1, run: () => onMove(id, index + 1) },
      'separator',
      { id: 'delete', label: 'Delete', icon: <Trash size={16} />, danger: true, disabled: !editable || sheets.length <= 1, run: () => onDelete(id) },
    ];
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'F2' && editable) {
      e.preventDefault();
      onRename(activeId);
      return;
    }
    const index = sheets.findIndex((s) => s.id === activeId);
    const targets: Record<string, number> = { ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(sheets.length - 1, index + 1), Home: 0, End: sheets.length - 1 };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (next !== index) {
      onSelect(sheets[next].id);
      list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    }
  };

  return (
    <div className="sheet-tabs">
      {editable && (
        <button type="button" className="icon-button sheet-tab-add" aria-label="Add sheet" title="Add sheet" onClick={onAdd}>
          <Plus size={16} />
        </button>
      )}
      <div ref={list} className="sheet-tab-list" role="tablist" aria-label="Sheets" onKeyDown={onKeyDown}>
        {sheets.map((s, i) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`sheet-tab${active ? ' is-active' : ''}${dropIndex === i ? ' is-drop-target' : ''}`}
              draggable={editable}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, s.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setDropIndex(i);
              }}
              onDragLeave={() => setDropIndex((d) => (d === i ? null : d))}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(DRAG_TYPE);
                setDropIndex(null);
                if (id && id !== s.id) {
                  e.preventDefault();
                  onMove(id, i);
                }
              }}
              onDragEnd={() => setDropIndex(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(s.id);
                openMenu(s.id, e.clientX, e.clientY);
              }}
            >
              <button
                type="button"
                role="tab"
                className="sheet-tab-name"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={editable ? `${s.name} (double-click to rename)` : s.name}
                onClick={(e) => onSelect(s.id, e.detail > 0)}
                onDoubleClick={() => editable && onRename(s.id)}
              >
                {s.name}
              </button>
              {active && (
                <button
                  type="button"
                  className="icon-button sheet-tab-menu"
                  aria-label={`Actions for sheet ${s.name}`}
                  title="Sheet actions"
                  tabIndex={-1}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu(s.id, r.left, r.top - 8);
                  }}
                >
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for sheet ${sheets.find((s) => s.id === menu.id)?.name ?? ''}`} items={items(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}
