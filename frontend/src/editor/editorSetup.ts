// The editor's extension list (DESIGN §6.6). No wrapper library: React owns the host element,
// CodeMirror owns everything inside it.
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, type LanguageSupport } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder } from '@codemirror/view';
import { isIOS, modKey } from '../features/platform';
import { headingSource, tagSource, wikilinkSource } from './completion';
import { noteContext, type NoteContext } from './context';
import { followLink, followLinkAtCursor, insertMarkdownLink, saveNow, toggleBold, toggleCheckbox, toggleItalic, toggleMode } from './editorCommands';
import { lineClassPlugin, obsidianHighlight } from './highlight';
import { linkAt } from './linkAt';
import { markdownNoteLanguage } from './language';
import { livePreview, livePreviewInline, type LivePreviewConfig } from './livePreview';
import { cellLanguage, tableCellSetup } from './livePreview/table';
import { pasteAndDrop } from './pasteAndDrop';
import { isLocalEdit } from './remote';
import { searchHighlight } from './searchHighlight';
import { smartPunctuationGuard } from './smartPunctuation';
import { unresolvedLinks } from './unresolved';
import { uploadsField } from './uploads';

export interface EditorHooks {
  /** A local (non-remote) document change: the session marks itself dirty. */
  onLocalChange(): void;
  /** Editor blur: the session flushes. */
  onBlur(): void;
  /** The session cannot be written (a lossy or read-only file). */
  readOnly: boolean;
  spellcheck: boolean;
  autocorrect: boolean;
  /** Live Preview (DESIGN §6.6.1); absent or null is styled source mode. A locked Live Preview is read-only. */
  livePreview?: LivePreviewConfig | null;
}

/**
 * Sticky elements that cover the top of the scroller (the note header bar, the conflict banner),
 * so the caret stays clear of them. The mobile toolbar needs no margin: it is a grid row below
 * the scroller, not an overlay.
 */
function coveredMargins(view: EditorView): { top: number } {
  let height = 0;
  let bottom = -Infinity;
  for (const el of document.querySelectorAll<HTMLElement>('[data-covers-top]')) {
    if (getComputedStyle(el).position !== 'sticky') continue;
    height += el.offsetHeight;
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
  }
  if (height === 0) return { top: 0 };
  // CodeMirror reads the margin as the covered part of its own scroll area, and also hides
  // tooltips anchored there. Its scrollDOM does not scroll (the workspace does), so only the part
  // of the editor actually under the sticky elements counts; the full height would hide the
  // completion popup on a note's first lines.
  const overlap = bottom - view.scrollDOM.getBoundingClientRect().top;
  return { top: Math.max(0, Math.min(height, overlap)) };
}

function common(hooks: EditorHooks): Extension[] {
  const readOnly = hooks.readOnly || hooks.livePreview?.locked === true;
  return [
    history(),
    // The session's pending attachment uploads (the same field instance, so they survive mounts).
    uploadsField,
    isIOS ? [] : drawSelection(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: String(hooks.spellcheck),
      autocorrect: hooks.autocorrect ? 'on' : 'off',
      autocapitalize: 'sentences',
      enterkeyhint: 'enter',
    }),
    EditorView.scrollMargins.of(coveredMargins),
    EditorView.cursorScrollMargin.of({ x: 5, y: 32 }),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.updateListener.of((update) => {
      if (update.transactions.some(isLocalEdit)) hooks.onLocalChange();
      if (update.focusChanged && !update.view.hasFocus) hooks.onBlur();
    }),
  ];
}

function baseKeymaps(): Extension {
  return [
    Prec.highest(
      keymap.of([
        { key: 'Mod-Alt-ArrowLeft', run: () => {
          window.history.back();
          return true;
        }, preventDefault: true },
        { key: 'Mod-Alt-ArrowRight', run: () => {
          window.history.forward();
          return true;
        }, preventDefault: true },
      ]),
    ),
  ];
}

/** Clicking with Mod follows a link or tag; selection-adding moves to Alt-click. */
const clickNavigation: Extension = [
  EditorView.clickAddsSelectionRange.of((e) => e.altKey),
  EditorView.domEventHandlers({
    click(event, view) {
      if (!modKey(event) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const hit = linkAt(view.state, pos);
      if (!hit || !view.state.facet(noteContext)) return false;
      event.preventDefault();
      return followLink(view, hit);
    },
  }),
];

const noteKeymap = [
  { key: 'Mod-s', run: saveNow, preventDefault: true },
  { key: 'Mod-Enter', run: followLinkAtCursor },
  { key: 'Mod-l', run: toggleCheckbox, preventDefault: true },
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-k', run: insertMarkdownLink, preventDefault: true },
  { key: 'Mod-e', run: toggleMode, preventDefault: true },
];

/**
 * The editor of a table cell being edited in Live Preview (DESIGN §6.6.1): one line of inline
 * Markdown with the note's rendering, completion and formatting keys. Its undo history is the
 * note's, and the grid adds the keys that move between cells.
 */
function tableCellExtensions(ctx: NoteContext, hooks: EditorHooks, config: LivePreviewConfig): Extension[] {
  return [
    noteContext.of(ctx),
    isIOS ? [] : drawSelection(),
    cellLanguage,
    syntaxHighlighting(obsidianHighlight),
    livePreviewInline({ ...config, locked: false }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: String(hooks.spellcheck),
      autocorrect: hooks.autocorrect ? 'on' : 'off',
      autocapitalize: 'sentences',
      enterkeyhint: 'next',
    }),
    closeBrackets(),
    autocompletion({ override: [wikilinkSource, headingSource, tagSource], icons: false }),
    clickNavigation,
    unresolvedLinks,
    smartPunctuationGuard,
    keymap.of(noteKeymap.filter((k) => k.key !== 'Mod-l')),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap]),
  ];
}

/** The Markdown note editor (DESIGN §6.6 #1–16), in Live Preview or styled source mode (§6.6.1). */
export function noteExtensions(ctx: NoteContext, hooks: EditorHooks): Extension[] {
  const preview = hooks.livePreview;
  return [
    noteContext.of(ctx),
    common(hooks),
    preview?.locked ? [] : placeholder('Start writing…'),
    markdownNoteLanguage(),
    syntaxHighlighting(obsidianHighlight),
    lineClassPlugin,
    preview ? livePreview(preview) : [],
    preview && !preview.locked ? tableCellSetup.of(() => tableCellExtensions(ctx, hooks, preview)) : [],
    autocompletion({ override: [wikilinkSource, headingSource, tagSource], icons: false }),
    clickNavigation,
    unresolvedLinks,
    smartPunctuationGuard,
    searchHighlight,
    pasteAndDrop,
    baseKeymaps(),
    keymap.of(noteKeymap),
    keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
  ];
}

/** Plain text files (`text` view): the same editing basics, with an optional language. */
export function plainTextExtensions(hooks: EditorHooks & { save(): void }, language: LanguageSupport | null): Extension[] {
  return [
    common(hooks),
    language ?? [],
    language ? syntaxHighlighting(obsidianHighlight) : [],
    baseKeymaps(),
    keymap.of([{ key: 'Mod-s', run: () => {
          hooks.save();
          return true;
        }, preventDefault: true }]),
    keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
  ];
}
