// Ref-counted registry of DocumentSessions (DESIGN §6.2). Sessions stay cached for the page's
// lifetime, so undo survives switching notes; a reopened session revalidates against the tree.
// The registry also owns the page-lifecycle flushes and the shared keepalive budget (§6.9).
import type { QueryClient } from '@tanstack/react-query';
import type { Endpoints } from '../api/endpoints';
import type { FileEntry, WriteResult } from '../api/types';
import { displayName, rebasePath } from '../features/paths';
import type { SaveSummary } from '../state/ui';
import { DocumentSession, type MergeFn, type Notice, type SessionDeps } from './DocumentSession';
import { orphanRecord, type DraftStore, type TabCoordinator } from './drafts';
import type { MoveMap } from './moves';
import { applyWriteResult } from './treePatch';

/** Fetch caps in-flight keepalive bodies at 64 KiB per page in total; keep a margin. */
export const KEEPALIVE_BUDGET = 60 * 1024;

export interface RegistryOptions {
  api: Pick<Endpoints, 'readFile' | 'saveFile'>;
  drafts: DraftStore;
  moves: MoveMap;
  clientId: string;
  queryClient: QueryClient | null;
  tabs: Pick<TabCoordinator, 'liveOwners'> | null;
  treeEntry(path: string): FileEntry | undefined;
  notify(notice: Notice): void;
  onDraftWrite(ok: boolean): void;
  onSummary(summary: SaveSummary): void;
  /** A session changed path; the app re-routes when it is the open note. */
  onSessionMoved(from: string, to: string): void;
  caughtUp(): boolean;
  /** The semantic merge of the view that shows a path (DESIGN §6.8). */
  mergeFor?(path: string): MergeFn | undefined;
}

export class DocumentRegistry {
  private readonly sessions = new Map<string, DocumentSession>();
  /** The views holding each session; a session without holders is dormant (cached, flushed). */
  private readonly holders = new Map<DocumentSession, Set<string>>();
  private readonly opts: RegistryOptions;
  private readonly deps: SessionDeps;
  private lastSummary: SaveSummary | null = null;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.deps = {
      api: opts.api,
      drafts: opts.drafts,
      moves: opts.moves,
      clientId: opts.clientId,
      liveDraftOwners: (path) => (opts.tabs ? opts.tabs.liveOwners(path) : Promise.resolve(new Set())),
      onWriteResult: (result: WriteResult, content: string) => {
        if (opts.queryClient) applyWriteResult(opts.queryClient, result, content);
      },
      onRekey: (session, from, authoritative) => this.rekeySession(session, from, authoritative),
      onChange: () => this.updateSummary(),
      notify: opts.notify,
      onDraftWrite: opts.onDraftWrite,
      caughtUp: opts.caughtUp,
      treeVersion: (path) => opts.treeEntry(path)?.version,
      mergeFor: opts.mergeFor,
    };
  }

  /**
   * Opens (or reuses) the session for `path` on behalf of `holder` (a view id); pair with
   * `release`. Holding is idempotent per holder, which keeps React's double invocations harmless.
   */
  acquire(path: string, holder: string): DocumentSession {
    let session = this.sessions.get(path);
    if (session && session.isDisposed) {
      this.sessions.delete(path);
      session = undefined;
    }
    if (!session) {
      session = new DocumentSession(path, this.deps);
      this.sessions.set(path, session);
      this.holders.set(session, new Set([holder]));
      return session;
    }
    this.hold(session, holder);
    return session;
  }

  /** Re-asserts a holder (after an effect cleanup ran). */
  hold(session: DocumentSession, holder: string): void {
    const set = this.holders.get(session) ?? new Set<string>();
    const wasDormant = set.size === 0;
    set.add(holder);
    this.holders.set(session, set);
    // A reopened note may have changed while closed: compare with the tree's version (kept current by SSE).
    if (wasDormant) void session.revalidate(this.opts.treeEntry(session.path)?.version ?? undefined);
  }

  /** Releases a holder; the last release flushes (the session stays cached). */
  release(session: DocumentSession, holder: string): void {
    const set = this.holders.get(session);
    if (!set || !set.delete(holder)) return;
    if (set.size === 0) void session.flush();
  }

  get(path: string): DocumentSession | undefined {
    const s = this.sessions.get(path);
    return s && !s.isDisposed ? s : undefined;
  }

  all(): DocumentSession[] {
    return [...this.sessions.values()].filter((s) => !s.isDisposed);
  }

  /** Closes a session for good (deleted or discarded note). */
  close(session: DocumentSession): void {
    session.dispose();
    if (this.sessions.get(session.path) === session) this.sessions.delete(session.path);
    this.holders.delete(session);
    this.updateSummary();
  }

  /**
   * `session` moves from `from` to its new `path`. Another session already there is replaced only
   * when it cannot hold a live note: a move the server reported itself (`authoritative`) means
   * the path was free, so such a session is a stale tombstone; its unsaved text, if any, is kept
   * in the discarded store. A move inferred from a 409 `movedTo` or the move map is refused when
   * the session there shows an existing note or holds unsaved text (the move info is stale).
   */
  private rekeySession(session: DocumentSession, from: string, authoritative: boolean): boolean {
    const existing = this.sessions.get(session.path);
    if (existing && existing !== session && !existing.isDisposed) {
      if (!authoritative && (existing.hasUnsavedChanges() || existing.showsExistingFile())) return false;
      if (existing.hasUnsavedChanges()) this.preserve(existing);
      existing.dispose();
      this.holders.delete(existing);
    }
    if (this.sessions.get(from) === session) this.sessions.delete(from);
    this.sessions.set(session.path, session);
    this.opts.onSessionMoved(from, session.path);
    return true;
  }

  /** Keeps a displaced session's unsaved text recoverable (Settings › This device). */
  private preserve(session: DocumentSession): void {
    const { path, eol } = session.getSnapshot();
    void this.opts.drafts
      .discard(orphanRecord({ path, text: session.getText(), eol, at: Date.now() }))
      .then(() => this.opts.notify({ message: `Unsaved text of ${displayName(path)} was kept in Settings › This device` }))
      .catch(() => this.opts.onDraftWrite(false));
  }

  /** Applies a move (own MoveResult or entry.moved) to every affected session. */
  applyMove(from: string, to: string, type: 'file' | 'folder'): void {
    for (const session of this.all()) {
      const next = type === 'file' ? (session.path === from ? to : null) : rebasePath(session.path, from, to);
      if (next !== null && next !== session.path) session.onRemoteMoved(next);
    }
  }

  /** Whether this tab holds unsaved text (and so owns a draft) for `path`. */
  ownsDraft(path: string): boolean {
    const s = this.get(path);
    return !!s && s.hasUnsavedChanges();
  }

  /** Unsaved text, a save in flight, or an attachment still uploading into a note. */
  anyUnsaved(): boolean {
    return this.all().some((s) => s.hasUnsavedChanges() || s.currentStatus === 'saving' || s.uploadsInFlight > 0);
  }

  async flushAll(): Promise<void> {
    await Promise.all(this.all().map((s) => s.flush()));
  }

  /** `pagehide`: dirty sessions go out with keepalive, smallest first, within the shared budget. */
  keepaliveAll(): void {
    let budget = KEEPALIVE_BUDGET;
    const pending = this.all()
      .filter((s) => ['dirty', 'saving', 'offline', 'storage-error'].includes(s.currentStatus))
      .sort((a, b) => a.pendingBodySize() - b.pendingBodySize());
    for (const s of pending) budget -= s.keepaliveSave(budget);
  }

  retryAll(): void {
    for (const s of this.all()) s.retryNow();
  }

  /** After a resync: every session compares its version with the fresh tree (a missing entry is re-read). */
  revalidateAll(): void {
    for (const s of this.all()) {
      const entry = this.opts.treeEntry(s.path);
      void s.revalidate(entry?.version ?? undefined);
    }
  }

  private updateSummary(): void {
    const sessions = this.all();
    // A note that failed to load holds no text: it is not unsaved.
    const statuses = sessions.map((s) => (s.currentStatus === 'error' && !s.hasUnsavedChanges() ? 'clean' : s.currentStatus));
    const summary: SaveSummary = statuses.includes('conflict')
      ? 'conflict'
      : statuses.includes('storage-error')
        ? 'storage-error'
        : statuses.includes('offline')
          ? 'offline'
          : statuses.includes('saving')
            ? 'saving'
            : statuses.includes('dirty') || statuses.includes('error')
              ? 'unsaved'
              : 'saved';
    if (summary !== this.lastSummary) {
      this.lastSummary = summary;
      this.opts.onSummary(summary);
    }
  }

  /** Flushes on hide, keepalive-saves on pagehide, and warns before unloading unsaved text. */
  installLifecycle(isDesktop: () => boolean): () => void {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void this.flushAll();
    };
    const onPageHide = () => this.keepaliveAll();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDesktop() && this.anyUnsaved()) e.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }
}
