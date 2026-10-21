// The editor's extension list (DESIGN §6.6). No wrapper library: React owns the host element,
// CodeMirror owns everything inside it.
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, type LanguageSupport } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder } from '@codemirror/view';
import { isCustomized } from '../features/hotkeyPrefs';
import { isIOS, modKey } from '../features/platform';
import { headingSource, tagSource, wikilinkSource } from './completion';
import { noteContext, type NoteContext } from './context';
import { followLinkAtCursor, insertMarkdownLink, saveNow, toggleBold, toggleCheckbox, toggleItalic, toggleMode } from './editorCommands';
import { lineClassPlugin, obsidianHighlight } from './highlight';
import { linkAt } from './linkAt';
import { markdownNoteLanguage } from './language';
import { pasteAndDrop } from './pasteAndDrop';
import { isLocalEdit } from './remote';
import { searchHighlight } from './searchHighlight';
import { smartPunctuationGuard } from './smartPunctuation';
import { unresolvedLinks } from './unresolved';
import { trackedRangesField } from './tracked';
import { uploadsField } from './uploads';
import { editorCommandKeys, vimSlot, type CommandKey } from './vimMode';

export interface EditorHooks {
  /** A local (non-remote) document change: the session marks itself dirty. */
  onLocalChange(): void;
  /** Editor blur: the session flushes. */
  onBlur(): void;
  readOnly: boolean;
  spellcheck: boolean;
  autocorrect: boolean;
  /** Vim keys (DESIGN §6.36): the preference, on a device where vim applies. */
  vim?: boolean;
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
  return [
    // Vim (lazy, empty until its chunk has loaded); it sets its own precedence.
    vimSlot(hooks.vim === true),
    history(),
    // The session's pending attachment uploads and tracked ranges (the same field instances, so
    // they survive mounts).
    uploadsField,
    trackedRangesField,
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
    EditorState.readOnly.of(hooks.readOnly),
    EditorView.editable.of(!hooks.readOnly),
    EditorView.updateListener.of((update) => {
      if (update.transactions.some(isLocalEdit)) hooks.onLocalChange();
      if (update.focusChanged && !update.view.hasFocus) hooks.onBlur();
    }),
  ];
}

/**
 * A default key of the editor, which steps aside when this device gave the command another key
 * (Settings, Hotkeys; DESIGN §6.25): the global handler then runs the command on its new key.
 */
function ifDefault(id: string, run: (view: EditorView) => boolean): (view: EditorView) => boolean {
  return (view) => !isCustomized(id) && run(view);
}

/** The search panel's keys, with Mod-f following the `editor.find` command's key. */
const findKeymap = searchKeymap.map((b) => (b.key === 'Mod-f' && b.run ? { ...b, run: ifDefault('editor.find', b.run) } : b));

/** The keymap for an editor's command keys, each stepping aside once customized. */
function commandKeymap(keys: readonly CommandKey[]): Extension {
  return [
    editorCommandKeys.of(keys),
    keymap.of(keys.map((k) => ({ key: k.key, run: ifDefault(k.id, k.run), preventDefault: k.preventDefault }))),
  ];
}

const noteCommandKeys: readonly CommandKey[] = [
  { key: 'Mod-s', id: 'editor.save', run: saveNow, preventDefault: true },
  { key: 'Mod-Enter', id: 'editor.followLink', run: followLinkAtCursor },
  { key: 'Mod-l', id: 'editor.toggleCheckbox', run: toggleCheckbox, preventDefault: true },
  { key: 'Mod-b', id: 'editor.bold', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', id: 'editor.italic', run: toggleItalic, preventDefault: true },
  { key: 'Mod-k', id: 'editor.insertLink', run: insertMarkdownLink, preventDefault: true },
  { key: 'Mod-e', id: 'editor.toggleMode', run: toggleMode, preventDefault: true },
];

/** Mod-f, for vim's benefit only: the search keymap binds it in the editor (findKeymap). */
const findCommandKey: CommandKey = { key: 'Mod-f', id: 'editor.find', run: openSearchPanel };

function baseKeymaps(): Extension {
  return [
    Prec.highest(
      keymap.of([
        { key: 'Mod-Alt-ArrowLeft', run: ifDefault('nav.back', () => {
          window.history.back();
          return true;
        }), preventDefault: true },
        { key: 'Mod-Alt-ArrowRight', run: ifDefault('nav.forward', () => {
          window.history.forward();
          return true;
        }), preventDefault: true },
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
      const ctx = view.state.facet(noteContext);
      if (!hit || !ctx) return false;
      event.preventDefault();
      if (hit.kind === 'internal') ctx.openLink(hit.target, hit.subpath);
      else if (hit.kind === 'tag') ctx.openTag(hit.tag);
      else window.open(hit.url, '_blank', 'noopener,noreferrer');
      return true;
    },
  }),
];

/** The Markdown note editor (DESIGN §6.6 #1–16). */
export function noteExtensions(ctx: NoteContext, hooks: EditorHooks): Extension[] {
  return [
    noteContext.of(ctx),
    common(hooks),
    placeholder('Start writing…'),
    markdownNoteLanguage(),
    syntaxHighlighting(obsidianHighlight),
    lineClassPlugin,
    autocompletion({ override: [wikilinkSource, headingSource, tagSource], icons: false }),
    clickNavigation,
    unresolvedLinks,
    smartPunctuationGuard,
    searchHighlight,
    pasteAndDrop,
    baseKeymaps(),
    commandKeymap(noteCommandKeys),
    editorCommandKeys.of([findCommandKey]),
    keymap.of([...closeBracketsKeymap, ...findKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
  ];
}

/** Plain text files (`text` view): the same editing basics, with an optional language. */
export function plainTextExtensions(hooks: EditorHooks & { save(): void }, language: LanguageSupport | null): Extension[] {
  return [
    common(hooks),
    language ?? [],
    language ? syntaxHighlighting(obsidianHighlight) : [],
    baseKeymaps(),
    commandKeymap([
      {
        key: 'Mod-s',
        id: 'editor.save',
        run: () => {
          hooks.save();
          return true;
        },
        preventDefault: true,
      },
    ]),
    editorCommandKeys.of([findCommandKey]),
    keymap.of([...closeBracketsKeymap, ...findKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
  ];
}
