// One open text document: load, edit, autosave, drafts, live sync and conflicts
// (DESIGN §6.3, §6.9, §6.10). Lives outside React; views subscribe to its snapshot.
//
// The live content is CodeMirror's Text inside the session's EditorState (LF-only). Strings are
// produced only for saves and drafts. `baseText` is the content at `version`, kept for merges.
import { history } from '@codemirror/commands';
import { EditorState, Transaction, type ChangeSpec, type Extension, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { errorMessage, isProblem, isStorageProblem, isTransient, isVersionConflict, type ApiError } from '../api/client';
import type { Endpoints } from '../api/endpoints';
import type { FileEntry, TextFile, Version, WriteResult } from '../api/types';
import { markdownNoteLanguage } from '../editor/language';
import { remoteChanges, remoteTransaction, sessionEdit, waitForComposition } from '../editor/remote';
import { addUpload, endUpload, pendingUploads, uploadsField } from '../editor/uploads';
import { detectEol, fromLf, toLf, type Eol } from '../features/eol';
import { isNotePath } from '../features/paths';
import { DRAFT_MAX_AGE_MS, type DraftRecord, type DraftStore } from './drafts';
import type { MoveMap } from './moves';
import { entryAtPath } from './treePatch';

export type SessionStatus =
  | 'loading'
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'offline'
  | 'storage-error'
  | 'conflict'
  | 'deleted'
  | 'readonly'
  | 'error';

export interface ConflictInfo {
  /** The server's text (LF). */
  theirsText: string;
  theirsVersion: Version;
  /** The line-ending style of the server's copy (Take theirs keeps it). */
  theirsEol: Eol;
  /** Merge base when known (the content mine was based on). */
  baseText: string | null;
  source: 'save' | 'remote' | 'draft';
  /** A flushHistory save was refused with 503 history-unavailable. */
  historyBlocked: boolean;
}

export interface DeletedInfo {
  trashId: string | null;
  /** Unsaved local edits exist (banner) rather than a clean tombstone. */
  hasLocalEdits: boolean;
}

export interface SessionSnapshot {
  path: string;
  status: SessionStatus;
  /** The file's content was read at least once; until then there is no buffer to show. */
  loaded: boolean;
  version: Version | null;
  eol: Eol;
  lossy: boolean;
  conflict: ConflictInfo | null;
  deleted: DeletedInfo | null;
  error: string | null;
  /** The last save was refused with 413 too-large (status `error`): the text stays editable. */
  tooLarge: boolean;
  /** Epoch ms of the next automatic retry while offline or failing. */
  retryAt: number | null;
}

export interface Notice {
  message: string;
  action?: { label: string; run: () => void };
}

export interface SessionDeps {
  api: Pick<Endpoints, 'readFile' | 'saveFile'>;
  drafts: DraftStore;
  moves: MoveMap;
  clientId: string;
  /** Client ids of other live tabs owning drafts for a path. */
  liveDraftOwners(path: string): Promise<Set<string>>;
  /** Own-mutation cache patches (DESIGN §6.3) for a processed save. `content` is as sent. */
  onWriteResult(result: WriteResult, content: string): void;
  /**
   * The session moves to `to` (409 movedTo, entry.moved, MoveResult). Returns false when the
   * move must not happen: another session there holds a live note. `authoritative` moves come
   * from the server's own account of the move (events, MoveResults, a save's answer); a 409
   * `movedTo` or a move-map lookup may be stale and is refused more readily.
   */
  onRekey(session: DocumentSession, from: string, authoritative: boolean): boolean;
  onChange(session: DocumentSession): void;
  notify(notice: Notice): void;
  onDraftWrite(ok: boolean): void;
  /** True once the event stream has caught up; queued retries wait for it. */
  caughtUp(): boolean;
  /** The tree's version for a path (null for a file without one, undefined when not in the tree). */
  treeVersion?(path: string): Version | null | undefined;
  /** The view's semantic 3-way merge for a path (DESIGN §6.8), when it has one. */
  mergeFor?(path: string): MergeFn | undefined;
}

/** `FileViewDescriptor.merge`: the merged text, or null when the view cannot merge these versions. */
export type MergeFn = (base: string, mine: string, theirs: string) => string | null;

export const DEBOUNCE_MS = 1000;
export const MAX_WAIT_MS = 5000;
export const DRAFT_INTERVAL_MS = 500;
export const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const BASE_TEXT_DRAFT_LIMIT = 1_000_000;

const idle: (cb: () => void) => void =
  typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
    ? (cb) => window.requestIdleCallback(() => cb(), { timeout: 1000 })
    : (cb) => setTimeout(cb, 1);

const AUTOSAVE: ReadonlySet<SessionStatus> = new Set(['dirty', 'offline', 'storage-error']);
const UNSAVED: ReadonlySet<SessionStatus> = new Set(['dirty', 'saving', 'offline', 'storage-error', 'conflict', 'error']);

/** A remote event that arrived while a load or a save was running; the last one wins. */
type DeferredEvent = { kind: 'changed'; version: Version | null } | { kind: 'deleted'; trashId: string | null };

let uploadSeq = 0;

export class DocumentSession {
  path: string;
  private readonly deps: SessionDeps;
  private state: EditorState;
  private view: EditorView | null = null;
  private selectionKnown = false;
  private serializer: (() => string) | null = null;

  private status: SessionStatus = 'loading';
  /** The content was read at least once; a session that never loaded has no buffer. */
  private loaded = false;
  private version: Version | null = null;
  private baseText = '';
  private eol: Eol = 'lf';
  private lossy = false;
  private conflict: ConflictInfo | null = null;
  private deleted: DeletedInfo | null = null;
  private error: string | null = null;
  /** LF length of the text a 413 refused; a shorter text is tried again. */
  private refusedLength: number | null = null;

  /** Increments on every local change; a save records the count it covered. */
  private changes = 0;
  private savedChanges = 0;
  private firstUnsavedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private flushHistoryNext = false;
  private deferred: DeferredEvent | null = null;
  private reconcileSeq = 0;
  private uploads = 0;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private retryAt: number | null = null;

  private remoteChanges = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;
  private disposed = false;
  private loadPromise: Promise<void>;

  constructor(path: string, deps: SessionDeps) {
    this.path = path;
    this.deps = deps;
    this.state = EditorState.create({ doc: '', extensions: this.baseExtensions() });
    this.snapshot = this.makeSnapshot();
    this.loadPromise = this.load();
  }

  /** Settles when the current load (the first one, or a reload after a failure) has finished. */
  get ready(): Promise<void> {
    return this.loadPromise;
  }

  /** Undo history, pending uploads, and the note language so headings and links are readable without an editor. */
  private baseExtensions(): Extension[] {
    return isNotePath(this.path) ? [history(), uploadsField, markdownNoteLanguage()] : [history(), uploadsField];
  }

  // ---------- observation ----------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  /** Increments on every content change (local or remote); readers re-render from it. */
  getChangeCount = (): number => this.changes + this.remoteChanges;

  /**
   * Increments whenever the session itself puts text into the buffer (load, remote change, Take
   * theirs, merge, restored draft, an edit from outside the view), also when that text equals the
   * buffer's. A view that keeps its own model (`markDirty(serialize)`) re-reads the buffer when it
   * changes.
   */
  get remoteChangeCount(): number {
    return this.remoteChanges;
  }

  private makeSnapshot(): SessionSnapshot {
    return {
      path: this.path,
      status: this.status,
      loaded: this.loaded,
      version: this.version,
      eol: this.eol,
      lossy: this.lossy,
      conflict: this.conflict,
      deleted: this.deleted,
      error: this.error,
      tooLarge: this.refusedLength !== null,
      retryAt: this.retryAt,
    };
  }

  /** Notifies listeners; the snapshot object changes only when one of its fields did. */
  private emit(): void {
    const next = this.makeSnapshot();
    const prev = this.snapshot;
    const changed = (Object.keys(next) as Array<keyof SessionSnapshot>).some((k) => next[k] !== prev[k]);
    if (changed) this.snapshot = next;
    for (const fn of [...this.listeners]) fn();
    if (changed) this.deps.onChange(this);
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.emit();
  }

  get currentStatus(): SessionStatus {
    return this.status;
  }

  get currentVersion(): Version | null {
    return this.version;
  }

  /** True when the buffer holds text the server does not have yet. */
  hasUnsavedChanges(): boolean {
    if (!this.loaded) return false;
    return UNSAVED.has(this.status) || (this.status === 'deleted' && !!this.deleted?.hasLocalEdits);
  }

  /** The session believes a file exists at its path and has read it (not a tombstone, not a failed load). */
  showsExistingFile(): boolean {
    return this.loaded && this.status !== 'deleted';
  }

  /** Attachments still uploading into this document (their embeds are not in the text yet). */
  get uploadsInFlight(): number {
    return this.uploads;
  }

  /** Local edits the server has not acknowledged (whatever the status says). */
  private hasLocalEdits(): boolean {
    return this.changes !== this.savedChanges;
  }

  // ---------- content ----------

  /** The live editor state (the attached view's, when there is one). */
  get editorState(): EditorState {
    return this.view ? this.view.state : this.state;
  }

  /**
   * The document text, LF-only. A view that marks edits with a serializer (DESIGN §6.8) is asked
   * for it; text the session put into the buffer itself (a load, a remote change, Take theirs, a
   * merge, a restored draft, an edit from outside the view) is the text until the view reports its
   * next edit, so that text is never shadowed by a scene the view has not caught up with yet.
   */
  getText(): string {
    return this.serializer ? this.serializer() : this.editorState.doc.toString();
  }

  get baseContent(): string {
    return this.baseText;
  }

  /** Called by an editor host once its view exists. */
  attach(view: EditorView): void {
    this.view = view;
    this.selectionKnown = true;
  }

  /**
   * Where an insertion from outside the editor goes (templates, DESIGN §6.12): the editor's
   * selection, which CodeMirror keeps after blur, or the end when this note has not been in an
   * editor during this page load.
   */
  insertionRange(): { from: number; to: number } {
    const state = this.editorState;
    if (!this.selectionKnown) return { from: state.doc.length, to: state.doc.length };
    const { from, to } = state.selection.main;
    return { from, to };
  }

  /** Reconfigured state for a new editor mount (keeps doc, selection and undo history). */
  prepareState(reconfigure: (state: EditorState) => EditorState): EditorState {
    this.state = reconfigure(this.editorState);
    return this.state;
  }

  detach(view: EditorView): void {
    if (this.view !== view) return;
    this.state = view.state;
    this.view = null;
  }

  /**
   * Applies a local edit from outside the editor (reading-view checkbox, generic views, a restored
   * text, a linked mention), at positions in `getText()`. A view that keeps its own model
   * (`markDirty(serialize)`) may have edits the buffer does not show yet: the buffer takes them
   * first, and the edited buffer is then the text, which such a view re-reads like any other text
   * the session puts there (`remoteChangeCount`).
   */
  applyEdit(
    changes: ChangeSpec,
    opts: { selection?: { anchor: number; head?: number }; userEvent?: string; effects?: StateEffect<unknown>[] } = {},
  ): void {
    if (!this.isEditable()) return;
    this.settleSerializer();
    const spec = { changes, selection: opts.selection, effects: opts.effects, userEvent: opts.userEvent ?? 'input', scrollIntoView: !!opts.selection };
    this.remoteChanges++;
    if (this.view) {
      this.view.dispatch(spec);
      // The editor's update listener calls markDirty.
      return;
    }
    this.state = this.state.update(spec).state;
    this.markDirty();
  }

  /** Replaces the whole text as a local edit (generic textual views, a restored text). */
  setText(text: string): void {
    if (!this.isEditable()) return;
    this.settleSerializer();
    this.applyEdit(remoteChanges(this.editorState.doc.toString(), text));
  }

  /**
   * The serialized text of a view that keeps its own model becomes the buffer's, outside the undo
   * history and without counting as an edit (it is the text already); the serializer goes.
   */
  private settleSerializer(): void {
    const serialize = this.serializer;
    if (!serialize) return;
    this.serializer = null;
    const spec = remoteTransaction(this.editorState, serialize());
    if (!spec) return;
    if (this.view) this.view.dispatch(spec);
    else this.state = this.state.update(spec).state;
  }

  /** Effects that change no text (pending uploads). */
  private dispatchEffects(effects: StateEffect<unknown>[]): void {
    if (this.view) this.view.dispatch({ effects });
    else this.state = this.state.update({ effects }).state;
  }

  isEditable(): boolean {
    return this.loaded && this.status !== 'loading' && this.status !== 'readonly';
  }

  // ---------- load and revalidation ----------

  private async load(): Promise<void> {
    let file: TextFile;
    try {
      file = await this.deps.api.readFile(this.path);
    } catch (e) {
      if (this.disposed) return;
      this.error = isProblem(e, 'too-large') ? 'This file is too large to edit here; download it instead.' : errorMessage(e);
      const pending = this.deferred;
      this.deferred = null;
      // A transient failure (a deploy, a network blip) is retried with backoff, like a save.
      if (isTransient(e) || isStorageProblem(e)) this.scheduleLoadRetry(isTransient(e) ? e.retryAfterMs : null);
      this.setStatus('error');
      // The file was (re)created while the read failed: read it again.
      if (pending?.kind === 'changed') void this.reload();
      return;
    }
    if (this.disposed) return;
    this.retryAttempt = 0;
    this.retryAt = null;
    this.adopt(file);
    await this.restoreDrafts(file);
    const pending = this.deferred;
    this.deferred = null;
    if (pending?.kind === 'deleted') {
      // The read happened before the delete (a later read would have failed).
      this.onRemoteDeleted(pending.trashId);
    } else if (pending && pending.version !== this.version) {
      await this.reconcileWithServer();
    }
  }

  private scheduleLoadRetry(retryAfterMs: number | null): void {
    const backoff = BACKOFF_MS[Math.min(this.retryAttempt, BACKOFF_MS.length - 1)];
    this.retryAttempt++;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    this.retryAt = Date.now() + delay;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      void this.reload();
    }, delay);
  }

  /** Reads the file again after a load failure (Try again, a retry, a remote change). */
  reload(): Promise<void> {
    if (this.loaded || this.disposed || this.status !== 'error') return this.loadPromise;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.error = null;
    this.retryAt = null;
    this.setStatus('loading');
    this.loadPromise = this.load();
    return this.loadPromise;
  }

  /** Resolves once no load is running (a reload started by reopening the note included). */
  async whenSettled(): Promise<void> {
    while (this.status === 'loading' && !this.disposed) await this.loadPromise;
  }

  /** The first content of a session (no view is attached before it loads). */
  private adopt(file: TextFile): void {
    this.eol = detectEol(file.content);
    const text = toLf(file.content);
    this.state = EditorState.create({ doc: text, extensions: this.baseExtensions() });
    this.serializer = null;
    this.remoteChanges++;
    this.loaded = true;
    this.version = file.version;
    this.baseText = text;
    this.lossy = file.lossy;
    this.error = null;
    this.setStatus(file.lossy ? 'readonly' : 'clean');
  }

  /**
   * Remote text into the buffer: minimal diff, not undoable, composition-safe. While an IME
   * composition is active it waits for it to end; it then applies to whatever holds the
   * document by then (the view, or the session's own state after the view was destroyed).
   * Applies nothing when local edits arrived during the wait, or when a newer reconcile than
   * `seq` took over.
   */
  private async replaceRemote(text: string, seq: number): Promise<'applied' | 'edited' | 'superseded'> {
    const view = this.view;
    if (view && view.composing) {
      const before = this.changes;
      await waitForComposition(view);
      if (this.disposed || seq !== this.reconcileSeq) return 'superseded';
      if (this.changes !== before) return 'edited';
    }
    this.applyRemoteNow(text);
    return 'applied';
  }

  private applyRemoteNow(text: string): void {
    if (this.view) {
      const spec = remoteTransaction(this.view.state, text);
      if (spec) this.view.dispatch(spec);
    } else {
      const spec = remoteTransaction(this.state, text);
      if (spec) this.state = this.state.update(spec).state;
    }
    this.serializer = null;
    this.remoteChanges++;
  }

  /** Replaces the buffer as an ordinary undoable edit that does not mark the session dirty. */
  private replaceUndoable(text: string): void {
    const spec = {
      changes: remoteChanges(this.editorState.doc.toString(), text),
      annotations: [sessionEdit.of(true), Transaction.userEvent.of('input.replace')],
    };
    if (this.view) this.view.dispatch(spec);
    else this.state = this.state.update(spec).state;
    this.serializer = null;
    this.remoteChanges++;
  }

  /**
   * Revalidates against the server (reopen, resync). `knownVersion` is the tree's version, which
   * SSE keeps current; when it equals ours nothing needs fetching.
   */
  async revalidate(knownVersion?: Version | null): Promise<void> {
    // A note that never loaded reads again at once (synchronously entering `loading`).
    if (!this.loaded && this.status === 'error') return this.reload();
    await this.ready;
    if (this.disposed || this.status === 'loading') return;
    if (!this.loaded) return this.reload();
    if (knownVersion !== undefined && knownVersion !== null && knownVersion === this.version && this.status !== 'deleted') return;
    if (this.inFlight) return;
    await this.reconcileWithServer(true);
  }

  /**
   * `file.changed` (or `file.created`, a restore) for this path (API.md §4 step 5, DESIGN §6.10).
   * `quiet` suppresses the "Updated from another device" notice for this tab's own operations.
   */
  async onRemoteChanged(entry: Pick<FileEntry, 'version'>, opts: { quiet?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (this.status === 'loading' || this.inFlight) {
      this.deferred = { kind: 'changed', version: entry.version };
      return;
    }
    // Never loaded: there is no buffer to reconcile, only a file to read.
    if (!this.loaded) return this.reload();
    if (entry.version !== null && entry.version === this.version && this.status !== 'deleted') return;
    await this.reconcileWithServer(opts.quiet ?? false);
  }

  private async reconcileWithServer(quiet = false): Promise<void> {
    if (!this.loaded) return this.reload();
    const seq = ++this.reconcileSeq;
    let file: TextFile;
    try {
      file = await this.deps.api.readFile(this.path);
    } catch (e) {
      if (seq === this.reconcileSeq && isProblem(e, 'not-found')) this.onRemoteDeleted(this.deleted?.trashId ?? null);
      return;
    }
    // A later reconcile (a newer event) supersedes this one.
    if (this.disposed || seq !== this.reconcileSeq) return;
    if (file.version === this.version) {
      // Restored (or recreated) with exactly the content this session was based on.
      if (this.status === 'deleted') this.leaveDeleted();
      return;
    }
    if (this.inFlight) {
      // A save started meanwhile; compare again once it settles.
      this.deferred = { kind: 'changed', version: file.version };
      return;
    }
    const theirs = toLf(file.content);
    const theirsEol = detectEol(file.content);
    const mine = this.getText();
    if (theirs === mine) {
      this.adoptVersion(file.version, theirs, theirsEol);
      return;
    }
    switch (this.status) {
      case 'clean':
      case 'readonly': {
        // Text the server never acknowledged is never replaced silently.
        if (this.hasLocalEdits()) {
          this.enterConflict(theirs, file.version, theirsEol, 'remote');
          return;
        }
        const outcome = await this.replaceRemote(theirs, seq);
        // The user typed while an IME composition held the update back: compare again.
        if (outcome === 'edited') await this.reconcileWithServer(quiet);
        if (outcome !== 'applied') return;
        this.eol = theirsEol;
        this.version = file.version;
        this.baseText = theirs;
        this.lossy = file.lossy;
        this.setStatus(file.lossy ? 'readonly' : 'clean');
        if (!quiet) this.deps.notify({ message: 'Updated from another device' });
        return;
      }
      case 'conflict':
        // Theirs changed again: a version the view's merge can read resolves the banner.
        if (this.tryMerge(theirs, file.version, theirsEol, this.conflict!.baseText)) return;
        this.conflict = { ...this.conflict!, theirsText: theirs, theirsVersion: file.version, theirsEol };
        this.emit();
        return;
      case 'deleted':
        if (!this.deleted?.hasLocalEdits && !this.hasLocalEdits()) {
          const outcome = await this.replaceRemote(theirs, seq);
          if (outcome === 'edited') await this.reconcileWithServer(quiet);
          if (outcome !== 'applied') return;
          this.deleted = null;
          this.eol = theirsEol;
          this.version = file.version;
          this.baseText = theirs;
          this.lossy = file.lossy;
          this.error = null;
          this.setStatus(file.lossy ? 'readonly' : 'clean');
          return;
        }
        this.deleted = null;
        this.enterConflict(theirs, file.version, theirsEol, 'remote');
        return;
      default:
        this.enterConflict(theirs, file.version, theirsEol, 'remote');
    }
  }

  /** The server has exactly our text: adopt its version and drop the draft. */
  private adoptVersion(version: Version, text: string, eol: Eol): void {
    this.version = version;
    this.baseText = text;
    this.eol = eol;
    this.conflict = null;
    this.deleted = null;
    this.error = null;
    this.refusedLength = null;
    this.flushHistoryNext = false;
    this.savedChanges = this.changes;
    this.clearTimers();
    this.retryAttempt = 0;
    this.retryAt = null;
    void this.removeOwnDraft();
    this.setStatus(this.lossy ? 'readonly' : 'clean');
  }

  private enterConflict(theirsText: string, theirsVersion: Version, theirsEol: Eol, source: ConflictInfo['source']): void {
    if (this.tryMerge(theirsText, theirsVersion, theirsEol, this.baseText)) return;
    this.clearSaveTimers();
    this.conflict = { theirsText, theirsVersion, theirsEol, baseText: this.baseText, source, historyBlocked: false };
    this.setStatus('conflict');
  }

  /**
   * A view's semantic merge (DESIGN §6.8) settles a conflict without the banner: the merged text
   * becomes a local edit on top of theirs, saved like "Save merged" (with flushHistory, so the
   * server commits theirs first). False when the view has no merge, the base is unknown, or the
   * merge gives up; the banner then appears as usual.
   */
  private tryMerge(theirsText: string, theirsVersion: Version, theirsEol: Eol, baseText: string | null): boolean {
    const merge = this.deps.mergeFor?.(this.path);
    if (!merge || baseText === null || !this.loaded || this.lossy) return false;
    let merged: string | null;
    try {
      merged = merge(baseText, this.getText(), theirsText);
    } catch (e) {
      console.error('[notesapp] merge failed', e);
      merged = null;
    }
    if (merged === null) return false;
    this.clearSaveTimers();
    if (merged === theirsText) {
      // Everything mine changed is in theirs already.
      this.replaceUndoable(theirsText);
      this.adoptVersion(theirsVersion, theirsText, theirsEol);
    } else {
      this.replaceUndoable(merged);
      this.version = theirsVersion;
      this.baseText = theirsText;
      this.conflict = null;
      this.deleted = null;
      this.flushHistoryNext = true;
      this.changes++;
      if (this.firstUnsavedAt === null) this.firstUnsavedAt = Date.now();
      this.setStatus('dirty');
      // The merge is unsaved work: a killed tab restores it (as a pending merge), not the old text.
      void this.writeDraft();
      this.scheduleSave(true);
    }
    this.deps.notify({ message: 'Merged changes from another device' });
    return true;
  }

  /** `file.deleted` for this path. */
  onRemoteDeleted(trashId: string | null): void {
    if (this.disposed) return;
    if (this.status === 'loading' || this.inFlight) {
      this.deferred = { kind: 'deleted', trashId };
      return;
    }
    // A note that never loaded has nothing to keep; a later read reports it missing.
    if (!this.loaded) return;
    const hasLocalEdits = this.hasLocalEdits() || !!this.deleted?.hasLocalEdits;
    this.clearTimers();
    this.conflict = null;
    this.deleted = { trashId, hasLocalEdits };
    this.setStatus('deleted');
  }

  /** `entry.moved` covering this path, or the tab's own MoveResult. */
  onRemoteMoved(to: string): void {
    if (to === this.path) return;
    if (!this.rekey(to, true)) return;
    if (this.status === 'deleted') this.leaveDeleted();
  }

  /** The file exists again at this session's path: back to clean, or to dirty with unsaved edits. */
  private leaveDeleted(): void {
    const unsaved = this.deleted?.hasLocalEdits ?? false;
    this.deleted = null;
    this.setStatus(unsaved ? 'dirty' : this.lossy ? 'readonly' : 'clean');
    if (unsaved) this.scheduleSave(true);
  }

  private rekey(to: string, authoritative: boolean): boolean {
    const from = this.path;
    this.path = to;
    if (!this.deps.onRekey(this, from, authoritative)) {
      this.path = from;
      return false;
    }
    void this.deps.drafts.rekey(from, to).catch(() => this.deps.onDraftWrite(false));
    this.emit();
    return true;
  }

  // ---------- local edits and autosave ----------

  /**
   * Records a local edit. `serialize` makes serialization lazy for non-CodeMirror views: the
   * session calls it only when it saves or writes a draft.
   */
  markDirty(serialize?: () => string): void {
    if (serialize) this.serializer = serialize;
    this.changes++;
    if (this.firstUnsavedAt === null) this.firstUnsavedAt = Date.now();
    if (this.status === 'clean') this.status = 'dirty';
    // Text a 413 refused: once it is shorter, autosave tries again.
    if (this.status === 'error' && this.refusedLength !== null && (this.serializer ? this.getText() : this.editorState.doc).length < this.refusedLength) this.status = 'dirty';
    if (this.status === 'deleted' && this.deleted) this.deleted = { ...this.deleted, hasLocalEdits: true };
    this.scheduleDraft();
    if (this.status === 'dirty') this.scheduleSave(false);
    this.emit();
  }

  private scheduleSave(immediate: boolean): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.save(), immediate ? 0 : DEBOUNCE_MS);
    if (!this.maxWaitTimer && !immediate) {
      const elapsed = Date.now() - (this.firstUnsavedAt ?? Date.now());
      this.maxWaitTimer = setTimeout(() => void this.save(), Math.max(0, MAX_WAIT_MS - elapsed));
    }
  }

  private clearSaveTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
  }

  private clearTimers(): void {
    this.clearSaveTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Saves now if there is anything to save; resolves when the session has settled. */
  async flush(): Promise<void> {
    // A save that failed with an unexpected problem is retried on an explicit flush (Mod-S).
    if (this.status === 'error' && this.loaded && this.hasLocalEdits()) this.status = 'dirty';
    for (let i = 0; i < 3; i++) {
      if (this.inFlight) await this.inFlight;
      if (!AUTOSAVE.has(this.status)) return;
      await this.save();
    }
  }

  /** Retries a failed save at once (the event stream caught up again, or the user asked). */
  retryNow(): void {
    if (this.status === 'offline' || this.status === 'storage-error') {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      void this.save();
    }
  }

  private async save(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!AUTOSAVE.has(this.status) || this.disposed) return;
    this.clearTimers();
    this.inFlight = this.performSave();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    await this.afterSave();
  }

  private async performSave(): Promise<void> {
    const text = this.getText();
    const covered = this.changes;
    const body = fromLf(text, this.eol);
    const flushHistory = this.flushHistoryNext;
    const baseVersion = this.version;
    const path = this.path;
    this.firstUnsavedAt = null;
    this.retryAt = null;
    this.setStatus('saving');
    try {
      const result = await this.deps.api.saveFile(path, { content: body, baseVersion, ...(flushHistory ? { flushHistory: true } : {}) });
      this.onSaved(result, text, body, covered, path);
    } catch (e) {
      await this.onSaveFailed(e, text, covered, baseVersion, path);
    }
  }

  private onSaved(result: WriteResult, text: string, body: string, covered: number, requestPath: string): void {
    if (this.path !== requestPath) {
      // Re-keyed while the request was in flight (entry.moved, own MoveResult): the save landed
      // before the move, and the file now lives at this.path. Never move back.
      result = { ...result, file: entryAtPath(result.file, this.path) };
    } else if (result.file.path !== requestPath) {
      // The server wrote elsewhere (its own canonical path).
      this.rekey(result.file.path, true);
    }
    this.version = result.file.version;
    this.baseText = text;
    this.flushHistoryNext = false;
    this.conflict = null;
    this.deleted = null;
    this.error = null;
    this.refusedLength = null;
    this.retryAttempt = 0;
    this.savedChanges = covered;
    this.deps.onWriteResult(result, body);
    if (this.changes === covered) {
      void this.removeOwnDraft();
      this.setStatus('clean');
    } else {
      this.setStatus('dirty');
    }
  }

  /**
   * Where a save whose path vanished should go (409 with currentVersion null, DESIGN §6.10), or
   * null for the deleted state.
   */
  private movedTarget(movedTo: string | null, requestPath: string, baseVersion: Version | null): { path: string; authoritative: boolean } | null {
    // Re-keyed while the request was in flight: the file is at this.path now.
    if (this.path !== requestPath) return { path: this.path, authoritative: true };
    const known = this.deps.moves.lookup(requestPath);
    if (known && known !== requestPath) return { path: known, authoritative: false };
    if (!movedTo || movedTo === requestPath || !this.deps.moves.trustsMoveFrom(requestPath)) return null;
    // A move this page never saw: follow it only when the file there is ours (a pure move keeps
    // the blob id), since the server's account may predate a note re-created at this path.
    const there = this.deps.treeVersion?.(movedTo);
    if (there !== undefined && there !== baseVersion) return null;
    return { path: movedTo, authoritative: false };
  }

  private async onSaveFailed(e: unknown, text: string, covered: number, baseVersion: Version | null, requestPath: string): Promise<void> {
    if (isVersionConflict(e)) {
      const p = e.problem;
      if (p.currentContent !== null && p.currentVersion !== null) {
        const theirs = toLf(p.currentContent);
        if (theirs === text) {
          // Equal text is never a conflict (API.md §4 step 6).
          this.version = p.currentVersion;
          this.baseText = theirs;
          this.flushHistoryNext = false;
          this.conflict = null;
          this.savedChanges = covered;
          if (this.changes === covered) {
            void this.removeOwnDraft();
            this.setStatus('clean');
          } else {
            this.setStatus('dirty');
          }
          return;
        }
        if (this.tryMerge(theirs, p.currentVersion, detectEol(p.currentContent), this.baseText)) return;
        this.status = 'conflict';
        this.conflict = {
          theirsText: theirs,
          theirsVersion: p.currentVersion,
          theirsEol: detectEol(p.currentContent),
          baseText: this.baseText,
          source: 'save',
          historyBlocked: false,
        };
        this.emit();
        return;
      }
      const target = this.movedTarget(p.movedTo, requestPath, baseVersion);
      if (target && (target.path === this.path || this.rekey(target.path, target.authoritative))) {
        // A pure move keeps the blob id: retry at the new path with the same base.
        this.version = baseVersion;
        this.status = 'dirty';
        await this.performSave();
        return;
      }
      this.status = 'deleted';
      this.conflict = null;
      this.deleted = { trashId: null, hasLocalEdits: true };
      this.emit();
      return;
    }
    if (isProblem(e, 'history-unavailable') && this.flushHistoryNext) {
      this.flushHistoryNext = false;
      if (this.conflict) {
        this.conflict = { ...this.conflict, historyBlocked: true };
        this.status = 'conflict';
      } else {
        this.status = 'deleted';
        this.deleted = { trashId: this.deleted?.trashId ?? null, hasLocalEdits: true };
      }
      this.error = errorMessage(e);
      this.emit();
      return;
    }
    if (isTransient(e) || isStorageProblem(e)) {
      this.error = errorMessage(e);
      this.status = isTransient(e) ? 'offline' : 'storage-error';
      this.scheduleRetry(isTransient(e) ? e.retryAfterMs : null);
      this.emit();
      return;
    }
    if (isProblem(e, 'too-large')) {
      // The text stays editable and unsaved (drafts continue): trimming it saves again, and
      // "Discard my changes" returns to the server's copy (DESIGN §6.9).
      this.error = 'This note is too large to save. Remove some text, or discard your changes.';
      this.refusedLength = text.length;
      this.setStatus('error');
      return;
    }
    this.error = errorMessage(e as ApiError);
    this.setStatus('error');
  }

  private scheduleRetry(retryAfterMs: number | null): void {
    const backoff = BACKOFF_MS[Math.min(this.retryAttempt, BACKOFF_MS.length - 1)];
    this.retryAttempt++;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    this.retryAt = Date.now() + delay;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Queued saves wait until the event stream has replayed what happened meanwhile.
      if (this.deps.caughtUp()) void this.save();
      else this.scheduleRetry(null);
    }, delay);
  }

  private async afterSave(): Promise<void> {
    // The last remote event describes the file now (a delete followed by a restore is a file).
    const pending = this.deferred;
    this.deferred = null;
    if (pending?.kind === 'deleted') {
      if (this.status !== 'deleted') this.onRemoteDeleted(pending.trashId);
      return;
    }
    if (pending && (pending.version !== this.version || this.status === 'deleted')) {
      await this.reconcileWithServer();
      return;
    }
    if (this.status === 'dirty') this.scheduleSave(false);
  }

  /**
   * Fire-and-forget save for `pagehide` (fetch keepalive). Returns the bytes used from the shared
   * budget, or 0 when the body does not fit (the draft covers it).
   */
  keepaliveSave(budget: number): number {
    if (!AUTOSAVE.has(this.status) && this.status !== 'saving') return 0;
    const body = fromLf(this.getText(), this.eol);
    // A pending Keep mine (or Recreate) still asks the server to preserve its copy first.
    const request = { content: body, baseVersion: this.version, ...(this.flushHistoryNext ? { flushHistory: true } : {}) };
    const size = new TextEncoder().encode(JSON.stringify(request)).length;
    if (size > budget) return 0;
    void this.deps.api.saveFile(this.path, request, { keepalive: true }).catch(() => undefined);
    return size;
  }

  /** Size of the pending keepalive body, for ordering sessions smallest first. */
  pendingBodySize(): number {
    return AUTOSAVE.has(this.status) || this.status === 'saving' ? this.getText().length : Infinity;
  }

  // ---------- conflict resolution (DESIGN §6.10) ----------

  /** Keep mine: `PUT {mine, baseVersion: theirsVersion, flushHistory: true}`. */
  async keepMine(): Promise<void> {
    if (this.status !== 'conflict' || !this.conflict) return;
    this.version = this.conflict.theirsVersion;
    this.baseText = this.conflict.theirsText;
    this.conflict = { ...this.conflict, historyBlocked: false };
    this.flushHistoryNext = true;
    this.status = 'dirty';
    await this.save();
  }

  /** Save merged: the buffer becomes `merged`, saved with flushHistory. */
  async saveMerged(merged: string): Promise<void> {
    if (this.status !== 'conflict' || !this.conflict) return;
    this.replaceUndoable(merged);
    this.changes++;
    // The merge is unsaved work too: a killed tab restores it, not the pre-merge text.
    void this.writeDraft();
    await this.keepMine();
  }

  /** Take theirs: undoable replacement; mine goes to the discarded store with an Undo toast. */
  async takeTheirs(): Promise<void> {
    if (this.status !== 'conflict' || !this.conflict) return;
    const { theirsText, theirsVersion, theirsEol } = this.conflict;
    const mine = this.getText();
    this.replaceUndoable(theirsText);
    this.adoptVersion(theirsVersion, theirsText, theirsEol);
    const id = await this.stash(mine, 'take-theirs');
    this.deps.notify({
      message: 'Replaced your version with theirs',
      action: { label: 'Undo', run: () => void this.restoreDiscarded(id, mine) },
    });
  }

  /** Recreate with my text (deleted state): `PUT {mine, baseVersion: null, flushHistory: true}`. */
  async recreate(): Promise<void> {
    if (this.status !== 'deleted') return;
    this.version = null;
    this.flushHistoryNext = true;
    this.status = 'dirty';
    await this.save();
  }

  /**
   * Discard (deleted state): the buffer returns to the last server text as an undoable edit, the
   * session becomes a plain tombstone, and mine goes to the discarded store with an Undo toast.
   */
  async discardLocal(): Promise<void> {
    if (this.status !== 'deleted' || !this.deleted?.hasLocalEdits) return;
    const mine = this.getText();
    this.replaceUndoable(this.baseText);
    this.savedChanges = this.changes;
    this.firstUnsavedAt = null;
    this.clearTimers();
    this.deleted = { ...this.deleted, hasLocalEdits: false };
    this.emit();
    void this.removeOwnDraft();
    const id = await this.stash(mine, 'discard');
    this.deps.notify({ message: 'Discarded your unsaved text', action: { label: 'Undo', run: () => void this.restoreDiscarded(id, mine) } });
  }

  /**
   * "Discard my changes" after a save the server refused for good (too large): back to the
   * server's copy as an undoable edit; mine goes to the discarded store with an Undo toast.
   */
  async discardUnsaved(): Promise<void> {
    if (this.status !== 'error' || !this.loaded || this.version === null) return;
    const mine = this.getText();
    this.replaceUndoable(this.baseText);
    this.adoptVersion(this.version, this.baseText, this.eol);
    const id = await this.stash(mine, 'discard');
    this.deps.notify({ message: 'Discarded your unsaved text', action: { label: 'Undo', run: () => void this.restoreDiscarded(id, mine) } });
  }

  private async stash(text: string, reason: 'take-theirs' | 'discard'): Promise<number | null> {
    try {
      return await this.deps.drafts.discard({ path: this.path, text, eol: this.eol, at: Date.now(), reason });
    } catch {
      this.deps.onDraftWrite(false);
      return null;
    }
  }

  /**
   * Puts `text` into the document as an ordinary local edit (it autosaves; Mod-Z undoes it),
   * once any load in progress has settled. True only when the text actually landed, so callers
   * keep their copy (a discarded record, a draft) whenever it did not.
   */
  async restoreText(text: string): Promise<boolean> {
    await this.whenSettled();
    if (this.disposed || !this.isEditable()) return false;
    this.setText(text);
    return this.getText() === text;
  }

  /** Undo of Take theirs or Discard: the text comes back as a local edit, then the record goes. */
  private async restoreDiscarded(id: number | null, text: string): Promise<void> {
    if (!(await this.restoreText(text))) {
      // Nothing was restored (the note cannot be edited right now): the record stays.
      this.deps.notify({ message: 'The note cannot be edited right now; your text is kept in Settings › This device' });
      return;
    }
    if (id !== null) await this.deps.drafts.takeDiscarded(id).catch(() => null);
  }

  // ---------- attachments (DESIGN §6.6 #10) ----------

  /**
   * Starts an upload shown at `range` (its text is replaced): a widget, never document text.
   * Returns the upload's id, or null when the document cannot be edited.
   */
  beginUpload(range: { from: number; to: number }, label: string, userEvent: string): number | null {
    if (!this.isEditable()) return null;
    const id = ++uploadSeq;
    const effects = [addUpload.of({ id, pos: range.from, label })];
    if (range.from !== range.to) this.applyEdit({ from: range.from, to: range.to, insert: '' }, { selection: { anchor: range.from }, userEvent, effects });
    else this.dispatchEffects(effects);
    this.uploads++;
    return id;
  }

  /** Inserts the upload's embed where its widget is (after the batch's earlier embeds). */
  finishUpload(id: number, insert: string): boolean {
    const upload = pendingUploads(this.editorState).find((u) => u.id === id);
    this.uploads = Math.max(0, this.uploads - 1);
    if (!upload) return false;
    if (!this.isEditable()) {
      this.dispatchEffects([endUpload.of({ id })]);
      return false;
    }
    this.applyEdit({ from: upload.pos, insert }, { effects: [endUpload.of({ id, from: upload.pos, end: upload.pos + insert.length })] });
    return true;
  }

  /** A failed or abandoned upload: its widget goes. */
  cancelUpload(id: number): void {
    this.uploads = Math.max(0, this.uploads - 1);
    if (pendingUploads(this.editorState).some((u) => u.id === id)) this.dispatchEffects([endUpload.of({ id })]);
  }

  /** An upload of a view without editor widgets (a drawing's image): unsaved work while it runs. */
  async trackUpload<T>(upload: Promise<T>): Promise<T> {
    this.uploads++;
    try {
      return await upload;
    } finally {
      this.uploads = Math.max(0, this.uploads - 1);
    }
  }

  // ---------- drafts ----------

  private scheduleDraft(): void {
    if (this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      idle(() => void this.writeDraft());
    }, DRAFT_INTERVAL_MS);
  }

  private async writeDraft(): Promise<void> {
    if (this.disposed || !this.hasUnsavedChanges()) return;
    const text = this.getText();
    const draft: DraftRecord = {
      path: this.path,
      clientId: this.deps.clientId,
      baseVersion: this.version,
      text,
      eol: this.eol,
      at: Date.now(),
    };
    if (text.length + this.baseText.length < BASE_TEXT_DRAFT_LIMIT) draft.baseText = this.baseText;
    // An unresolved conflict (or a pending Keep mine) must come back as a conflict after a reload.
    if (this.status === 'conflict' || this.flushHistoryNext) draft.conflict = true;
    try {
      await this.deps.drafts.put(draft);
      this.deps.onDraftWrite(true);
    } catch {
      this.deps.onDraftWrite(false);
    }
  }

  private async removeOwnDraft(): Promise<void> {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    try {
      await this.deps.drafts.remove(this.path, this.deps.clientId);
    } catch {
      this.deps.onDraftWrite(false);
    }
  }

  /** On open: drafts of this path owned by no live tab, newest first (DESIGN §6.9). */
  private async restoreDrafts(file: TextFile): Promise<void> {
    let drafts: DraftRecord[];
    try {
      drafts = (await this.deps.drafts.listForPath(this.path)).filter((d) => d.clientId !== this.deps.clientId);
    } catch {
      this.deps.onDraftWrite(false);
      return;
    }
    if (drafts.length === 0) return;
    const live = await this.deps.liveDraftOwners(this.path);
    const orphans = drafts.filter((d) => !live.has(d.clientId)).sort((a, b) => b.at - a.at);
    const serverText = toLf(file.content);
    const now = Date.now();
    let restored = false;
    for (const d of orphans) {
      const drop = () => this.deps.drafts.remove(d.path, d.clientId).catch(() => undefined);
      if (now - d.at > DRAFT_MAX_AGE_MS || d.text === serverText) {
        await drop();
        continue;
      }
      if (restored) {
        // Keep older orphans recoverable rather than restoring several at once.
        await this.deps.drafts.discard({ path: d.path, text: d.text, eol: d.eol, at: d.at, reason: 'superseded-draft' }).catch(() => undefined);
        await drop();
        continue;
      }
      restored = true;
      this.eol = d.eol;
      this.replaceUndoable(d.text);
      this.changes++;
      this.firstUnsavedAt = Date.now();
      if (d.baseVersion === file.version && !d.conflict) {
        this.setStatus('dirty');
        this.scheduleSave(false);
        this.deps.notify({ message: 'Restored unsaved changes' });
      } else if (!this.tryMerge(serverText, file.version, detectEol(file.content), d.baseText ?? null)) {
        this.version = d.baseVersion;
        this.conflict = {
          theirsText: serverText,
          theirsVersion: file.version,
          theirsEol: detectEol(file.content),
          baseText: d.baseText ?? null,
          source: 'draft',
          historyBlocked: false,
        };
        this.baseText = d.baseText ?? this.baseText;
        this.setStatus('conflict');
      }
      // The draft now belongs to this tab.
      await this.writeDraft();
      await drop();
    }
  }

  // ---------- lifecycle ----------

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.draftTimer = null;
    this.loadTimer = null;
    // Views holding a disposed session re-acquire one for their path (the snapshot changes so
    // that subscribers re-render).
    this.snapshot = { ...this.snapshot };
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const fn of listeners) fn();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
