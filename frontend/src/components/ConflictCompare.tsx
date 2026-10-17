// The lazy Compare view of the conflict banner (DESIGN §6.10): a unified merge view whose
// document is mine and whose original is theirs; each chunk can be accepted (keep mine) or
// rejected (take theirs), and "Save merged" saves the result with flushHistory.
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createCompareView, updateCompareOriginal, type DiffViewHandle } from '../editor/historyDiff';
import { isNotePath } from '../features/paths';
import type { DocumentSession } from '../sync/DocumentSession';
import { useSessionSnapshot } from '../sync/useTextDocument';
import type { FileViewDescriptor } from '../views/registry';
import { Modal } from './overlays/Modal';

interface Props {
  session: DocumentSession;
  merge?: FileViewDescriptor['merge'];
  onClose(): void;
}

export default function ConflictCompare({ session, merge, onClose }: Props) {
  const snapshot = useSessionSnapshot(session);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<DiffViewHandle | null>(null);
  const shownTheirs = useRef<string>('');
  const [saving, setSaving] = useState(false);
  const conflict = snapshot.conflict;
  const theirs = conflict?.theirsText ?? '';
  // A view with a semantic merge offers its result first when the base is known.
  const [initial] = useState(() => {
    const c = session.getSnapshot().conflict;
    const mine = session.getText();
    const merged = c && merge && c.baseText !== null ? merge(c.baseText, mine, c.theirsText) : null;
    return { doc: merged ?? mine, theirs: c?.theirsText ?? '', autoMerged: merged !== null };
  });

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    handle.current = createCompareView(parent, initial.doc, initial.theirs, { markdown: isNotePath(session.path) });
    shownTheirs.current = initial.theirs;
    handle.current.view.focus();
    return () => {
      handle.current?.destroy();
      handle.current = null;
    };
  }, [session, initial]);

  // Theirs changed again while comparing: refresh it in place.
  useEffect(() => {
    const h = handle.current;
    if (!h || theirs === shownTheirs.current || !conflict) return;
    updateCompareOriginal(h.view, shownTheirs.current, theirs);
    shownTheirs.current = theirs;
  }, [theirs, conflict]);

  // Resolved elsewhere (another device, Take theirs in another tab): nothing left to compare.
  useEffect(() => {
    if (snapshot.status !== 'conflict' && !saving) onClose();
  }, [snapshot.status, saving, onClose]);

  const save = async () => {
    const h = handle.current;
    if (!h) return;
    setSaving(true);
    try {
      await session.saveMerged(h.view.state.doc.toString());
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <Modal label="Compare your version with theirs" onClose={onClose} variant="sheet" className="compare-dialog" dismissible={!saving}>
      <header className="compare-header">
        <div>
          <h2 className="dialog-title">Compare versions</h2>
          <p className="compare-legend">
            <span className="compare-swatch is-mine" aria-hidden /> Your text
            <span className="compare-swatch is-theirs" aria-hidden /> Their text. Accept keeps yours, reject takes theirs.
          </p>
          {initial.autoMerged && <p className="compare-note">Merged automatically. Review the result before saving.</p>}
        </div>
        <div className="compare-tools">
          <button type="button" className="icon-button" aria-label="Previous change" title="Previous change" onClick={() => handle.current?.previous()}>
            <ChevronUp size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="Next change" title="Next change" onClick={() => handle.current?.next()}>
            <ChevronDown size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="Close compare" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div ref={host} className="compare-editor" />
      <footer className="dialog-actions compare-footer">
        <button type="button" className="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save merged'}
        </button>
      </footer>
    </Modal>
  );
}
