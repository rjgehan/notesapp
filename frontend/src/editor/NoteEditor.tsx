// React host for the note's EditorView. React owns the host element; CodeMirror owns its inside.
// The view mounts the session's cached EditorState, so undo history survives switching notes.
import { StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { currentSettings, currentTree, fetchNoteMeta, fetchTags, useTree } from '../api/hooks';
import { openContextMenu } from '../components/overlays/openContextMenu';
import { insertAttachments } from '../features/attachments';
import { linkTo } from '../features/fileOps';
import { wantsNoteFocus } from '../features/focus';
import { openLink, openTag } from '../features/navigation';
import { editorBlocks } from '../features/blockRefs';
import { recentPaths } from '../features/recent';
import { renderLiveEmbed, renderLiveProperties } from '../render/liveEmbeds';
import { renderLiveMarkdown, renderLiveMath } from '../render/liveRich';
import { usePrefs } from '../state/prefs';
import type { DocumentSession } from '../sync/DocumentSession';
import { clearActiveEditor, setActiveEditor } from './activeEditor';
// The palette's editor commands (extensions/builtins.ts) run from here once an editor exists.
import './kit';
import { vaultChanged, type NoteContext } from './context';
import { noteExtensions, type EditorHooks } from './editorSetup';
import { maybeShowTabEscapeHint } from './tabEscapeHint';
import { attachVim, vimWanted } from './vimMode';
import { usePaneActive } from '../workspace/PaneContext';

export interface NoteEditorProps {
  session: DocumentSession;
  readOnly: boolean;
  /** Live Preview (DESIGN §6.6.1): `live` edits the rendered note, `locked` shows it read-only; absent is styled source mode. */
  preview?: 'live' | 'locked';
  /** Builds the extension list; defaults to the Markdown note editor. */
  extensions?(ctx: NoteContext, hooks: EditorHooks): Extension[];
  onToggleMode(): void;
  /** Called once the view exists (scroll restoration, heading targets). */
  onView?(view: EditorView): void;
  autoFocus?: boolean;
}

export function NoteEditor({ session, readOnly, preview, extensions = noteExtensions, onToggleMode, onView, autoFocus }: NoteEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const spellcheck = usePrefs((s) => s.spellcheck);
  const autocorrect = usePrefs((s) => s.autocorrect);
  const vim = vimWanted(usePrefs((s) => s.vimMode));
  const syntaxVisibility = usePrefs((s) => s.syntaxVisibility);
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  const tree = useTree().data;
  const callbacks = useRef({ onToggleMode, onView });
  // Only the active pane's editor is the active editor and takes focus when mounted (DESIGN §6.40).
  const paneActive = usePaneActive();
  const paneActiveRef = useRef(paneActive);

  useLayoutEffect(() => {
    callbacks.current = { onToggleMode, onView };
    paneActiveRef.current = paneActive;
  });

  // The pane became active: its editor is the one palette commands and the toolbar act on.
  useLayoutEffect(() => {
    if (paneActive && view.current) setActiveEditor(view.current);
  }, [paneActive]);

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const ctx: NoteContext = {
      path: () => session.path,
      tree: currentTree,
      settings: currentSettings,
      openLink: (target, subpath) => void openLink(target, subpath, session.path),
      openTag,
      noteMeta: fetchNoteMeta,
      vaultTags: async () => (await fetchTags()).tags.map((t) => t.tag),
      recentPaths,
      save: () => void session.flush(),
      toggleMode: () => callbacks.current.onToggleMode(),
      insertFiles: (files, range, pasted) => void insertAttachments(session, files, range, pasted),
      linkTo: (path) => linkTo(path, session.path),
      showMenu: openContextMenu,
      renderEmbed: (el, embed) => renderLiveEmbed(el, embed, session.path),
      renderProperties: (el, yaml, onEdit) => renderLiveProperties(el, yaml, onEdit, session.path),
      renderMarkdown: (el, block) => renderLiveMarkdown(el, block, session.path),
      renderMath: renderLiveMath,
      blocks: editorBlocks,
    };
    const hooks: EditorHooks = {
      onLocalChange: () => session.markDirty(),
      onBlur: () => void session.flush(),
      readOnly,
      spellcheck,
      autocorrect,
      vim,
      livePreview: preview ? { visibility: syntaxVisibility, locked: preview === 'locked', checkboxes: !readOnly, remoteImages: loadRemoteImages } : null,
    };
    const state = session.prepareState((st) => st.update({ effects: StateEffect.reconfigure.of(extensions(ctx, hooks)) }).state);
    // Every transaction goes through the session, which keeps the file's editors in other panes equal.
    const v = new EditorView({ state, parent, dispatchTransactions: (trs, ev) => session.routeTransactions(ev, trs) });
    view.current = v;
    // The first vim editor loads its chunk, then switches it on.
    attachVim(v, vim);
    session.attach(v);
    if (paneActiveRef.current) setActiveEditor(v);
    const onFocus = () => {
      setActiveEditor(v);
      maybeShowTabEscapeHint();
    };
    v.contentDOM.addEventListener('focus', onFocus);
    callbacks.current.onView?.(v);
    if (paneActiveRef.current && (autoFocus || wantsNoteFocus())) v.focus();
    return () => {
      v.contentDOM.removeEventListener('focus', onFocus);
      clearActiveEditor(v);
      session.detach(v);
      v.destroy();
      view.current = null;
    };
    // `autoFocus` only matters at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, readOnly, preview, syntaxVisibility, loadRemoteImages, spellcheck, autocorrect, vim, extensions]);

  // Link decorations re-resolve when the vault changes.
  useEffect(() => {
    view.current?.dispatch({ effects: vaultChanged.of(null) });
  }, [tree]);

  return <div ref={host} className="note-editor" />;
}
