// The drawing view's model (ROADMAP item 5, DESIGN §6.8.1): binds one Excalidraw instance to the
// file's DocumentSession, outside React.
//
// - Edits: Excalidraw calls onChange on every pointer move; the controller compares a cheap
//   signature (element versions and the exported appState keys) and calls
//   `session.markDirty(serialize)`, so the scene is serialized only when the session saves or
//   writes a draft.
// - Text from the session (a remote change, a merge, Take theirs, a restored draft) replaces the
//   scene, except elements the user is drawing or editing right now; the session's
//   `remoteChangeCount` says when there is any.
// - Images are vault attachments (files.ts). A Markdown drawing's text elements get 8-character
//   ids in the file (the Obsidian plugin's block ids); the scene keeps Excalidraw's own ids, and
//   the controller maps between them, so undo history and selection never see a rename.
import type { DocumentSession } from '../../sync/DocumentSession';
import { dataUrlToBlob, EMBED_LIMIT, fileIdFor, filesToStore, referencedFileIds, type LiveFile } from './files';
import { imageBoxes, imageFor, type ImageEnv } from './images';
import {
  EXPORTED_APP_STATE,
  isLiveText,
  isMarkdownTextId,
  parseDrawing,
  renameElementIds,
  shortId,
  writeDrawing,
  type Drawing,
  type DrawingFormat,
  type EmbeddedRef,
  type Scene,
  type SceneElement,
  type StoredFile,
} from './format';

/** The parts of Excalidraw's AppState the controller reads. */
export interface AppStateLike {
  isLoading?: boolean;
  editingTextElement?: { id: string } | null;
  newElement?: { id: string } | null;
  resizingElement?: { id: string } | null;
  multiElement?: { id: string } | null;
  selectedElementsAreBeingDragged?: boolean;
  selectedElementIds?: Readonly<Record<string, boolean>>;
  [key: string]: unknown;
}

/** The parts of ExcalidrawImperativeAPI the controller uses. */
export interface SceneApi {
  getSceneElementsIncludingDeleted(): readonly SceneElement[];
  getAppState(): AppStateLike;
  getFiles(): Readonly<Record<string, LiveFile | undefined>>;
  updateScene(scene: { elements?: readonly SceneElement[]; appState?: Record<string, unknown>; captureUpdate?: unknown }): void;
  addFiles(files: LiveFile[]): void;
}

/** Functions of the Excalidraw package (injected: the package is a lazy chunk, and tests fake it). */
export interface SceneLib {
  restoreElements(elements: readonly SceneElement[], local: readonly SceneElement[] | null): SceneElement[];
  hashElementsVersion(elements: readonly SceneElement[]): number;
  /** CaptureUpdateAction.NEVER: text from elsewhere stays out of the local undo history. */
  captureNever: unknown;
}

/** The app around the view: images (images.ts), uploads, link texts and error toasts. */
export interface DrawingEnv extends ImageEnv {
  /** POST /api/attachments with `source` = the drawing. */
  upload(file: Blob, name: string | null, source: string): Promise<{ path: string }>;
  /** Wiki link text for an attachment, as `## Embedded Files` lists it. */
  linkText(path: string, source: string): string;
  reportError(message: string): void;
}

type SessionLike = Pick<DocumentSession, 'path' | 'editorState' | 'getText' | 'remoteChangeCount' | 'markDirty' | 'isEditable' | 'trackUpload'>;

export interface InitialScene {
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: LiveFile[];
}

export type DrawingMode = { kind: 'drawing' } | { kind: 'fallback'; reason: 'not-a-drawing' | 'malformed'; message: string };

/**
 * What the view renders: Excalidraw started from `initial` (a new `generation` mounts a new
 * Excalidraw), or the fallback text view for a file that is not a readable drawing.
 */
export type DrawingState = { generation: number } & ({ mode: { kind: 'drawing' }; initial: InitialScene } | { mode: Extract<DrawingMode, { kind: 'fallback' }>; initial: null });

function exportedAppState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EXPORTED_APP_STATE) if (appState[k] !== undefined) out[k] = appState[k];
  return out;
}

/** Excalidraw's own export clean-up (`clearElementsForExport`): deleted elements go, linear ones lose their cursor point. */
function exportElement(e: SceneElement): SceneElement {
  return e.type === 'arrow' || e.type === 'line' ? { ...e, lastCommittedPoint: null } : e;
}

function busyIds(appState: AppStateLike): Set<string> {
  const ids = new Set<string>();
  for (const e of [appState.editingTextElement, appState.newElement, appState.resizingElement, appState.multiElement]) if (e?.id) ids.add(e.id);
  if (appState.selectedElementsAreBeingDragged) for (const [id, on] of Object.entries(appState.selectedElementIds ?? {})) if (on) ids.add(id);
  return ids;
}

export class DrawingController {
  readonly format: DrawingFormat;
  private readonly session: SessionLike;
  private readonly lib: SceneLib;
  private readonly env: DrawingEnv;

  private api: SceneApi | null = null;
  private initialized = false;
  /** updateScene with text from the session is running: what Excalidraw reports meanwhile is not an edit. */
  private applying = false;
  /**
   * The scene as of Excalidraw's last report. Serialization reads this, never the API: the
   * session may save after the view unmounted (the flush on navigation), when Excalidraw has torn
   * its scene down. Excalidraw mutates elements in place, so these are the latest objects.
   */
  private latest: { elements: readonly SceneElement[]; appState: AppStateLike; files: Readonly<Record<string, LiveFile | undefined>> } | null = null;
  private drawing: Drawing | null = null;
  private state: DrawingState;
  private appliedRemote = -1;
  private lastSig: string | null = null;
  private lastFiles: unknown = null;

  /** The loaded file's `files` entries. */
  private stored = new Map<string, StoredFile>();
  /** `## Embedded Files` entries (Markdown drawings). */
  private sectionRefs = new Map<string, EmbeddedRef>();
  /** Attachments uploaded (or moved out of the JSON) during this session. */
  private vault = new Map<string, { path: string; mimeType: string; created: number }>();
  private migrating = new Set<string>();
  /** Files handed to Excalidraw (or being fetched). */
  private requested = new Set<string>();
  private loading = false;
  private loadAgain = false;
  /** Text element id in the scene → its 8-character id in a Markdown file, and back. */
  private aliases = new Map<string, string>();
  private inverse = new Map<string, string>();
  /** Markdown source and original text of each text element as last loaded. */
  private rawTexts = new Map<string, { raw: string; originalText: unknown }>();
  private readonly listeners = new Set<() => void>();

  /** Created once the session has loaded. */
  constructor(session: SessionLike, format: DrawingFormat, lib: SceneLib, env: DrawingEnv) {
    this.session = session;
    this.format = format;
    this.lib = lib;
    this.env = env;
    this.state = this.begin(0);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): DrawingState => this.state;

  private setState(state: DrawingState): void {
    this.state = state;
    for (const fn of [...this.listeners]) fn();
  }

  /**
   * Parses the session's text into the scene Excalidraw starts from, or the fallback view.
   * `getText()`, not the buffer: a view mounted again while an earlier one's edits are unsaved
   * starts from those edits (the session still serializes them through the earlier view).
   */
  private begin(generation: number): DrawingState {
    this.appliedRemote = this.session.remoteChangeCount;
    this.latest = null;
    this.initialized = false;
    const result = parseDrawing(this.format, this.session.getText());
    if (!result.ok) return { generation, mode: { kind: 'fallback', reason: result.reason, message: result.message }, initial: null };
    this.adopt(result.drawing);
    const files: LiveFile[] = [];
    for (const f of this.stored.values()) if (f.dataURL) files.push({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created });
    return {
      generation,
      mode: { kind: 'drawing' },
      initial: { elements: this.toScene(result.drawing.scene.elements), appState: exportedAppState(result.drawing.scene.appState), files },
    };
  }

  /**
   * A (new) Excalidraw instance, which initializes from the state's `initial` scene and reports
   * through onChange; null when the view unmounts (unsaved edits stay serializable from `latest`).
   */
  attach(api: SceneApi | null): void {
    if (api === this.api) return;
    this.api = api;
    if (!api) return;
    this.initialized = false;
    this.lastSig = null;
    this.lastFiles = null;
    this.requested.clear();
  }

  private adopt(drawing: Drawing): void {
    this.drawing = drawing;
    this.stored = new Map(Object.entries(drawing.scene.files));
    this.sectionRefs = new Map((drawing.markdown?.embedded ?? []).map((e) => [e.id, e.ref]));
    this.rawTexts = new Map();
    if (drawing.markdown) {
      const originals = new Map(drawing.scene.elements.filter(isLiveText).map((e) => [e.id, e.originalText ?? e.text]));
      for (const t of drawing.markdown.texts) if (originals.has(t.id)) this.rawTexts.set(t.id, { raw: t.raw, originalText: originals.get(t.id) });
    }
  }

  /** File elements as the scene holds them (Markdown text ids mapped back to the scene's). */
  private toScene(elements: readonly SceneElement[]): SceneElement[] {
    return this.format === 'markdown' ? renameElementIds(elements, this.inverse) : [...elements];
  }

  private signature(elements: readonly SceneElement[], appState: AppStateLike): string {
    return [this.lib.hashElementsVersion(elements), ...EXPORTED_APP_STATE.map((k) => String(appState[k]))].join('|');
  }

  // ---------- Excalidraw → session ----------

  /** Excalidraw's onChange (every pointer move): marks the session dirty when the drawing changed. */
  onChange(elements: readonly SceneElement[], appState: AppStateLike, files: Readonly<Record<string, LiveFile | undefined>>): void {
    if (!this.api || appState.isLoading || this.state.mode.kind !== 'drawing') return;
    this.latest = { elements, appState, files };
    if (this.applying) return;
    if (!this.initialized) {
      // The first report after Excalidraw loaded the initial scene: that is the saved state.
      this.initialized = true;
      this.lastSig = this.signature(elements, appState);
      this.lastFiles = files;
      this.sync();
      void this.loadFiles();
      return;
    }
    if (files !== this.lastFiles) {
      this.lastFiles = files;
      this.moveLargeEmbeds(files);
    }
    const sig = this.signature(elements, appState);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (this.session.isEditable()) this.session.markDirty(this.serialize);
  }

  /** The file text for the current scene; called by the session only when it saves or writes a draft. */
  serialize = (): string => {
    const latest = this.latest;
    const drawing = this.drawing;
    if (!latest || !drawing) return this.session.editorState.doc.toString();
    // Image elements still waiting for their upload are not part of the file yet.
    let elements = latest.elements.filter((e) => !e.isDeleted && !(e.type === 'image' && typeof e.fileId !== 'string'));
    if (this.format === 'markdown') elements = this.withMarkdownIds(elements, latest.elements);
    const { files, attachments } = filesToStore(this.format, elements, latest.files, {
      stored: this.stored,
      section: new Set(this.sectionRefs.keys()),
      vault: this.vault,
    });
    const scene: Scene = {
      ...drawing.scene,
      elements: elements.map(exportElement),
      appState: { ...drawing.scene.appState, ...exportedAppState(latest.appState) },
      files,
    };
    return writeDrawing(drawing, scene, {
      rawText: (e) => {
        const loaded = this.rawTexts.get(e.id);
        return loaded && loaded.originalText === (e.originalText ?? e.text) ? loaded.raw : undefined;
      },
      addEmbedded: attachments.map((a) => ({ id: a.id, value: `[[${this.env.linkText(a.path, this.session.path)}]]` })),
    });
  };

  /** Markdown drawings: text elements carry the plugin's 8-character ids in the file. */
  private withMarkdownIds(elements: SceneElement[], all: readonly SceneElement[]): SceneElement[] {
    const taken = new Set([...all.map((e) => e.id), ...this.inverse.keys()]);
    const map = new Map<string, string>();
    for (const e of elements) {
      if (e.type !== 'text' || isMarkdownTextId(e.id)) continue;
      let id = this.aliases.get(e.id);
      if (!id) {
        id = shortId(e.id, taken);
        this.aliases.set(e.id, id);
        this.inverse.set(id, e.id);
      }
      taken.add(id);
      map.set(e.id, id);
    }
    return renameElementIds(elements, map);
  }

  // ---------- session → Excalidraw ----------

  /** Applies text the session put into its buffer since the last call (remote change, merge, ...). */
  sync(): void {
    if (this.session.remoteChangeCount === this.appliedRemote) return;
    // Excalidraw is still loading the initial scene; its first report comes back here.
    if (this.state.mode.kind === 'drawing' && !this.initialized) return;
    if (this.state.mode.kind === 'fallback') {
      // Readable again (a remote change, Take theirs): a new Excalidraw starts from the text.
      const next = this.begin(this.state.generation + 1);
      if (next.mode.kind === 'drawing' || next.mode.message !== this.state.mode.message) this.setState(next);
      return;
    }
    this.appliedRemote = this.session.remoteChangeCount;
    const result = parseDrawing(this.format, this.session.editorState.doc.toString());
    if (!result.ok) {
      this.setState({ generation: this.state.generation, mode: { kind: 'fallback', reason: result.reason, message: result.message }, initial: null });
      return;
    }
    this.adopt(result.drawing);
    const api = this.api;
    if (!api) return;
    const local = api.getSceneElementsIncludingDeleted();
    const appState = api.getAppState();
    const restored = this.lib.restoreElements(this.toScene(result.drawing.scene.elements), local);
    // What the user is drawing or typing right now stays as it is (it is part of "mine" already).
    const busy = busyIds(appState);
    const localById = new Map(local.map((e) => [e.id, e]));
    const elements = restored.map((e) => (busy.has(e.id) && localById.has(e.id) ? localById.get(e.id)! : e));
    for (const id of busy) if (!restored.some((e) => e.id === id) && localById.has(id)) elements.push(localById.get(id)!);
    const incoming = exportedAppState(result.drawing.scene.appState);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) if (appState[k] !== v) patch[k] = v;
    this.applying = true;
    try {
      api.updateScene({ elements, ...(Object.keys(patch).length > 0 ? { appState: patch } : {}), captureUpdate: this.lib.captureNever });
    } finally {
      this.applying = false;
    }
    // Excalidraw's appState update lands with its next render; the elements are in place now.
    this.latest = { elements: api.getSceneElementsIncludingDeleted(), appState: { ...appState, ...patch }, files: api.getFiles() };
    this.lastSig = this.signature(this.latest.elements, this.latest.appState);
    void this.loadFiles();
  }

  // ---------- images ----------

  /** Hands Excalidraw the image of every referenced file it does not have yet, one at a time. */
  async loadFiles(): Promise<void> {
    if (this.loading) {
      this.loadAgain = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.loadAgain = false;
        const api = this.api;
        if (!api) return;
        const live = api.getFiles();
        const elements = api.getSceneElementsIncludingDeleted();
        const boxes = imageBoxes(elements);
        for (const id of referencedFileIds(elements)) {
          if (this.requested.has(id) || live[id]?.dataURL) continue;
          this.requested.add(id);
          const file = await imageFor(id, { stored: this.stored, section: this.sectionRefs, vault: this.vault }, this.env, this.session.path, boxes.get(id));
          if (file && this.api === api) api.addFiles([file]);
        }
      } while (this.loadAgain);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Excalidraw's `generateIdForFile`: every image placed in the drawing (paste, drop, the image
   * tool) is uploaded as a vault attachment first. Excalidraw shows the image once this resolves,
   * and shows the error when it throws.
   */
  generateIdForFile = async (file: File): Promise<string> => {
    const id = await fileIdFor(file);
    if (this.vault.has(id) || this.stored.get(id)?.path || this.sectionRefs.has(id)) return id;
    try {
      const { path } = await this.session.trackUpload(this.env.upload(file, file.name, this.session.path));
      this.vault.set(id, { path, mimeType: file.type || 'application/octet-stream', created: Date.now() });
    } catch (e) {
      throw new Error(`The image could not be uploaded: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    return id;
  };

  /**
   * An image pasted with its data (from another app's Excalidraw clipboard) that is too large to
   * keep in the file becomes an attachment; until the upload finishes the file embeds it.
   */
  private moveLargeEmbeds(files: Readonly<Record<string, LiveFile | undefined>>): void {
    for (const file of Object.values(files)) {
      if (!file?.dataURL || file.path || file.dataURL.length <= EMBED_LIMIT) continue;
      const id = file.id;
      if (this.stored.has(id) || this.vault.has(id) || this.sectionRefs.has(id) || this.migrating.has(id)) continue;
      this.migrating.add(id);
      void this.session
        .trackUpload(this.env.upload(dataUrlToBlob(file.dataURL), null, this.session.path))
        .then(({ path }) => {
          this.vault.set(id, { path, mimeType: file.mimeType, created: file.created ?? Date.now() });
          if (this.session.isEditable() && this.state.mode.kind === 'drawing') this.session.markDirty(this.serialize);
        })
        .catch((e: unknown) => {
          this.env.reportError(`A pasted image stays embedded in the drawing: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
  }
}
