// Property types (ROADMAP item 13, DESIGN §6.41): Obsidian's set, the vault's registry
// (`.notesapp/types.json`, API.md §38.2), the built-in types of `tags` and `aliases`, and what a
// value looks like when the registry says nothing. A value that does not fit its type is shown as
// it is written, with a warning, until it is edited.
import type { PropertyType } from '../api/types';

export const PROPERTY_TYPES: readonly PropertyType[] = ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime', 'tags', 'aliases'];

export const TYPE_LABELS: Record<PropertyType, string> = {
  text: 'Text',
  multitext: 'List',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  datetime: 'Date & time',
  tags: 'Tags',
  aliases: 'Aliases',
};

/** Properties whose type Obsidian fixes. */
const BUILTIN: Record<string, PropertyType> = {
  tags: 'tags',
  tag: 'tags',
  aliases: 'aliases',
  alias: 'aliases',
  cssclasses: 'multitext',
};

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function isPropertyType(t: unknown): t is PropertyType {
  return typeof t === 'string' && (PROPERTY_TYPES as readonly string[]).includes(t);
}

/** What a value looks like, as the server infers it (API.md §38.1); null for an empty value. */
export function inferType(value: unknown): PropertyType | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'multitext';
  if (typeof value === 'string') {
    if (DATE.test(value)) return 'date';
    if (DATETIME.test(value)) return 'datetime';
  }
  return 'text';
}

/** The registry's type of `name` (names compare case-insensitively). */
export function registeredType(name: string, registry: Record<string, string> | undefined): PropertyType | null {
  if (!registry) return null;
  const direct = registry[name];
  if (isPropertyType(direct)) return direct;
  const lower = name.toLowerCase();
  for (const [key, type] of Object.entries(registry)) if (key.toLowerCase() === lower && isPropertyType(type)) return type;
  return null;
}

/** The type a property shows as: the registry's, a built-in one, or what its value looks like. */
export function typeOf(name: string, value: unknown, registry: Record<string, string> | undefined): PropertyType {
  return registeredType(name, registry) ?? BUILTIN[name.toLowerCase()] ?? inferType(value) ?? 'text';
}

export function isListType(type: PropertyType): boolean {
  return type === 'multitext' || type === 'tags' || type === 'aliases';
}

/** Whether the value can be shown and edited by the type's editor without losing anything. */
export function fits(type: PropertyType, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case 'text':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'checkbox':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && (value === '' || DATE.test(value));
    case 'datetime':
      return typeof value === 'string' && (value === '' || DATETIME.test(value) || DATE.test(value));
    case 'multitext':
    case 'tags':
    case 'aliases':
      return typeof value === 'string' || (Array.isArray(value) && value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)));
  }
}

/** A list value's items (a single string is one item; tags written as `a, b` are split as Obsidian reads them). */
export function listItems(type: PropertyType, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map(String);
  if (typeof value === 'string') return type === 'tags' ? value.split(/[,\s]+/).filter(Boolean) : value === '' ? [] : [value];
  return [String(value)];
}

/** A tag as a property holds it: no `#`, no spaces. */
export function cleanTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').replace(/\s+/g, '-');
}

/** A value converted for a new type, when it converts without loss; otherwise undefined (it stays as written). */
export function convert(value: unknown, to: PropertyType): unknown {
  if (value === null || value === undefined || fits(to, value)) {
    if (isListType(to) && typeof value === 'string') return listItems(to, value);
    return value;
  }
  if (isListType(to) && (typeof value === 'number' || typeof value === 'boolean')) return [String(value)];
  if (to === 'text' && Array.isArray(value) && value.length <= 1) return value.length ? String(value[0]) : null;
  if (to === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (to === 'checkbox' && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  if (to === 'date' && typeof value === 'string' && DATETIME.test(value)) return value.slice(0, 10);
  return undefined;
}

/** The search for notes with the property (API.md §12.1). */
export function propertyQuery(name: string): string {
  return /[[\]:]/.test(name) ? `"${name}"` : `[${name}]`;
}
