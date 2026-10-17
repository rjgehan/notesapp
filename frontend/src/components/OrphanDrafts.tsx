// Recovery UI for orphaned drafts (DESIGN §6.9): unsaved text of notes renamed, moved or deleted
// while no tab of this browser was open. Settings › This device lists them; a "File not found"
// page offers the text of its path.
import { Copy, FilePlus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTree } from '../api/hooks';
import { forgetDraft, listOrphanDrafts, orphanDraftsFor, recreateFromDraft, restoreDraftInto } from '../features/draftRecovery';
import { formatDateTime, formatRelative } from '../features/format';
import { displayName } from '../features/paths';
import { toast } from '../state/toasts';
import type { OrphanDraft } from '../sync/orphanDrafts';

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to the clipboard');
  } catch {
    toast('The browser refused clipboard access', { kind: 'error' });
  }
}

function useOrphans(load: () => Promise<OrphanDraft[]>, deps: unknown[]) {
  const [items, setItems] = useState<OrphanDraft[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (list) => !cancelled && setItems(list),
      () => !cancelled && setItems([]),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const remove = (d: OrphanDraft) => setItems((list) => list?.filter((i) => i !== d) ?? null);
  return { items, remove };
}

/** Settings › This device: every orphaned draft, with its recovery actions. */
export function OrphanDraftList() {
  const tree = useTree().data;
  const { items, remove } = useOrphans(listOrphanDrafts, [tree !== undefined]);
  if (!items || items.length === 0) return null;
  return (
    <>
      <h3 className="settings-subtitle">Unsaved text of renamed or deleted notes</h3>
      <ul className="discarded-list">
        {items.map((d) => (
          <li key={`${d.path}\u0000${d.clientId}`} className="discarded-item">
            <div className="discarded-head">
              <span className="discarded-name">{d.path}</span>
              <span className="muted">
                unsaved draft · <time title={formatDateTime(d.at)}>{formatRelative(d.at)}</time>
              </span>
            </div>
            <pre className="discarded-preview">
              {d.text.slice(0, 280)}
              {d.text.length > 280 ? '…' : ''}
            </pre>
            <div className="discarded-actions">
              <button type="button" className="button button-small" onClick={() => void copy(d.text)}>
                <Copy size={13} aria-hidden /> Copy
              </button>
              {d.likelyPath && (
                <button type="button" className="button button-small" onClick={() => void restoreDraftInto(d, d.likelyPath!).then((ok) => ok && remove(d))}>
                  <RotateCcw size={13} aria-hidden /> Restore into {displayName(d.likelyPath)}
                </button>
              )}
              <button type="button" className="button button-small" onClick={() => void recreateFromDraft(d).then((ok) => ok && remove(d))}>
                <FilePlus size={13} aria-hidden /> Recreate as a note
              </button>
              <button type="button" className="button button-small" onClick={() => void forgetDraft(d).then(() => remove(d))}>
                <Trash2 size={13} aria-hidden /> Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** On a "File not found" page: unsaved text this device kept for that path. */
export function OrphanDraftNotice({ path }: { path: string }) {
  const tree = useTree().data;
  const { items, remove } = useOrphans(() => orphanDraftsFor(path), [path, tree !== undefined]);
  const draft = items?.[0];
  if (!draft) return null;
  return (
    <div className="banner banner-warning orphan-draft-notice" role="status">
      <p>Unsaved text for this note is kept on this device ({formatRelative(draft.at)}).</p>
      <div className="discarded-actions">
        <button type="button" className="button button-small button-primary" onClick={() => void recreateFromDraft(draft).then((ok) => ok && remove(draft))}>
          <RotateCcw size={13} aria-hidden /> Recreate with my text
        </button>
        {draft.likelyPath && (
          <button type="button" className="button button-small" onClick={() => void restoreDraftInto(draft, draft.likelyPath!).then((ok) => ok && remove(draft))}>
            Restore into {displayName(draft.likelyPath)}
          </button>
        )}
        <button type="button" className="button button-small" onClick={() => void copy(draft.text)}>
          <Copy size={13} aria-hidden /> Copy
        </button>
      </div>
    </div>
  );
}
