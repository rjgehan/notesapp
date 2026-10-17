// Templates (API.md §15.4, DESIGN §6.12): placeholder rendering, the frontmatter merge with the
// `yaml` Document API (comments and formatting kept), and the single-transaction insertion at the
// note's stored selection.
import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type Pair } from 'yaml';
import { api } from '../api/endpoints';
import { currentSettings } from '../api/hooks';
import type { TemplatesSettings } from '../api/types';
import { toast } from '../state/toasts';
import type { DocumentSession } from '../sync/DocumentSession';
import { dayjs, type Dayjs } from './dates';
import { splitFrontmatter } from './frontmatter';
import { toLf } from './eol';
import { displayName } from './paths';

const PLACEHOLDER = /\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi;

export interface TemplateContext {
  /** Basename (no `.md`) of the note being created or edited. */
  title: string;
  now: Dayjs;
  settings: Pick<TemplatesSettings, 'dateFormat' | 'timeFormat'>;
}

/** Renders `{{title}}`, `{{date}}`, `{{time}}` and their `:FORMAT` forms; anything else stays. */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(PLACEHOLDER, (_match, rawName: string, format: string | undefined) => {
    const name = rawName.toLowerCase();
    if (name === 'title') return ctx.title;
    const fmt = format !== undefined ? format : name === 'date' ? ctx.settings.dateFormat : ctx.settings.timeFormat;
    return ctx.now.format(fmt);
  });
}

/** Keys whose list items compare case-insensitively in the merge. */
const CASE_INSENSITIVE_LISTS = new Set(['tags', 'aliases', 'cssclasses']);

function keyOf(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function itemKey(node: unknown, caseInsensitive: boolean): string {
  const value = isScalar(node) ? String(node.value) : JSON.stringify((node as Node | null)?.toJSON?.() ?? node);
  return caseInsensitive ? value.toLowerCase() : value;
}

/**
 * Merges the template's frontmatter into the note's (API.md §15.4): missing keys are appended,
 * two lists become their union (note items first), otherwise the note's value wins. Returns the
 * new YAML source, the unchanged source when nothing changed, or null when either side is not a
 * valid YAML mapping.
 */
export function mergeFrontmatter(noteYaml: string, templateYaml: string): string | null {
  const note: Document = parseDocument(noteYaml, { uniqueKeys: false });
  const template: Document = parseDocument(templateYaml, { uniqueKeys: false });
  if (note.errors.length > 0 || template.errors.length > 0) return null;
  if (template.contents === null) return noteYaml;
  if (!isMap(template.contents)) return null;
  if (note.contents === null) note.contents = note.createNode({});
  if (!isMap(note.contents)) return null;
  const target = note.contents;
  let changed = false;
  for (const pair of template.contents.items) {
    const key = keyOf(pair);
    const existing = target.items.find((p) => keyOf(p) === key);
    if (!existing) {
      target.items.push(pair.clone());
      changed = true;
      continue;
    }
    if (isSeq(existing.value) && isSeq(pair.value)) {
      const ci = CASE_INSENSITIVE_LISTS.has(key.toLowerCase());
      const have = new Set(existing.value.items.map((n) => itemKey(n, ci)));
      for (const item of pair.value.items) {
        const k = itemKey(item, ci);
        if (have.has(k)) continue;
        have.add(k);
        existing.value.items.push(isScalar(item) || isMap(item) || isSeq(item) ? item.clone() : item);
        changed = true;
      }
    }
  }
  if (!changed) return noteYaml;
  return note.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

export interface TemplateInsertion {
  /** In the coordinates of the note text the insertion was computed for. */
  changes: ChangeSet;
  /** Cursor after the inserted body, in the new document. */
  cursor: number;
  /** The note's frontmatter could not be parsed, so the template's properties were skipped. */
  frontmatterSkipped: boolean;
}

/**
 * The changes that insert a rendered template into `noteText` (LF) at `[from, to)`: the
 * frontmatter merge and the body insertion, together, so they apply as one transaction (one undo
 * step). An insertion point inside the frontmatter moves to the start of the body.
 */
export function templateInsertion(noteText: string, rendered: string, range: { from: number; to: number }): TemplateInsertion {
  const specs: ChangeSpec[] = [];
  const tpl = splitFrontmatter(toLf(rendered));
  const note = splitFrontmatter(noteText);
  let frontmatterSkipped = false;
  if (tpl.yaml !== null) {
    if (note.yaml !== null) {
      const merged = mergeFrontmatter(note.yaml, tpl.yaml);
      if (merged === null) frontmatterSkipped = true;
      else if (merged !== note.yaml) {
        const yamlFrom = noteText.indexOf('\n') + 1;
        specs.push({ from: yamlFrom, to: yamlFrom + note.yaml.length, insert: merged });
      }
    } else if (tpl.yaml.trim() !== '') {
      specs.push({ from: 0, insert: `---\n${tpl.yaml}${tpl.yaml.endsWith('\n') ? '' : '\n'}---\n` });
    }
  }
  let { from, to } = range;
  if (note.yaml !== null && from < note.bodyStart) {
    from = note.bodyStart;
    to = Math.max(to, from);
  }
  specs.push({ from, to, insert: tpl.body });
  const changes = ChangeSet.of(specs, noteText.length);
  return { changes, cursor: changes.mapPos(to, 1), frontmatterSkipped };
}

/** "Insert template" (DESIGN §6.12) into the session of the open note. */
export async function insertTemplate(session: DocumentSession, templatePath: string): Promise<void> {
  let content: string;
  try {
    content = (await api.readFile(templatePath)).content;
  } catch {
    toast('The template could not be read', { kind: 'error' });
    return;
  }
  if (!session.isEditable()) {
    toast('This note cannot be edited right now', { kind: 'error' });
    return;
  }
  const settings = currentSettings();
  const rendered = renderTemplate(content, { title: displayName(session.path), now: dayjs(), settings: settings.templates });
  const insertion = templateInsertion(session.getText(), rendered, session.insertionRange());
  session.applyEdit(insertion.changes, { selection: { anchor: insertion.cursor }, userEvent: 'input.template' });
  if (insertion.frontmatterSkipped) toast("The note's properties are not valid YAML, so the template's properties were not merged", { kind: 'error' });
}

/** Renders a template file for a new note titled `title` (daily notes). */
export async function renderTemplateFile(templatePath: string, title: string): Promise<string> {
  return (await templateRenderer(templatePath))(title);
}

/**
 * Reads a template file once and renders it for any title, at one fixed time: "New note from
 * template" renders it before the note has its name, and again once the name is known.
 */
export async function templateRenderer(templatePath: string): Promise<(title: string) => string> {
  const settings = currentSettings();
  const { content } = await api.readFile(templatePath);
  const now = dayjs();
  return (title) => renderTemplate(content, { title, now, settings: settings.templates });
}
