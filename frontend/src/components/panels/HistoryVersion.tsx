// A historical version (DESIGN §6.11): a read-only diff against the current text (default), the
// full old text, images side by side, and "Restore this version" / "Copy text". A deleted entry
// has no content at its own commit, so it is read from its parent ("Last version before deletion").
import { ChevronDown, ChevronUp, Copy, RotateCcw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage, isProblem, isVersionConflict } from '../../api/client';
import { api } from '../../api/endpoints';
import { currentTree, useHistoryContent, useTextFile, useTree } from '../../api/hooks';
import type { HistoryEntry } from '../../api/types';
import { createHistoryDiffView, createReadOnlyView, type DiffViewHandle } from '../../editor/historyDiff';
import { toLf } from '../../features/eol';
import { formatDateTime } from '../../features/format';
import { formatLimit, isLargeFile, largeFileLimit } from '../../features/largeFiles';
import { displayName, isNotePath } from '../../features/paths';
import { confirmAction } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { applyHistoryRestoreResult } from '../../sync/applyEvents';
import { documents } from '../../sync/instance';
import { syncTarget } from '../../sync/liveSync';
import { useDocumentSession, useSessionChangeCount } from '../../sync/useTextDocument';
import { kindOfPath } from '../../features/fileKinds';
import { Modal } from '../overlays/Modal';
import { toastError } from '../../features/errors';

interface Props {
  entry: HistoryEntry;
  currentPath: string;
  onClose(): void;
  /** Other versions of the file, offered in "Compare with" (ROADMAP item 28). */
  versions?: readonly HistoryEntry[];
}

/** The commit that holds an entry's content: its own, or its parent's for a deletion. */
const contentCommit = (e: HistoryEntry): string | null => (e.change === 'deleted' ? e.parentCommitId : e.commitId);
const versionKey = (e: HistoryEntry): string => `${e.commitId}:${e.path}`;

/** The current text to compare with: the open session's buffer, else the server copy. */
function useCurrentText(path: string, exists: boolean, textual: boolean): string | null {
  const open = documents.get(path);
  const file = useTextFile(exists && textual && !open ? path : null);
  if (!exists || !textual) return '';
  if (open) return null;
  return file.data ? toLf(file.data.content) : file.isError ? '' : null;
}

function SessionText({ path, children }: { path: string; children(text: string): ReactNode }) {
  const session = useDocumentSession(path);
  useSessionChangeCount(session);
  return <>{children(session.getText())}</>;
}

/** A read-only unified diff from `historical` (old) to `current` (new), with change navigation. */
export function DiffPane({
  historical,
  current,
  markdown,
  sameLabel = 'Identical to the current version',
}: {
  historical: string;
  current: string;
  markdown: boolean;
  sameLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<DiffViewHandle | null>(null);
  const [chunks, setChunks] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    handle.current = createHistoryDiffView(host.current, historical, current, { markdown });
    const count = handle.current.chunkCount();
    queueMicrotask(() => setChunks(count));
    return () => {
      handle.current?.destroy();
      handle.current = null;
    };
  }, [historical, current, markdown]);
  return (
    <div className="history-diff">
      <div className="history-diff-tools">
        <span className="muted">{chunks === null ? '' : chunks === 0 ? sameLabel : `${chunks} ${chunks === 1 ? 'change' : 'changes'}`}</span>
        <button type="button" className="icon-button" aria-label="Previous change" title="Previous change" onClick={() => handle.current?.previous()}>
          <ChevronUp size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="Next change" title="Next change" onClick={() => handle.current?.next()}>
          <ChevronDown size={16} />
        </button>
      </div>
      <div ref={host} className="history-editor" />
    </div>
  );
}

function FullTextPane({ text, markdown }: { text: string; markdown: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = createReadOnlyView(host.current, text, { markdown });
    return () => view.destroy();
  }, [text, markdown]);
  return <div ref={host} className="history-editor" />;
}

export default function HistoryVersion({ entry, currentPath, onClose, versions = [] }: Props) {
  const deleted = entry.change === 'deleted';
  const commit = deleted ? entry.parentCommitId : entry.commitId;
  const kind = kindOfPath(entry.path);
  const textual = kind === 'note' || kind === 'text';
  const markdown = isNotePath(entry.path);
  const tree = useTree().data;
  const currentEntry = tree?.byPath.get(currentPath);
  const content = useHistoryContent(textual ? commit : null, textual ? entry.path : null);
  const [tab, setTab] = useState<'diff' | 'text'>('diff');
  const [busy, setBusy] = useState(false);
  const open = documents.get(currentPath);
  const currentText = useCurrentText(currentPath, !!currentEntry, textual);
  const historical = content.data && content.data.content !== null ? toLf(content.data.content) : null;
  const others = versions.filter((v) => versionKey(v) !== versionKey(entry) && contentCommit(v) !== null);
  const [compareKey, setCompareKey] = useState('current');
  const other = others.find((v) => versionKey(v) === compareKey) ?? null;
  const otherContent = useHistoryContent(textual && other ? contentCommit(other) : null, textual && other ? other.path : null);
  const otherText = otherContent.data && otherContent.data.content !== null ? toLf(otherContent.data.content) : null;

  useEffect(() => {
    if (!commit) onClose();
  }, [commit, onClose]);

  const restore = async () => {
    if (!commit) return;
    // A file over the large-file threshold is not in history: the server keeps it in the trash instead.
    const limit = largeFileLimit();
    const large = currentEntry !== undefined && limit !== null && isLargeFile(currentEntry.size);
    const ok = await confirmAction({
      title: 'Restore this version?',
      message: !currentEntry
        ? `“${displayName(currentPath)}” will be brought back with its version from ${formatDateTime(entry.time)}.`
        : large
          ? `“${displayName(currentPath)}” will be replaced with the version from ${formatDateTime(entry.time)}. The current version is larger than ${formatLimit(limit)}, so it is not in history: it is moved to the trash instead.`
          : `“${displayName(currentPath)}” will be replaced with the version from ${formatDateTime(entry.time)}. The current version stays in history.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(true);
    const session = documents.get(currentPath);
    try {
      await session?.flush();
      const existing = currentTree().byPath.get(currentPath);
      const baseVersion = textual && existing ? (session?.currentVersion ?? existing.version) : null;
      const result = await api.restoreHistory({ path: currentPath, commit, sourcePath: entry.path, baseVersion });
      applyHistoryRestoreResult(syncTarget, result);
      toast(`Restored the version from ${formatDateTime(entry.time)}`);
      onClose();
    } catch (e) {
      if (isVersionConflict(e)) {
        // The note changed meanwhile: the session catches up (or enters conflict) first.
        void session?.onRemoteChanged({ version: e.problem.currentVersion });
        toast('The note changed meanwhile. Review it, then restore again.', { kind: 'error' });
      } else if (isProblem(e, 'already-exists')) {
        toast('A file exists at this path now. Open it, then restore from its history.', { kind: 'error' });
      } else {
        toastError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (historical === null) return;
    try {
      await navigator.clipboard.writeText(historical);
      toast('Copied the old version');
    } catch {
      toast('The browser refused clipboard access', { kind: 'error' });
    }
  };

  const diff = (current: string) => (historical === null ? null : <DiffPane historical={historical} current={current} markdown={markdown} />);

  // Two historical versions: always from the older to the newer one.
  const versionDiff = () => {
    if (!other || historical === null) return null;
    if (otherContent.isPending) {
      return (
        <div className="view-loading" aria-busy="true">
          <div className="skeleton-line" />
        </div>
      );
    }
    if (otherText === null) return <div className="panel-empty">{otherContent.isError ? errorMessage(otherContent.error) : 'That version is not text.'}</div>;
    const otherIsNewer = Date.parse(other.time) > Date.parse(entry.time);
    return (
      <DiffPane
        historical={otherIsNewer ? historical : otherText}
        current={otherIsNewer ? otherText : historical}
        markdown={markdown}
        sameLabel="The two versions are identical"
      />
    );
  };

  return (
    <Modal label={`Version of ${displayName(entry.path)}`} onClose={onClose} variant="sheet" className="history-version" dismissible={!busy}>
      <header className="compare-header">
        <div>
          <h2 className="dialog-title">{displayName(entry.path)}</h2>
          <p className="compare-legend">
            {deleted ? 'Last version before deletion' : entry.message} · <time dateTime={entry.time}>{formatDateTime(entry.time)}</time> · {entry.authorName} ·{' '}
            <code>{entry.shortId}</code>
          </p>
        </div>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {textual && (
        <div className="history-version-tools">
          <div className="segmented" role="tablist" aria-label="Version view">
            <button type="button" role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'is-active' : ''} onClick={() => setTab('diff')}>
              Diff
            </button>
            <button type="button" role="tab" aria-selected={tab === 'text'} className={tab === 'text' ? 'is-active' : ''} onClick={() => setTab('text')}>
              Full text
            </button>
          </div>
          {tab === 'diff' && others.length > 0 && (
            <label className="history-compare">
              Compare with
              <select value={other ? compareKey : 'current'} onChange={(e) => setCompareKey(e.target.value)} aria-label="Compare with">
                <option value="current">the current version</option>
                {others.map((v) => (
                  <option key={versionKey(v)} value={versionKey(v)}>
                    {formatDateTime(v.time)} · {v.change === 'deleted' ? 'last version before deletion' : v.message}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="history-version-body">
        {!textual ? (
          kind === 'image' && commit ? (
            <div className="history-images">
              <figure>
                <img src={api.historyRawUrl(entry.path, commit)} alt="This version" />
                <figcaption>This version</figcaption>
              </figure>
              <figure>
                {currentEntry ? <img src={api.rawUrl(currentEntry)} alt="Current version" /> : <div className="panel-empty">No current file</div>}
                <figcaption>Current version</figcaption>
              </figure>
            </div>
          ) : (
            <div className="panel-empty">
              <p>This file cannot be previewed.</p>
              {commit && (
                <a className="link-button" href={api.historyRawUrl(entry.path, commit)} download={displayName(entry.path)}>
                  Download this version
                </a>
              )}
            </div>
          )
        ) : content.isPending ? (
          <div className="view-loading" aria-busy="true">
            <div className="skeleton-line" />
          </div>
        ) : content.isError ? (
          <div className="panel-empty">{errorMessage(content.error)}</div>
        ) : historical === null ? (
          <div className="panel-empty">This version is not text.</div>
        ) : tab === 'text' ? (
          <FullTextPane text={historical} markdown={markdown} />
        ) : other ? (
          versionDiff()
        ) : open ? (
          <SessionText path={currentPath}>{diff}</SessionText>
        ) : currentText === null ? (
          <div className="view-loading" aria-busy="true">
            <div className="skeleton-line" />
          </div>
        ) : (
          diff(currentText)
        )}
      </div>
      <footer className="dialog-actions">
        {textual && (
          <button type="button" className="button" onClick={() => void copy()} disabled={historical === null}>
            <Copy size={14} aria-hidden /> Copy text
          </button>
        )}
        <button type="button" className="button button-primary" onClick={() => void restore()} disabled={busy || !commit || (textual && historical === null)}>
          <RotateCcw size={14} aria-hidden /> Restore this version
        </button>
      </footer>
    </Modal>
  );
}
