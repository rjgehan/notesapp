// React host for the note's EditorView. React owns the host element; CodeMirror owns its inside.
// The view mounts the session's cached EditorState, so undo history survives switching notes.
import { StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { currentSettings, currentTree, fetchNoteMeta, fetchTags, useTree } from '../api/hooks';
import { insertAttachments } from '../features/attachments';
import { linkTo } from '../features/fileOps';
import { wantsNoteFocus } from '../features/focus';
import { openLink, openTag } from '../features/navigation';
import { recentPaths } from '../features/recent';
import { usePrefs } from '../state/prefs';
import type { DocumentSession } from '../sync/DocumentSession';
import { clearActiveEditor, setActiveEditor } from './activeEditor';
import { vaultChanged, type NoteContext } from './context';
import { noteExtensions, type EditorHooks } from './editorSetup';
import { maybeShowTabEscapeHint } from './tabEscapeHint';

export interface NoteEditorProps {
  session: DocumentSession;
  readOnly: boolean;
  /** Builds the extension list; defaults to the Markdown note editor. */
  extensions?(ctx: NoteContext, hooks: EditorHooks): Extension[];
  onToggleMode(): void;
  /** Called once the view exists (scroll restoration, heading targets). */
  onView?(view: EditorView): void;
  autoFocus?: boolean;
}

export function NoteEditor({ session, readOnly, extensions = noteExtensions, onToggleMode, onView, autoFocus }: NoteEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const spellcheck = usePrefs((s) => s.spellcheck);
  const autocorrect = usePrefs((s) => s.autocorrect);
  const tree = useTree().data;
  const callbacks = useRef({ onToggleMode, onView });

  useLayoutEffect(() => {
    callbacks.current = { onToggleMode, onView };
  });

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
    };
    const hooks: EditorHooks = {
      onLocalChange: () => session.markDirty(),
      onBlur: () => void session.flush(),
      readOnly,
      spellcheck,
      autocorrect,
    };
    const state = session.prepareState((st) => st.update({ effects: StateEffect.reconfigure.of(extensions(ctx, hooks)) }).state);
    const v = new EditorView({ state, parent });
    view.current = v;
    session.attach(v);
    setActiveEditor(v);
    const onFocus = () => {
      setActiveEditor(v);
      maybeShowTabEscapeHint();
    };
    v.contentDOM.addEventListener('focus', onFocus);
    callbacks.current.onView?.(v);
    if (autoFocus || wantsNoteFocus()) v.focus();
    return () => {
      v.contentDOM.removeEventListener('focus', onFocus);
      clearActiveEditor(v);
      session.detach(v);
      v.destroy();
      view.current = null;
    };
    // `autoFocus` only matters at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, readOnly, spellcheck, autocorrect, extensions]);

  // Link decorations re-resolve when the vault changes.
  useEffect(() => {
    view.current?.dispatch({ effects: vaultChanged.of(null) });
  }, [tree]);

  return <div ref={host} className="note-editor" />;
}
