// /clip (DESIGN §6.27.1): where the bookmarklet and the browser extension hand over a web page.
// A page outside the app shell, like /capture. It says it is ready, takes the first valid clip
// (from its opener, the bookmarklet, or from its own origin, the extension's content script),
// shows a preview, and saves the note on Save. A clip from the extension with "Save without the
// preview" saves at once. The server sends this page without Cross-Origin-Opener-Policy, so the
// bookmarklet's page keeps its handle on the window.
import { CircleCheck, ClipboardPaste, NotebookText, Scissors } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { useTree, useVaultSettings } from '../../api/hooks';
import {
  announceReady,
  announceResult,
  fragmentInfo,
  loadClipper,
  parseClipMessage,
  saveClip,
  toClip,
  type Clip,
  type ClipImage,
  type NotesClipper,
  type ReceivedClip,
} from '../../features/clip';
import { navigateTo, openPath } from '../../features/navigation';
import { makeRenderContext } from '../../render/context';
import { renderNote } from '../../render/render';
import { newIdempotencyKey } from '../../state/clientId';
import { usePrefs } from '../../state/prefs';
import { appTitle } from '../../state/vault';
import '../../styles/capture.css';

/** How long to wait for the page before offering to paste it instead. */
const PASTE_HINT_MS = 4000;

interface Ready {
  clip: Clip;
  images: ClipImage[];
  folder: string;
  autoSave: boolean;
  source: ReceivedClip['source'];
}

type State =
  | { phase: 'waiting' }
  | { phase: 'preview'; ready: Ready }
  | { phase: 'saving'; ready: Ready }
  | { phase: 'saved'; path: string }
  | { phase: 'failed'; message: string; ready: Ready | null };

function Preview({ markdown, path }: { markdown: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const tree = useTree().data;
  const settings = useVaultSettings();
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!tree) {
      el.textContent = markdown;
      return;
    }
    el.replaceChildren(renderNote(markdown, makeRenderContext(path, tree, settings, loadRemoteImages, 1)).fragment);
  }, [markdown, path, tree, settings, loadRemoteImages]);
  return (
    <div className="reading-view clip-preview">
      <div ref={ref} className="markdown-rendered" />
    </div>
  );
}

export function ClipPage() {
  const [state, setState] = useState<State>({ phase: 'waiting' });
  const [clipper, setClipper] = useState<NotesClipper | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [basename, setBasename] = useState('');
  const [folder, setFolder] = useState('');
  const received = useRef(false);
  const via = new URLSearchParams(window.location.search).get('via');
  const info = fragmentInfo(window.location.hash);

  useEffect(() => {
    document.title = appTitle('Clip');
    let cancelled = false;
    loadClipper().then(
      (c) => !cancelled && setClipper(c),
      (e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (ready: Ready, c: NotesClipper, name: string, dir: string) => {
    setState({ phase: 'saving', ready });
    try {
      const result = await saveClip(ready.clip, ready.images, { folder: dir, basename: name, created: c.localDate(), newKey: newIdempotencyKey }, c, api);
      setState({ phase: 'saved', path: result.file.path });
      if (ready.source === 'extension') announceResult({ status: 'saved', path: result.file.path });
    } catch (e) {
      const message = errorMessage(e);
      setState({ phase: 'failed', message, ready });
      if (ready.source === 'extension') announceResult({ status: 'failed', error: message });
    }
  };

  const accept = (r: ReceivedClip, c: NotesClipper) => {
    let clip: Clip;
    try {
      clip = toClip(r, c);
    } catch (e) {
      setState({ phase: 'failed', message: `The page could not be read: ${String(e)}`, ready: null });
      return;
    }
    const ready: Ready = {
      clip,
      images: r.kind === 'clip' ? r.images : [],
      folder: r.kind === 'clip' && r.folder !== null ? r.folder : c.defaultFolder,
      autoSave: r.kind === 'clip' && r.autoSave,
      source: r.source,
    };
    const name = c.noteBasename(clip.title);
    setBasename(name);
    setFolder(ready.folder);
    if (ready.autoSave) void save(ready, c, name, ready.folder);
    else setState({ phase: 'preview', ready });
  };

  // The hand-over: announce, then take the first valid clip.
  useEffect(() => {
    if (!clipper) return;
    const onMessage = (e: MessageEvent) => {
      if (received.current) return;
      const fromApp = e.origin === window.location.origin;
      if (!fromApp && (!window.opener || e.source !== window.opener)) return;
      const r = parseClipMessage(e.data, fromApp);
      if (!r) return;
      received.current = true;
      accept(r, clipper);
    };
    window.addEventListener('message', onMessage);
    announceReady();
    const timer = setTimeout(() => setShowPaste(true), PASTE_HINT_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
    // accept and save only use setters and their arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipper]);

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!clipper || received.current) return;
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (!html && !text) return;
    const selectionHtml = html || text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] ?? ch).replace(/\n/g, '<br>');
    received.current = true;
    accept({ source: 'paste', kind: 'html', url: info?.url ?? 'https://unknown.invalid/', title: info?.title ?? '', html: '', selectionHtml }, clipper);
  };

  const ready = state.phase === 'preview' || state.phase === 'saving' ? state.ready : state.phase === 'failed' ? state.ready : null;
  const plannedPath = clipper && ready ? clipper.notePath(folder, basename || ready.clip.title) : '';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (clipper && ready && state.phase !== 'saving') void save(ready, clipper, basename, folder);
  };

  return (
    <main className="capture-page clip-page">
      <h1 className="dialog-title clip-title">
        <Scissors size={18} aria-hidden /> Clip to NotesApp
      </h1>
      {loadError && (
        <p className="field-error" role="alert">
          {loadError}
        </p>
      )}
      {state.phase === 'waiting' && !loadError && (
        <>
          <p className="muted" aria-busy="true">
            {via === 'extension' ? 'Waiting for the clipper…' : 'Waiting for the page…'}
          </p>
          {(showPaste || (via === 'bookmarklet' && !window.opener)) && (
            <div className="clip-paste" tabIndex={0} role="textbox" aria-label="Paste the page here" contentEditable suppressContentEditableWarning onPaste={onPaste}>
              <ClipboardPaste size={16} aria-hidden /> The page did not answer: some sites keep other windows from talking to them. Select what to keep on
              the page, copy it, then click here and paste.
            </div>
          )}
        </>
      )}
      {state.phase === 'saved' && (
        <div className="capture-done" role="status">
          <CircleCheck size={28} className="capture-done-icon" aria-hidden />
          <p>
            Saved to <strong>{state.path}</strong>.
          </p>
          <div className="capture-done-actions">
            <button type="button" className="button button-primary" onClick={() => openPath(state.path)}>
              <NotebookText size={15} aria-hidden /> Open the note
            </button>
            <button type="button" className="button" onClick={() => (window.opener ? window.close() : navigateTo('/'))}>
              {window.opener ? 'Close' : 'Open NotesApp'}
            </button>
          </div>
        </div>
      )}
      {state.phase === 'failed' && !ready && (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      )}
      {ready && (
        <form className="clip-form" onSubmit={onSubmit}>
          <label className="clip-field">
            <span className="setting-label">Name</span>
            <input className="text-input" value={basename} onChange={(e) => setBasename(e.target.value)} aria-label="Note name" />
          </label>
          <label className="clip-field">
            <span className="setting-label">Folder</span>
            <input className="text-input" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder" />
          </label>
          <p className="setting-note setting-prose clip-meta">
            {plannedPath && (
              <>
                Saves as <code>{plannedPath}</code> (a number is added if the name is taken).{' '}
              </>
            )}
            From <span className="clip-source">{ready.clip.url}</span>
            {ready.clip.selection && ' · the selection only'}
            {ready.images.length > 0 && ` · ${ready.images.length} ${ready.images.length === 1 ? 'image' : 'images'} saved as attachments`}
          </p>
          {state.phase === 'failed' && (
            <p className="field-error" role="alert">
              {state.message}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => (window.opener ? window.close() : navigateTo('/'))}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={state.phase === 'saving'}>
              {state.phase === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
          <Preview markdown={ready.clip.markdown} path={plannedPath} />
        </form>
      )}
    </main>
  );
}
