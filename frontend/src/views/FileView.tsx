// Route target for /n/<path> (DESIGN §6.4): picks the view descriptor, lazy-loads it, and wraps
// it in an error boundary with "Reload view". Textual views get the conflict banner for free.
import { FileX } from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useState, type ComponentType } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTree } from '../api/hooks';
import type { FileEntry } from '../api/types';
import { findFileIgnoreCase } from '../api/vaultTree';
import { ConflictBanner } from '../components/ConflictBanner';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { OrphanDraftNotice } from '../components/OrphanDrafts';
import { useNoteMode, viewModeFor } from '../features/noteMode';
import { noteRoute, pathFromLocation } from '../features/paths';
import { recordOpened } from '../features/recent';
import { documents, moveMap } from '../sync/instance';
import { useDocumentSession } from '../sync/useTextDocument';
import { viewFor, type FileViewDescriptor, type FileViewProps } from './registry';

const lazyViews = new Map<string, ComponentType<FileViewProps>>();

function lazyView(d: FileViewDescriptor): ComponentType<FileViewProps> {
  let c = lazyViews.get(d.id);
  if (!c) {
    c = lazy(d.load);
    lazyViews.set(d.id, c);
  }
  return c;
}

function DocumentBanner({ path, merge }: { path: string; merge: FileViewDescriptor['merge'] }) {
  const session = useDocumentSession(path);
  return <ConflictBanner session={session} merge={merge} />;
}

export function FileView() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = pathFromLocation(location.pathname);
  const tree = useTree();
  const mode = useNoteMode();
  const treeEntry = path && tree.data ? tree.data.byPath.get(path) : undefined;
  // A note deleted elsewhere stays on screen with its tombstone or banner while its session lives.
  const [lastEntry, setLastEntry] = useState<FileEntry | null>(treeEntry ?? null);
  if (treeEntry && treeEntry !== lastEntry) setLastEntry(treeEntry);
  const entry = treeEntry ?? (lastEntry && lastEntry.path === path && documents.get(lastEntry.path) ? lastEntry : undefined);
  const caseVariant = path && tree.data && !entry ? findFileIgnoreCase(tree.data, path) : undefined;
  // The view's identity survives a rename or move of the open file (its own inline title,
  // another device): remounting it would destroy the focused editor mid-sentence and close the
  // phone's keyboard. Opening a different file mounts a fresh view.
  const [view, setView] = useState<{ path: string | null; key: string }>({ path: entry?.path ?? null, key: entry?.path ?? '' });
  if (entry && entry.path !== view.path) {
    const renamed = view.path !== null && moveMap.lookup(view.path) === entry.path;
    setView({ path: entry.path, key: renamed ? view.key : entry.path });
  }
  const viewKey = entry && entry.path === view.path ? view.key : (entry?.path ?? '');

  // A link typed with another case lands on the real path.
  useLayoutEffect(() => {
    if (caseVariant) navigate(noteRoute(caseVariant.path) + location.search + location.hash, { replace: true });
  }, [caseVariant, navigate, location.search, location.hash]);

  useEffect(() => {
    if (treeEntry) {
      recordOpened(treeEntry.path);
      document.title = `${treeEntry.kind === 'note' ? treeEntry.basename : treeEntry.name} · Notes`;
    }
  }, [treeEntry]);

  if (tree.isPending) {
    return (
      <div className="view-loading" aria-busy="true">
        <div className="skeleton-line" />
        <div className="skeleton-line short" />
      </div>
    );
  }
  if (!path || !entry) {
    if (caseVariant) return null;
    return (
      <div className="empty-state">
        <FileX size={40} aria-hidden />
        <h2>File not found</h2>
        <p>{path ? `“${path}” is not in the vault. It may have been moved or deleted.` : 'No file selected.'}</p>
        {path && <OrphanDraftNotice path={path} />}
      </div>
    );
  }

  const descriptor = viewFor(entry);
  const View = lazyView(descriptor);
  const viewMode = viewModeFor(mode, descriptor.modes);
  return (
    <ErrorBoundary key={viewKey} label="view">
      {descriptor.textual && <DocumentBanner path={entry.path} merge={descriptor.merge} />}
      <Suspense
        fallback={
          <div className="view-loading" aria-busy="true">
            <div className="skeleton-line" />
          </div>
        }
      >
        {/* View comes from a module-level cache keyed by descriptor id, so its identity is stable. */}
        {/* eslint-disable-next-line react-hooks/static-components */}
        <View path={entry.path} entry={entry} mode={viewMode} />
      </Suspense>
    </ErrorBoundary>
  );
}
