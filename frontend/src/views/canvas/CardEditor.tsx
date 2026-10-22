// Inline editing of a text card: a small CodeMirror Markdown editor with the note editor's
// language, highlighting and `[[` / `#` completion, resolved from the canvas's own folder (as
// Obsidian resolves links in canvas cards). Esc or a tap outside the card ends editing.
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder, tooltips } from '@codemirror/view';
import { useLayoutEffect, useRef } from 'react';
import { currentSettings, currentTree, fetchNoteMeta, fetchTags } from '../../api/hooks';
import { openContextMenu } from '../../components/overlays/openContextMenu';
import { clearActiveEditor, setActiveEditor } from '../../editor/activeEditor';
import { headingSource, tagSource, wikilinkSource } from '../../editor/completion';
import { noteContext, type NoteContext } from '../../editor/context';
import { followLinkAtCursor, toggleCheckbox } from '../../editor/editorCommands';
import { formatting, toggleBold, toggleItalic, toggleLink } from '../../editor/formatting';
import { lineClassPlugin, obsidianHighlight } from '../../editor/highlight';
import { markdownNoteLanguage } from '../../editor/language';
import { pasteAndDrop } from '../../editor/pasteAndDrop';
import { unresolvedLinks } from '../../editor/unresolved';
import { linkTo } from '../../features/fileOps';
import { uploadForCard } from './actions';
import { openLink, openTag } from '../../features/navigation';
import { editorBlocks } from '../../features/blockRefs';
import { recentPaths } from '../../features/recent';
import { usePrefs } from '../../state/prefs';

interface Props {
  text: string;
  canvasPath: string;
  onChange(text: string): void;
  onDone(): void;
  onSave(): void;
  onBlur(): void;
  /** Enter ends editing through this (Shift+Enter starts a new line), as Kanban cards do. */
  onEnter?(): void;
  /** The host's class (default `canvas-card-editor`). */
  className?: string;
}

export function CardEditor({ text, canvasPath, onChange, onDone, onSave, onBlur, onEnter, className = 'canvas-card-editor' }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const spellcheck = usePrefs((s) => s.spellcheck);
  const autocorrect = usePrefs((s) => s.autocorrect);
  const callbacks = useRef({ onChange, onDone, onSave, onBlur, onEnter });
  const initial = useRef(text);
  const viewRef = useRef<EditorView | null>(null);

  useLayoutEffect(() => {
    callbacks.current = { onChange, onDone, onSave, onBlur, onEnter };
  });

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const ctx: NoteContext = {
      path: () => canvasPath,
      tree: currentTree,
      settings: currentSettings,
      openLink: (target, subpath) => void openLink(target, subpath, canvasPath),
      openTag,
      noteMeta: fetchNoteMeta,
      vaultTags: async () => (await fetchTags()).tags.map((t) => t.tag),
      recentPaths,
      save: () => callbacks.current.onSave(),
      insertFiles: (files, range, pasted) => {
        void uploadForCard(canvasPath, files, pasted).then((embeds) => {
          const v = viewRef.current;
          if (!v || embeds.length === 0) return;
          const end = v.state.doc.length;
          const from = Math.min(range.from, end);
          const to = Math.min(Math.max(range.to, from), end);
          const insert = embeds.join('\n');
          v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
        });
      },
      linkTo: (path) => linkTo(path, canvasPath),
      showMenu: openContextMenu,
      // A card is styled source: no Live Preview widgets to draw.
      renderEmbed: () => () => {},
      renderProperties: () => () => {},
      blocks: editorBlocks,
    };
    const view: EditorView = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current,
        selection: { anchor: initial.current.length },
        extensions: [
          noteContext.of(ctx),
          history(),
          markdownNoteLanguage(),
          syntaxHighlighting(obsidianHighlight),
          lineClassPlugin,
          unresolvedLinks,
          // Pasted or dropped images become attachments of the canvas, embedded in the card.
          pasteAndDrop,
          closeBrackets(),
          formatting(),
          autocompletion({ override: [wikilinkSource, headingSource, tagSource], icons: false }),
          // Completions draw on the page, unscaled and unclipped by the card.
          tooltips({ parent: document.body }),
          placeholder('Type here…'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            spellcheck: String(spellcheck),
            autocorrect: autocorrect ? 'on' : 'off',
            autocapitalize: 'sentences',
            'aria-label': 'Card text',
          }),
          keymap.of([
            { key: 'Escape', run: () => (callbacks.current.onDone(), true) },
            { key: 'Enter', run: () => (callbacks.current.onEnter ? (callbacks.current.onEnter(), true) : false) },
            { key: 'Shift-Enter', run: (v) => (callbacks.current.onEnter ? insertNewlineAndIndent(v) : false) },
            { key: 'Mod-s', run: () => (callbacks.current.onSave(), true), preventDefault: true },
            { key: 'Mod-Enter', run: followLinkAtCursor },
            { key: 'Mod-l', run: toggleCheckbox, preventDefault: true },
            { key: 'Mod-b', run: toggleBold, preventDefault: true },
            { key: 'Mod-i', run: toggleItalic, preventDefault: true },
            { key: 'Mod-k', run: toggleLink, preventDefault: true },
          ]),
          keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              initial.current = u.state.doc.toString();
              callbacks.current.onChange(initial.current);
            }
            if (u.focusChanged && !u.view.hasFocus) callbacks.current.onBlur();
            if (u.focusChanged && u.view.hasFocus) setActiveEditor(u.view);
          }),
        ],
      }),
    });
    viewRef.current = view;
    setActiveEditor(view);
    // Inside the gesture that started editing (the caller renders synchronously), so iOS opens the keyboard.
    view.focus();
    return () => {
      viewRef.current = null;
      clearActiveEditor(view);
      view.destroy();
    };
  }, [canvasPath, spellcheck, autocorrect]);

  return <div ref={host} className={className} onPointerDown={(e) => e.stopPropagation()} />;
}
