// `/trash` (API.md §13): trashed files and folders, newest first, with Restore, a preview of
// trashed files, permanent deletion and Empty trash. Items found in `.trash/` without app metadata
// (`x-` ids, put there by Obsidian or by hand) may not be in history, so purging them warns first.
import { Eye, FileText, Folder, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, isProblem } from '../../api/client';
import { api } from '../../api/endpoints';
import { useTrash } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { TrashEntry } from '../../api/types';
import { openRestored } from '../../features/fileOps';
import { formatBytes, formatDateTime, formatRelative } from '../../features/format';
import { displayName, folderOf } from '../../features/paths';
import { confirmAction } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { applyRestoreResult } from '../../sync/applyEvents';
import { syncTarget } from '../../sync/liveSync';
import { usePageTitle } from './usePageTitle';
import { toastError } from '../../features/errors';

const isForeign = (e: TrashEntry) => e.id.startsWith('x-');
const NEVER_SEEN = 'This item was put in the trash outside NotesApp and may not be in history. Deleting it cannot be undone.';

function invalidateTrash(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.trash() });
}

function TrashRow({ entry }: { entry: TrashEntry }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    try {
      const result = await api.restoreTrash(entry.id);
      applyRestoreResult(syncTarget, result);
      toast(`Restored ${displayName(result.path)}`, { action: { label: 'Open', run: () => openRestored(result.path, result.type) } });
    } catch (e) {
      if (!isProblem(e, 'already-exists') && !isProblem(e, 'case-collision')) throw e;
      const ok = await confirmAction({
        title: 'Name already taken',
        message: `“${entry.originalPath}” exists again. Restore this item next to it with a numbered name?`,
        confirmLabel: 'Restore as a copy',
      });
      if (!ok) return;
      const result = await api.restoreTrash(entry.id, { onConflict: 'rename' });
      applyRestoreResult(syncTarget, result);
      toast(`Restored as ${displayName(result.path)}`, { action: { label: 'Open', run: () => openRestored(result.path, result.type) } });
    }
  };

  const purge = async () => {
    const ok = await confirmAction({
      title: 'Delete permanently?',
      message: isForeign(entry) ? `“${entry.originalPath}”: ${NEVER_SEEN}` : `“${entry.originalPath}” will be deleted for good. Its last version stays in history.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    await api.purgeTrashEntry(entry.id);
    invalidateTrash();
  };

  const folder = folderOf(entry.originalPath);
  return (
    <li className="trash-row">
      <span className="trash-icon" aria-hidden>
        {entry.type === 'folder' ? <Folder size={18} /> : <FileText size={18} />}
      </span>
      <span className="trash-main">
        <span className="trash-name">{displayName(entry.originalPath)}</span>
        <span className="trash-meta">
          {folder && <span>{folder} · </span>}
          <time dateTime={entry.deletedAt} title={formatDateTime(entry.deletedAt)}>
            {formatRelative(entry.deletedAt)}
          </time>
          {entry.deletedBy !== 'unknown' && <span> · {entry.deletedBy}</span>}
          <span> · {entry.type === 'folder' ? `${entry.fileCount} ${entry.fileCount === 1 ? 'file' : 'files'}, ` : ''}{formatBytes(entry.size)}</span>
          {isForeign(entry) && <span className="trash-foreign"> · not from NotesApp</span>}
        </span>
      </span>
      <span className="trash-actions">
        {entry.type === 'file' && (
          <a className="icon-button" href={api.trashRawUrl(entry.id)} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${displayName(entry.originalPath)}`} title="Preview">
            <Eye size={16} />
          </a>
        )}
        <button type="button" className="button button-small" disabled={busy} onClick={() => void run(restore)}>
          <RotateCcw size={14} aria-hidden /> Restore
        </button>
        <button type="button" className="icon-button" disabled={busy} aria-label={`Delete ${displayName(entry.originalPath)} permanently`} title="Delete permanently" onClick={() => void run(purge)}>
          <Trash2 size={16} />
        </button>
      </span>
    </li>
  );
}

export function TrashPage() {
  usePageTitle('Trash');
  const trash = useTrash();
  const entries = trash.data?.entries ?? [];
  const [emptying, setEmptying] = useState(false);

  const emptyTrash = async () => {
    const foreign = entries.filter(isForeign).length;
    const ok = await confirmAction({
      title: 'Empty the trash?',
      message:
        `${entries.length} ${entries.length === 1 ? 'item' : 'items'} will be deleted for good.` +
        (foreign ? ` ${foreign} of them ${foreign === 1 ? 'was' : 'were'} put there outside NotesApp and may not be in history.` : ' Their last versions stay in history.'),
      confirmLabel: 'Empty trash',
      danger: true,
    });
    if (!ok) return;
    setEmptying(true);
    try {
      const { purged } = await api.emptyTrash();
      toast(`Deleted ${purged} ${purged === 1 ? 'item' : 'items'} permanently`);
      invalidateTrash();
    } catch (e) {
      toastError(e);
    } finally {
      setEmptying(false);
    }
  };

  return (
    <div className="page trash-page">
      <header className="page-header">
        <h1 className="page-title">Trash</h1>
        {entries.length > 0 && (
          <button type="button" className="button button-danger" disabled={emptying} onClick={() => void emptyTrash()}>
            <Trash2 size={14} aria-hidden /> Empty trash
          </button>
        )}
      </header>
      {trash.isPending ? (
        <div className="view-loading" aria-busy="true">
          <div className="skeleton-line" />
        </div>
      ) : trash.isError ? (
        <div className="error-panel" role="alert">
          <p className="error-panel-title">The trash could not be loaded.</p>
          <p className="error-panel-detail">{errorMessage(trash.error)}</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <Trash2 size={40} aria-hidden />
          <h2>The trash is empty</h2>
          <p>Deleted notes and files appear here until you empty the trash.</p>
        </div>
      ) : (
        <ul className="trash-list">
          {entries.map((e) => (
            <TrashRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}
