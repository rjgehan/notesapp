// The typed Properties editor (ROADMAP item 13, DESIGN §6.41): the note's frontmatter as rows of
// typed values, edited in place in Live Preview. Each change rewrites only the YAML lines of the
// property it touches (yamlEdit.ts), as one undoable edit of the note. A row's icon opens its menu
// (type, rename here or in every note, move, remove); the grip drags it to another place. Types
// come from the vault's registry (API.md §38.2), so every note shows a property the same way.
import { ChevronDown, ChevronRight, Code2, GripVertical, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PropertyType } from '../../api/types';
import { openContextMenu } from '../../components/overlays/openContextMenu';
import type { MenuEntry } from '../../components/overlays/ContextMenu';
import { toastError } from '../../features/errors';
import { toast } from '../../state/toasts';
import { refreshAfterOwnEdit, setPropertyType, usePropertyTypes, useVaultProperties } from '../api';
import { stringSuggestions } from '../links';
import { convert, PROPERTY_TYPES, registeredType, typeOf, TYPE_LABELS } from '../model';
import { renameAcrossVault } from '../rename';
import { addRequests } from '../requests';
import { addProperty, moveProperty, readProperties, removeProperty, renameProperty, setValue, type EditValue, type PropertyEntry } from '../yamlEdit';
import { TypeIcon } from './TypeIcon';
import { SuggestInput } from './SuggestInput';
import { ValueEditor } from './ValueEditors';
import '../properties.css';

const COLLAPSE_KEY = 'notesapp:propertiesCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface PropertiesEditorProps {
  yaml: string;
  sourcePath: string;
  /** Shows the frontmatter as YAML text for editing. */
  onEdit: (() => void) | null;
  /** Applies an edit (a function of the current YAML) to the note; false when the note cannot be written. */
  onChange(edit: (yaml: string) => string): boolean;
}

/** The empty value a new property of a type starts with. */
function emptyValue(type: PropertyType): EditValue {
  if (type === 'checkbox') return false;
  return null;
}

export function PropertiesEditor({ yaml, sourcePath, onEdit, onChange }: PropertiesEditorProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const parsed = useMemo(() => readProperties(yaml), [yaml]);
  const registry = usePropertyTypes().data?.types;
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; over: number } | null>(null);
  const [focusValue, setFocusValue] = useState<string | null>(null);
  const list = useRef<HTMLDListElement>(null);
  const root = useRef<HTMLElement>(null);

  // "Add property" from the palette (or Mod-;) opens the new-property row of this note.
  useEffect(
    () =>
      addRequests.subscribe(sourcePath, (path, target) => {
        if (path !== sourcePath) return;
        // Another pane's editor of the same note (DESIGN §6.40) leaves the request to its own.
        if (target && root.current && !target.contains(root.current)) return;
        addRequests.taken(path);
        setCollapsed(false);
        setAdding(true);
      }),
    [sourcePath],
  );

  // A property just added: its value field takes the focus.
  useEffect(() => {
    if (!focusValue || !list.current) return;
    const row = list.current.querySelector<HTMLElement>(`[data-property="${CSS.escape(focusValue.toLowerCase())}"]`);
    row?.querySelector<HTMLElement>('input, [tabindex="0"]')?.focus();
    setFocusValue(null);
  }, [focusValue, yaml]);

  const apply = (edit: (yaml: string) => string, what: string): boolean => {
    try {
      const done = onChange(edit);
      if (done) refreshAfterOwnEdit();
      return done;
    } catch (e) {
      toastError(e, what);
      return false;
    }
  };

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // Collapsing is a convenience only.
    }
  };

  const entries = parsed.entries;
  const changeType = async (entry: PropertyEntry, type: PropertyType) => {
    const converted = convert(entry.value, type);
    if (converted !== undefined && converted !== entry.value) apply((y) => setValue(y, entry.key, converted as EditValue), 'Property type');
    try {
      await setPropertyType(entry.key, type);
    } catch (e) {
      toastError(e, 'Property type');
    }
  };

  const openMenu = (entry: PropertyEntry, index: number, at: { x: number; y: number }) => {
    const current = typeOf(entry.key, entry.value, registry);
    const registered = registeredType(entry.key, registry);
    const items: MenuEntry[] = [
      ...PROPERTY_TYPES.map((t) => ({
        id: `type-${t}`,
        label: `${t === current ? '✓ ' : ''}${TYPE_LABELS[t]}`,
        icon: <TypeIcon type={t} />,
        run: () => void changeType(entry, t),
      })),
      'separator',
      { id: 'rename', label: 'Rename in this note', run: () => setRenaming(entry.key) },
      { id: 'rename-all', label: 'Rename in every note…', run: () => void renameAcrossVault(entry.key) },
      { id: 'up', label: 'Move up', disabled: index === 0, run: () => apply((y) => moveProperty(y, entry.key, index - 1), 'Move property') },
      { id: 'down', label: 'Move down', disabled: index === entries.length - 1, run: () => apply((y) => moveProperty(y, entry.key, index + 1), 'Move property') },
      'separator',
      { id: 'remove', label: 'Remove', danger: true, run: () => apply((y) => removeProperty(y, entry.key), 'Remove property') },
    ];
    if (registered === null) items.splice(PROPERTY_TYPES.length, 0, { id: 'type-hint', label: `Shown as ${TYPE_LABELS[current]} (from its value)`, disabled: true, run: () => {} });
    openContextMenu(at, `Property ${entry.key}`, items);
  };

  // ---------- dragging a row by its grip (pointer events: mouse, pen and touch alike) ----------
  const rowIndexAt = (clientY: number): number => {
    const rows = list.current ? [...list.current.querySelectorAll<HTMLElement>('[data-property]')] : [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  };
  const startDrag = (entry: PropertyEntry, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const from = entries.indexOf(entry);
    let over = from;
    setDrag({ key: entry.key, over });
    const move = (ev: PointerEvent) => {
      over = rowIndexAt(ev.clientY);
      setDrag({ key: entry.key, over });
    };
    const end = (ev: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      setDrag(null);
      if (ev.type === 'pointercancel') return;
      // `over` counts the rows with this one still in place; moveProperty counts them without it.
      const target = over > from ? over - 1 : over;
      if (target !== from) apply((y) => moveProperty(y, entry.key, target), 'Move property');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  return (
    <section className="properties properties-editor" aria-label="Properties" ref={root}>
      <div className="properties-header">
        <button type="button" className="properties-heading" aria-expanded={!collapsed} onClick={toggle}>
          {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          Properties
        </button>
        {onEdit && (
          <button type="button" className="icon-button properties-edit" aria-label="Edit properties as YAML" title="Edit as YAML" onMouseDown={(e) => e.preventDefault()} onClick={onEdit}>
            <Code2 size={14} aria-hidden />
          </button>
        )}
      </div>
      {!collapsed &&
        (parsed.error !== null ? (
          <div className="properties-error" role="note">
            Invalid frontmatter: {parsed.error}
          </div>
        ) : (
          <>
            <dl className="properties-rows" ref={list}>
              {entries.map((entry, i) => {
                const type = typeOf(entry.key, entry.value, registry);
                const lower = entry.key.toLowerCase();
                const dropBefore = drag && drag.over === i && drag.key !== entry.key;
                return (
                  <div
                    key={`${lower}-${i}`}
                    className={`property-row${drag?.key === entry.key ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}${drag && i === entries.length - 1 && drag.over === entries.length ? ' is-drop-after' : ''}`}
                    data-property={lower}
                  >
                    <dt>
                      <span className="property-grip" aria-hidden title="Drag to reorder" onPointerDown={(e) => startDrag(entry, e)}>
                        <GripVertical size={14} />
                      </span>
                      <button
                        type="button"
                        className="property-type-button"
                        aria-label={`${entry.key}: ${TYPE_LABELS[type]}. Property menu`}
                        title={`${TYPE_LABELS[type]}. Change the type, rename, move or remove`}
                        aria-haspopup="menu"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          openMenu(entry, i, { x: r.left, y: r.bottom + 2 });
                        }}
                      >
                        <TypeIcon type={type} />
                      </button>
                      {renaming === entry.key ? (
                        <NameInput
                          initial={entry.key}
                          onDone={(name) => {
                            setRenaming(null);
                            if (name !== null && name !== entry.key) apply((y) => renameProperty(y, entry.key, name), 'Rename property');
                          }}
                        />
                      ) : (
                        <button type="button" className="property-name" title="Rename" onClick={() => setRenaming(entry.key)}>
                          {entry.key}
                        </button>
                      )}
                    </dt>
                    <dd>
                      <ValueEditor
                        name={entry.key}
                        type={type}
                        value={entry.value}
                        sourcePath={sourcePath}
                        onEditYaml={onEdit}
                        onCommit={(value) => apply((y) => setValue(y, entry.key, value), entry.key)}
                      />
                    </dd>
                  </div>
                );
              })}
            </dl>
            {adding ? (
              <NewProperty
                existing={entries.map((e) => e.key)}
                registry={registry}
                onDone={(name) => {
                  setAdding(false);
                  if (name === null) return;
                  const type = registeredType(name, registry) ?? (name.toLowerCase() === 'tags' ? 'tags' : name.toLowerCase() === 'aliases' ? 'aliases' : 'text');
                  if (apply((y) => addProperty(y, name, emptyValue(type)), 'Add property')) setFocusValue(name);
                }}
              />
            ) : (
              <button type="button" className="property-add" onClick={() => setAdding(true)}>
                <Plus size={14} aria-hidden /> Add property
              </button>
            )}
          </>
        ))}
    </section>
  );
}

/** Renaming a property in this note: Enter or leaving the field keeps the name, Escape cancels. */
function NameInput({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name === null || name.trim() === '' ? null : name.trim());
  };
  return (
    <input
      className="property-name-input"
      aria-label={`New name for ${initial}`}
      autoFocus
      enterKeyHint="done"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/** The new-property row: a name, with the vault's property names offered (their type comes with them). */
function NewProperty({ existing, registry, onDone }: { existing: string[]; registry: Record<string, string> | undefined; onDone(name: string | null): void }) {
  const [name, setName] = useState('');
  const vault = useVaultProperties().data?.properties;
  const done = useRef(false);
  const taken = new Set(existing.map((k) => k.toLowerCase()));
  const options = (vault ?? []).filter((p) => !taken.has(p.name.toLowerCase())).sort((a, b) => b.count - a.count).map((p) => p.name);
  const finish = (value: string | null) => {
    if (done.current) return;
    const trimmed = value?.trim() ?? '';
    if (value !== null && trimmed !== '' && taken.has(trimmed.toLowerCase())) {
      toast(`The note already has a property “${trimmed}”`, { kind: 'error' });
      return;
    }
    done.current = true;
    onDone(trimmed === '' ? null : trimmed);
  };
  const type = name.trim() ? registeredType(name.trim(), registry) : null;
  return (
    <div className="property-row property-new">
      <dt>
        <span className="property-grip is-placeholder" aria-hidden />
        <span className="property-type-button is-placeholder" aria-hidden>
          <TypeIcon type={type ?? 'text'} />
        </span>
        <SuggestInput
          className="property-name-input"
          aria-label="New property name"
          placeholder="Property name"
          autoFocus
          enterKeyHint="next"
          value={name}
          suggest={(text) => stringSuggestions(options, text, 8, true)}
          onValueChange={setName}
          onCommit={(v) => finish(v)}
          onCancel={() => finish(null)}
        />
      </dt>
      <dd className="property-new-hint">{type ? TYPE_LABELS[type] : ''}</dd>
    </div>
  );
}
