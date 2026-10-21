// The drawing view (ROADMAP item 5, DESIGN §6.8.1): Excalidraw over the file's DocumentSession,
// for `.excalidraw` and Obsidian Excalidraw's `.excalidraw.md`. This module is the lazy chunk
// that carries the Excalidraw package; its fonts are self-hosted (register.ts).
import { CaptureUpdateAction, Excalidraw, hashElementsVersion, MainMenu, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { ArrowLeft, ArrowRight, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import { SaveStatus } from '../../components/SaveStatus';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { runCommand } from '../../features/commands';
import { wantsNoteFocus } from '../../features/focus';
import { openLink } from '../../features/navigation';
import { displayName, folderOf } from '../../features/paths';
import { keyLabel } from '../../features/platform';
import { parseWikiBody } from '../../features/syntax';
import type { DocumentSession, SessionSnapshot } from '../../sync/DocumentSession';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import type { FileViewProps } from '../registry';
import { DrawingController, type AppStateLike, type DrawingMode, type InitialScene, type SceneApi, type SceneLib } from './controller';
import { drawingEnv } from './env';
import type { LiveFile } from './files';
import { keepFontsSameOrigin } from './fonts';
import { drawingFormat, type DrawingFormat, type SceneElement } from './format';
import { useAppTheme } from './theme';
import './excalidraw.css';

keepFontsSameOrigin();

const MarkdownView = lazy(() => import('../markdown/MarkdownView'));
const TextView = lazy(() => import('../TextView'));

const lib: SceneLib = {
  restoreElements: (elements, local) =>
    restoreElements(elements as never, local as never, { repairBindings: true }) as unknown as SceneElement[],
  hashElementsVersion: (elements) => hashElementsVersion(elements as never),
  captureNever: CaptureUpdateAction.NEVER,
};

// ---------- links inside drawings ----------

/** `[[Note]]` and relative links open inside the app; web links are left to Excalidraw (new tab). */
function onLinkOpen(source: string, element: NonDeletedExcalidrawElement, event: CustomEvent): void {
  const link = element.link?.trim();
  if (!link) return;
  const wiki = /^\[\[([^\]]+)\]\]$/.exec(link);
  if (!wiki && /^[a-z][a-z0-9+.-]*:/i.test(link)) return;
  event.preventDefault();
  if (wiki) {
    const body = parseWikiBody(wiki[1]);
    void openLink(body.target, body.subpath, source);
    return;
  }
  let target = link;
  try {
    target = decodeURIComponent(link);
  } catch {
    // A literal % in the path.
  }
  const hash = target.indexOf('#');
  void openLink(hash < 0 ? target : target.slice(0, hash), hash < 0 ? null : target.slice(hash + 1), source);
}

/**
 * Adds `maximum-scale=1` to the viewport while a drawing is open on a touch device: iOS Safari
 * then no longer zooms into Excalidraw's text editor when its font is under 16 px, and it keeps
 * pinch-zoom for the user (it ignores the limit for gestures). Returns the undo.
 */
function limitAutoZoom(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return () => {};
  const original = meta.content;
  if (/maximum-scale/.test(original)) return () => {};
  meta.content = `${original}, maximum-scale=1`;
  return () => {
    meta.content = original;
  };
}

// ---------- header ----------

function DrawingHeader({ path, snapshot }: { path: string; snapshot: SessionSnapshot }) {
  const breakpoint = useBreakpoint();
  // Phones show the name and save state in the top bar; the canvas gets the height.
  if (breakpoint === 'phone') return null;
  const title = displayName(path);
  const folder = folderOf(path);
  return (
    <header className="drawing-header" data-covers-top>
      <span className="note-header-nav">
        {breakpoint === 'desktop' && (
          <>
            <button type="button" className="icon-button" aria-label="Navigate back" title={`Navigate back (${keyLabel('Mod-Alt-ArrowLeft')})`} onClick={() => runCommand('nav.back', { activePath: path })}>
              <ArrowLeft size={16} />
            </button>
            <button type="button" className="icon-button" aria-label="Navigate forward" title={`Navigate forward (${keyLabel('Mod-Alt-ArrowRight')})`} onClick={() => runCommand('nav.forward', { activePath: path })}>
              <ArrowRight size={16} />
            </button>
          </>
        )}
      </span>
      <h1 className="note-breadcrumb drawing-title" title={folder ? `${folder}/${title}` : title}>
        {folder && <span className="note-breadcrumb-folder">{folder.split('/').join(' / ')} / </span>}
        <span>{title}</span>
      </h1>
      <span className="note-header-actions">
        <SaveStatus snapshot={snapshot} />
      </span>
    </header>
  );
}

// ---------- the editor ----------

/** A file that is not a readable drawing opens in the text view of its kind, so nothing in it is lost. */
function Fallback({ format, mode, props }: { format: DrawingFormat; mode: Extract<DrawingMode, { kind: 'fallback' }>; props: FileViewProps }) {
  const View: ComponentType<FileViewProps> = format === 'markdown' ? MarkdownView : TextView;
  return (
    <>
      {mode.reason === 'malformed' && (
        <p className="note-warning drawing-fallback-warning" role="note">
          <TriangleAlert size={14} aria-hidden /> This drawing could not be read ({mode.message}). It is shown as text, so nothing in it is lost.
        </p>
      )}
      <Suspense fallback={null}>
        <View {...props} mode="edit" />
      </Suspense>
    </>
  );
}

function initialDataOf(initial: InitialScene): ExcalidrawInitialDataState {
  const files: BinaryFiles = {};
  for (const f of initial.files) files[f.id] = f as unknown as BinaryFileData;
  return { elements: initial.elements as never, appState: initial.appState, files, scrollToContent: true };
}

function DrawingEditor({ session, snapshot, props }: { session: DocumentSession; snapshot: SessionSnapshot; props: FileViewProps }) {
  const [controller] = useState(() => new DrawingController(session, drawingFormat(session.path), lib, drawingEnv));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const initialData = useMemo(() => (state.initial ? initialDataOf(state.initial) : null), [state.initial]);
  const theme = useAppTheme();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  // Opened from the keyboard (quick switcher, palette): Excalidraw takes the focus, so its keys work at once.
  const [autoFocus] = useState(() => wantsNoteFocus());
  const readOnly = snapshot.status === 'readonly' || snapshot.lossy;

  // Text the session puts into its buffer (remote changes, merges, Take theirs) reaches the scene
  // synchronously, before the session can ask for a serialization of the old scene.
  useEffect(() => {
    controller.sync();
    return session.subscribe(() => controller.sync());
  }, [controller, session]);

  // Excalidraw hands its API over once per instance; a remount (StrictMode) reattaches it.
  useEffect(() => {
    controller.attach(apiRef.current as unknown as SceneApi | null);
    return () => controller.attach(null);
  }, [controller, state.generation]);

  // Phones zoom into a focused field under 16 px (Excalidraw's text editor at small zoom levels);
  // a maximum scale stops that on iOS, which still lets the user pinch-zoom the page.
  useEffect(() => limitAutoZoom(), []);

  if (state.mode.kind === 'fallback' || !initialData) return <Fallback format={controller.format} mode={state.mode as Extract<DrawingMode, { kind: 'fallback' }>} props={props} />;

  return (
    <div className="excalidraw-view">
      <DrawingHeader path={session.path} snapshot={snapshot} />
      <div className="excalidraw-host">
        <Excalidraw
          key={state.generation}
          initialData={initialData}
          excalidrawAPI={(api) => {
            apiRef.current = api;
            controller.attach(api as unknown as SceneApi);
          }}
          onChange={(elements, appState, files) =>
            controller.onChange(elements as unknown as SceneElement[], appState as unknown as AppStateLike, files as unknown as Record<string, LiveFile>)
          }
          generateIdForFile={controller.generateIdForFile}
          onLinkOpen={(element, event) => onLinkOpen(session.path, element, event)}
          theme={theme}
          autoFocus={autoFocus}
          viewModeEnabled={readOnly}
          name={displayName(session.path)}
          aiEnabled={false}
          validateEmbeddable={false}
          // The library link is hidden (excalidraw.css); should it show, it names no vault path.
          libraryReturnUrl={`${window.location.origin}/`}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: null,
              export: { saveFileToDisk: true },
              saveAsImage: true,
              clearCanvas: true,
              changeViewBackgroundColor: true,
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
}

export default function ExcalidrawView(props: FileViewProps) {
  const session = useDocumentSession(props.path);
  const snapshot = useSessionSnapshot(session);

  // A drawing that never loaded has no buffer to show (its error panel offers Try again).
  if (!snapshot.loaded) {
    return snapshot.status === 'loading' ? (
      <div className="view-loading" aria-busy="true">
        <div className="skeleton-line" />
      </div>
    ) : (
      <div className="error-panel" role="alert">
        <p className="error-panel-title">This drawing could not be opened.</p>
        <p className="error-panel-detail">{snapshot.error}</p>
        {snapshot.retryAt !== null && <p className="error-panel-detail muted">Retrying automatically…</p>}
        <button type="button" className="button" onClick={() => void session.reload()}>
          Try again
        </button>
      </div>
    );
  }
  // A new session (another device's move replaced this one) gets a new controller.
  return <DrawingEditor key={sessionKey(session)} session={session} snapshot={snapshot} props={props} />;
}

const sessionKeys = new WeakMap<DocumentSession, number>();
let nextSessionKey = 0;

function sessionKey(session: DocumentSession): number {
  let key = sessionKeys.get(session);
  if (key === undefined) {
    key = ++nextSessionKey;
    sessionKeys.set(session, key);
  }
  return key;
}
