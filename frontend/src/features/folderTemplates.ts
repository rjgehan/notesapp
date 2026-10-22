// Folder templates (ROADMAP item 30, DESIGN §6.12): a new note gets the template of the folder it
// is created in. Kept apart from templates.ts, which loads on first use with its YAML library; this
// module only decides whether a template applies, then loads it.
import { isProblem } from '../api/client';
import { currentSettings } from '../api/hooks';
import type { Settings } from '../api/types';
import { toast } from '../state/toasts';
import { useUi } from '../state/ui';
import { documents } from '../sync/instance';
import { displayName, folderOf, isWithin } from './paths';
import type { TemplateOutput, TitledTemplate } from './templates';

/**
 * The template for a new note in `folder`: the rule of the deepest folder that contains it (the
 * vault root, `""`, contains every folder). Notes created in the templates folder get none.
 */
export function folderTemplateFor(folder: string, settings: Pick<Settings, 'templates'>): string | null {
  const t = settings.templates;
  if (t.folder !== '' && isWithin(folder, t.folder)) return null;
  let best: { folder: string; template: string } | null = null;
  for (const rule of t.folderTemplates) {
    if (rule.template === '' || !isWithin(folder, rule.folder)) continue;
    if (!best || rule.folder.length > best.folder.length) best = rule;
  }
  return best?.template ?? null;
}

const EMPTY: TemplateOutput = { text: '', cursor: null };

/**
 * The folder template of a new note in `folder`, read and with its questions answered: a renderer
 * for the note's title, `''` without a template (or when it does not exist, with a toast), or null
 * when the questions were cancelled.
 */
export async function folderTemplateRenderer(folder: string): Promise<TitledTemplate | '' | null> {
  const template = folderTemplateFor(folder, currentSettings());
  if (!template) return '';
  try {
    return await (await import('./templates')).templateRenderer(template);
  } catch (e) {
    if (!isProblem(e, 'not-found')) throw e;
    toast(`Folder template “${displayName(template)}” not found`, { kind: 'error' });
    return '';
  }
}

/** The content of a new note at `path` (name known): its folder template rendered, or null when cancelled. */
export async function folderTemplateOutput(path: string): Promise<TemplateOutput | null> {
  const render = await folderTemplateRenderer(folderOf(path));
  if (render === null) return null;
  return render === '' ? EMPTY : render(displayName(path));
}

/**
 * Puts the caret of the note just created at `path` where its template's `{{cursor}}` was,
 * unless its text has changed meanwhile.
 */
export async function placeTemplateCursor(path: string, out: TemplateOutput): Promise<void> {
  if (out.cursor === null) return;
  const session = documents.acquire(path, 'template-cursor');
  try {
    await session.whenSettled();
    if (session.getText() === out.text) session.select(out.cursor);
  } finally {
    documents.release(session, 'template-cursor');
  }
}

// ---------- "New note from template" in a folder's menu ----------

let pickerFolder: string | null = null;

/** Opens the template picker for a new note in `folder` (the explorer's folder menu). */
export function newNoteFromTemplateIn(folder: string): void {
  pickerFolder = folder;
  useUi.getState().setOverlay('templates-new');
}

/** The folder the open "New note from template" picker creates in; null: the default location. */
export function templatePickerFolder(): string | null {
  return pickerFolder;
}

export function clearTemplatePickerFolder(): void {
  pickerFolder = null;
}
