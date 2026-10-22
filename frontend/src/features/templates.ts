// Templates (API.md §15.4, DESIGN §5.11, §6.12): placeholder rendering (prompts and the cursor
// included), the frontmatter merge with the `yaml` Document API (comments and formatting kept), and
// the single-transaction insertion at the note's stored selection.
import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type Pair } from 'yaml';
import { api } from '../api/endpoints';
import { currentSettings } from '../api/hooks';
import type { TemplatesSettings } from '../api/types';
import { promptFields } from '../state/dialogs';
import { toast } from '../state/toasts';
import type { DocumentSession } from '../sync/DocumentSession';
import { dayjs, type Dayjs } from './dates';
import { splitFrontmatter } from './frontmatter';
import { toLf } from './eol';
import { displayName } from './paths';

/**
 * Every placeholder (DESIGN §5.11): `{{title}}`, `{{date[:FMT]}}` and `{{time[:FMT]}}` (Obsidian's
 * core Templates plugin), `{{cursor}}` and `{{prompt:Question[|default]}}` (ROADMAP item 30).
 */
const PLACEHOLDER = /\{\{\s*(?:(title|date|time)(?::([^}]*))?|(cursor)|prompt:([^}|]*)(?:\|([^}]*))?)\s*\}\}/gi;

export interface TemplateContext {
  /** Basename (no `.md`) of the note being created or edited. */
  title: string;
  now: Dayjs;
  settings: Pick<TemplatesSettings, 'dateFormat' | 'timeFormat'>;
  /** Answers to `{{prompt:…}}` by question; a question without one renders its default. */
  answers?: Readonly<Record<string, string>>;
}

/** A rendered template, and where its `{{cursor}}` puts the caret (null: it has none). */
export interface TemplateOutput {
  text: string;
  cursor: number | null;
}

/** One question a template asks, in order of first appearance, with its default answer. */
export interface TemplatePrompt {
  question: string;
  initial: string;
}

/** Renders a template; any other `{{…}}` stays as it is. Values are never rendered again. */
export function renderTemplateOutput(text: string, ctx: TemplateContext): TemplateOutput {
  let out = '';
  let last = 0;
  let cursor: number | null = null;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const [match, rawName, format, cursorName, question, initial] = m;
    if (cursorName !== undefined) {
      // The first {{cursor}} places the caret; any others are only removed.
      cursor ??= out.length;
    } else if (question !== undefined) {
      const q = question.trim();
      out += q === '' ? match : (ctx.answers?.[q] ?? initial?.trim() ?? '');
    } else {
      const name = rawName.toLowerCase();
      if (name === 'title') out += ctx.title;
      else out += ctx.now.format(format !== undefined ? format : name === 'date' ? ctx.settings.dateFormat : ctx.settings.timeFormat);
    }
  }
  return { text: out + text.slice(last), cursor };
}

/** Renders a template to text: the placeholders replaced, `{{cursor}}` removed. */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  return renderTemplateOutput(text, ctx).text;
}

/** The questions of a template's `{{prompt:…}}` placeholders, each once (the first default counts). */
export function templatePrompts(text: string): TemplatePrompt[] {
  const seen = new Map<string, TemplatePrompt>();
  for (const m of text.matchAll(PLACEHOLDER)) {
    const question = m[4]?.trim();
    if (!question || seen.has(question)) continue;
    seen.set(question, { question, initial: m[5]?.trim() ?? '' });
  }
  return [...seen.values()];
}

/**
 * Asks a template's questions, all in one dialog (DESIGN §6.12). Resolves the answers by question,
 * `{}` when it asks none, or null when the dialog was cancelled.
 */
export async function askPrompts(text: string, templateName: string): Promise<Record<string, string> | null> {
  const prompts = templatePrompts(text);
  if (prompts.length === 0) return {};
  const values = await promptFields({ title: templateName, fields: prompts.map((p) => ({ label: p.question, value: p.initial })) });
  if (!values) return null;
  return Object.fromEntries(prompts.map((p, i) => [p.question, values[i] ?? '']));
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
  /** Where the caret goes in the new document: the template's `{{cursor}}`, or after the body. */
  cursor: number;
  /** The note's frontmatter could not be parsed, so the template's properties were skipped. */
  frontmatterSkipped: boolean;
}

/**
 * The changes that insert a rendered template (LF) into `noteText` (LF) at `[from, to)`: the
 * frontmatter merge and the body insertion, together, so they apply as one transaction (one undo
 * step). An insertion point inside the frontmatter moves to the start of the body. `renderedCursor`
 * is the template's `{{cursor}}` in `rendered`; one in its frontmatter does not count.
 */
export function templateInsertion(noteText: string, rendered: string, range: { from: number; to: number }, renderedCursor: number | null = null): TemplateInsertion {
  const specs: ChangeSpec[] = [];
  const tpl = splitFrontmatter(rendered);
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
  // The body ends here, whatever the frontmatter insertion before it.
  const end = changes.mapPos(to, 1);
  const inBody = renderedCursor !== null && renderedCursor >= tpl.bodyStart ? renderedCursor - tpl.bodyStart : null;
  return { changes, cursor: inBody === null ? end : end - tpl.body.length + inBody, frontmatterSkipped };
}

/** A template file's text, LF. */
async function readTemplate(templatePath: string): Promise<string> {
  return toLf((await api.readFile(templatePath)).content);
}

/** "Insert template" (DESIGN §6.12) into the session of the open note. */
export async function insertTemplate(session: DocumentSession, templatePath: string): Promise<void> {
  let content: string;
  try {
    content = await readTemplate(templatePath);
  } catch {
    toast('The template could not be read', { kind: 'error' });
    return;
  }
  // Cancelling the template's questions inserts nothing.
  const answers = await askPrompts(content, displayName(templatePath));
  if (!answers) return;
  if (!session.isEditable()) {
    toast('This note cannot be edited right now', { kind: 'error' });
    return;
  }
  const settings = currentSettings();
  const out = renderTemplateOutput(content, { title: displayName(session.path), now: dayjs(), settings: settings.templates, answers });
  const insertion = templateInsertion(session.getText(), out.text, session.insertionRange(), out.cursor);
  session.applyEdit(insertion.changes, { selection: { anchor: insertion.cursor }, userEvent: 'input.template' });
  if (insertion.frontmatterSkipped) toast("The note's properties are not valid YAML, so the template's properties were not merged", { kind: 'error' });
}

/** A template rendered for any title, with its time and answers fixed (a new note's content). */
export type TitledTemplate = (title: string) => TemplateOutput;

/**
 * Reads a template file once, asks its questions, and renders it for any title at one fixed time:
 * "New note from template" renders it before the note has its name, and again once the name is
 * known. Resolves null when the questions were cancelled; rejects when the file cannot be read.
 */
export async function templateRenderer(templatePath: string, at?: Dayjs): Promise<TitledTemplate | null> {
  const settings = currentSettings();
  const content = await readTemplate(templatePath);
  const answers = await askPrompts(content, displayName(templatePath));
  if (!answers) return null;
  const now = at ?? dayjs();
  return (title) => renderTemplateOutput(content, { title, now, settings: settings.templates, answers });
}

/**
 * Renders a template file for a new note titled `title` (daily notes); null when cancelled. `now` is
 * the moment its `{{date}}` and `{{time}}` stand for: the daily note of another day, created from the
 * calendar (DESIGN §6.32), renders that day at the current time of day, as Obsidian does.
 */
export async function renderTemplateFile(templatePath: string, title: string, now?: Dayjs): Promise<TemplateOutput | null> {
  const render = await templateRenderer(templatePath, now);
  return render ? render(title) : null;
}
