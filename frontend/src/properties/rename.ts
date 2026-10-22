// Renaming a property in every note (ROADMAP item 13, API.md §38.4): asks for the new name, saves
// the open notes, shows what the server would change (a dry run), then renames. The server
// rewrites only the keys, under its write lock; open notes take the change like any other
// device's edit (applied quietly when they have nothing unsaved, merged otherwise).
import type { PropertyRenameResult } from '../api/types';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import { toastError } from '../features/errors';
import { displayName } from '../features/paths';
import { confirmAction, promptText } from '../state/dialogs';
import { toast } from '../state/toasts';
import { documents } from '../sync/instance';
import { refreshFileQuery, setFileVersion } from '../sync/treePatch';
import { propertiesApi, propertyKeys } from './api';

const REASONS: Record<string, string> = {
  'property-exists': 'it already has that property',
  'not-rewritable': 'its properties are written in a way that cannot be changed in place',
  'not-utf8': 'not valid UTF-8',
  'io-error': 'storage error',
};

/** "2 notes" / "1 note". */
function notes(n: number): string {
  return `${n} ${n === 1 ? 'note' : 'notes'}`;
}

/** Why some notes keep the old name, in words. */
export function describeFailures(r: Pick<PropertyRenameResult, 'failed'>): string {
  return r.failed.map((f) => `${displayName(f.path)} (${REASONS[f.reason] ?? f.reason})`).join(', ');
}

/** This tab's caches and open notes after the server renamed a property (like a move's link updates). */
export function applyPropertyRenameResult(r: PropertyRenameResult): void {
  if (r.dryRun) return;
  for (const u of r.updates) {
    if (u.version !== null) setFileVersion(queryClient, u.path, u.version);
    refreshFileQuery(queryClient, u.path);
    void documents.get(u.path)?.onRemoteChanged({ version: u.version }, { quiet: true });
  }
  void queryClient.invalidateQueries({ queryKey: propertyKeys.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.searchAll() });
}

export interface RenameDeps {
  prompt: typeof promptText;
  confirm: typeof confirmAction;
  flushAll(): Promise<void>;
  rename: typeof propertiesApi.rename;
  apply(r: PropertyRenameResult): void;
}

const pageDeps: RenameDeps = {
  prompt: promptText,
  confirm: confirmAction,
  flushAll: async () => {
    await Promise.all(documents.all().map((s) => s.flush().catch(() => undefined)));
  },
  rename: (req) => propertiesApi.rename(req),
  apply: applyPropertyRenameResult,
};

/** "Rename in every note…": returns the result, or null when cancelled or nothing changed. */
export async function renameAcrossVault(from: string, deps: RenameDeps = pageDeps): Promise<PropertyRenameResult | null> {
  const to = await deps.prompt({
    title: 'Rename property',
    label: `New name for “${from}” in every note`,
    value: from,
    confirmLabel: 'Next',
    validate: (v) => (v.trim() === '' ? 'A name is required' : /[\r\n]/.test(v) ? 'A name is one line' : null),
  });
  const name = to?.trim() ?? '';
  if (name === '' || name === from) return null;
  try {
    await deps.flushAll();
    const preview = await deps.rename({ from, to: name, dryRun: true });
    if (preview.updates.length === 0 && !preview.typeMoved) {
      toast(preview.failed.length ? `“${from}” cannot be renamed: ${describeFailures(preview)}` : `No note has a property “${from}”`, { kind: preview.failed.length ? 'error' : 'info' });
      return null;
    }
    const skipped = preview.failed.length ? ` ${notes(preview.failed.length)} ${preview.failed.length === 1 ? 'keeps' : 'keep'} the old name: ${describeFailures(preview)}.` : '';
    const ok = await deps.confirm({
      title: 'Rename property',
      message: `Rename “${from}” to “${name}” in ${notes(preview.updates.length)}?${skipped} Only the names change; values, comments and formatting stay as they are.`,
      confirmLabel: 'Rename',
    });
    if (!ok) return null;
    await deps.flushAll();
    const result = await deps.rename({ from, to: name });
    deps.apply(result);
    toast(`Renamed “${from}” to “${name}” in ${notes(result.updates.length)}`, { kind: 'success' });
    if (result.failed.length) toast(`Not renamed in ${describeFailures(result)}`, { kind: 'error', timeout: 8000 });
    return result;
  } catch (e) {
    toastError(e, 'Rename property');
    return null;
  }
}
