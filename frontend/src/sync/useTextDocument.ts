// The textual-view API of DESIGN §6.8: every textual view gets autosave, drafts, conflicts and
// live sync through its DocumentSession.
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { DocumentSession, Serializer, SessionSnapshot } from './DocumentSession';
import { documents } from './instance';

export interface TextDocument extends SessionSnapshot {
  session: DocumentSession;
  getText(): string;
  setText(text: string): void;
  markDirty(serialize?: Serializer): void;
  flush(): Promise<void>;
}

/** Acquires the session for `path` for the lifetime of the calling view. */
export function useDocumentSession(path: string): DocumentSession {
  const holder = useId();
  const [session, setSession] = useState(() => documents.acquire(path, holder));
  const [heldPath, setHeldPath] = useState(path);
  // A session replaced by another one moving onto its path is disposed: re-render and re-acquire.
  const disposed = useSyncExternalStore(session.subscribe, () => session.isDisposed);
  if (heldPath !== path) {
    // A different note (not a re-key of this one): switch sessions during render.
    setHeldPath(path);
    if (session.path !== path) setSession(documents.acquire(path, holder));
  } else if (disposed) {
    setSession(documents.acquire(path, holder));
  }
  useEffect(() => {
    documents.hold(session, holder);
    return () => documents.release(session, holder);
  }, [session, holder]);
  return session;
}

export function useSessionSnapshot(session: DocumentSession): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

/** Re-renders on every content change; for readers such as the reading view and word counts. */
export function useSessionChangeCount(session: DocumentSession): number {
  return useSyncExternalStore(session.subscribe, session.getChangeCount);
}

export function useTextDocument(path: string): TextDocument {
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  return {
    ...snapshot,
    session,
    getText: () => session.getText(),
    setText: (text) => session.setText(text),
    markDirty: (serialize) => session.markDirty(serialize),
    flush: () => session.flush(),
  };
}
