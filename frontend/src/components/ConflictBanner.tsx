// Conflict and deletion banner of a textual document (DESIGN §6.10): sticky, role="alert", shown
// in the conflict and deleted states, and after a save refused as too large (§6.9). Autosave is
// paused while it is shown; drafts continue.
import { CircleAlert, Copy, GitCompare, RotateCcw, Trash, Undo2, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { isProblem } from '../api/client';
import { api } from '../api/endpoints';
import { navigateTo } from '../features/navigation';
import { noteRoute } from '../features/paths';
import { toast } from '../state/toasts';
import type { DocumentSession } from '../sync/DocumentSession';
import { applyRestoreResult } from '../sync/applyEvents';
import { syncTarget } from '../sync/liveSync';
import { useSessionSnapshot } from '../sync/useTextDocument';
import type { FileViewDescriptor } from '../views/registry';
import { toastError } from '../features/errors';

const ConflictCompare = lazy(() => import('./ConflictCompare'));

interface Props {
  session: DocumentSession;
  merge?: FileViewDescriptor['merge'];
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied your text to the clipboard');
  } catch {
    toast('The browser refused clipboard access', { kind: 'error' });
  }
}

export function ConflictBanner({ session, merge }: Props) {
  const snapshot = useSessionSnapshot(session);
  const [comparing, setComparing] = useState(false);
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

  if (snapshot.status === 'conflict' && snapshot.conflict) {
    const { conflict } = snapshot;
    return (
      <div className="conflict-banner" role="alert" data-covers-top>
        <div className="conflict-banner-text">
          <CircleAlert size={16} aria-hidden />
          <span>
            {conflict.source === 'draft'
              ? 'Unsaved changes from an earlier visit conflict with the version on the server.'
              : 'This note was changed on another device while you were editing it.'}
            {conflict.historyBlocked && (
              <strong className="conflict-banner-warning">
                {' '}
                History is failing on the server, so Keep mine is blocked to protect the other version. Copy your text, or take theirs.
              </strong>
            )}
          </span>
        </div>
        <div className="conflict-banner-actions">
          <button type="button" className="button button-small button-primary" disabled={busy} onClick={() => void run(() => session.keepMine())}>
            Keep mine
          </button>
          <button type="button" className="button button-small" disabled={busy} onClick={() => void run(() => session.takeTheirs())}>
            Take theirs
          </button>
          <button type="button" className="button button-small" disabled={busy} onClick={() => setComparing(true)}>
            <GitCompare size={14} aria-hidden /> Compare
          </button>
          {conflict.historyBlocked && (
            <button type="button" className="button button-small" onClick={() => void copyText(session.getText())}>
              <Copy size={14} aria-hidden /> Copy my text
            </button>
          )}
        </div>
        {comparing && (
          <Suspense fallback={null}>
            <ConflictCompare session={session} merge={merge} onClose={() => setComparing(false)} />
          </Suspense>
        )}
      </div>
    );
  }

  if (snapshot.status === 'error' && snapshot.tooLarge) {
    return (
      <div className="conflict-banner" role="alert" data-covers-top>
        <div className="conflict-banner-text">
          <CircleAlert size={16} aria-hidden />
          <span>This note is too large to save. Your changes are kept on this device: remove some text, or discard them.</span>
        </div>
        <div className="conflict-banner-actions">
          <button type="button" className="button button-small" onClick={() => void copyText(session.getText())}>
            <Copy size={14} aria-hidden /> Copy my text
          </button>
          <button type="button" className="button button-small" disabled={busy} onClick={() => void run(() => session.discardUnsaved())}>
            <Undo2 size={14} aria-hidden /> Discard my changes
          </button>
        </div>
      </div>
    );
  }

  if (snapshot.status === 'deleted' && snapshot.deleted) {
    const { deleted } = snapshot;
    if (deleted.hasLocalEdits) {
      return (
        <div className="conflict-banner" role="alert" data-covers-top>
          <div className="conflict-banner-text">
            <Trash size={16} aria-hidden />
            <span>Deleted on another device. Your unsaved changes are still here.</span>
          </div>
          <div className="conflict-banner-actions">
            <button type="button" className="button button-small button-primary" disabled={busy} onClick={() => void run(() => session.recreate())}>
              <RotateCcw size={14} aria-hidden /> Recreate with my text
            </button>
            <button type="button" className="button button-small" disabled={busy} onClick={() => void run(() => session.discardLocal())}>
              <Undo2 size={14} aria-hidden /> Discard
            </button>
          </div>
        </div>
      );
    }
    const restore = async () => {
      if (!deleted.trashId) return;
      try {
        const result = await api.restoreTrash(deleted.trashId);
        applyRestoreResult(syncTarget, result);
        if (result.path !== session.path) navigateTo(noteRoute(result.path), { replace: true });
      } catch (e) {
        if (isProblem(e, 'not-found')) toast('This note is no longer in the trash', { kind: 'error' });
        else throw e;
      }
    };
    return (
      <div className="conflict-banner is-tombstone" role="alert" data-covers-top>
        <div className="conflict-banner-text">
          <Trash size={16} aria-hidden />
          <span>{deleted.trashId ? 'Moved to trash on another device.' : 'Deleted on another device.'}</span>
        </div>
        <div className="conflict-banner-actions">
          {deleted.trashId && (
            <button type="button" className="button button-small button-primary" disabled={busy} onClick={() => void run(restore)}>
              <RotateCcw size={14} aria-hidden /> Restore
            </button>
          )}
          <button type="button" className="button button-small" onClick={() => navigateTo('/', { replace: true })}>
            <X size={14} aria-hidden /> Close
          </button>
        </div>
      </div>
    );
  }

  return null;
}
