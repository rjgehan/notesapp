// The `/` menu (ROADMAP item 31, DESIGN §6.6.2): typed at the start of a line or after a space, a
// slash opens a filtered list of things to insert or turn the line into. It is a completion source
// like `[[` and `#` (§6.6 #8), so the keys, the ranking and the tooltip are the completion's; the
// items run the editor's own commands (formatting.ts, editorCommands.ts, the table and the app's
// palette commands) instead of copies of them.
import { currentCompletions, pickedCompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, type Command, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { fuzzyRank } from '../features/fuzzy';
import { isCoarsePointer } from '../features/platform';
import { noteContext } from './context';
import { CODE_NODES, inFrontmatter } from './linkAt';
import { tableCellHost } from './livePreview/table/facets';
import { editorSlashItems } from './slashItems';
import { vimModeOf } from './vimMode';
import { registeredSlashItems, type SlashItem } from './slashRegistry';

// The item type and the app's registrations live in slashRegistry.ts (eager, small).
export { registerSlashItem, type SlashItem, type SlashScope } from './slashRegistry';

/** Every item, the editor's own and the registered ones, in menu order. */
export function slashItems(): SlashItem[] {
  const all = new Map<string, SlashItem>();
  for (const item of editorSlashItems()) all.set(item.id, item);
  for (const item of registeredSlashItems()) all.set(item.id, item);
  return [...all.values()].sort((a, b) => a.order - b.order);
}

/** A slash at a line start or after whitespace, then the query (letters, digits, `-` and `_`). */
const SLASH_QUERY = /(?:^|\s)\/[\p{L}\p{N}_-]*$/u;

/** Where no menu opens: code, comments, HTML, math, links and their addresses. */
const NO_MENU = new Set([...CODE_NODES, 'InlineMath', 'BlockMath', 'WikiLink', 'Embed', 'Link', 'Image', 'URL', 'Autolink', 'Frontmatter']);

function within(state: EditorState, pos: number, names: ReadonlySet<string>): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (names.has(node.name)) return true;
  }
  return false;
}

const TABLE = new Set(['Table']);

/** Vim's normal and visual modes type commands, not text (a `/` there is vim's search). */
function vimTypesCommands(view: EditorView | undefined): boolean {
  const mode = view ? vimModeOf(view) : null;
  return mode !== null && mode !== 'INSERT' && mode !== 'REPLACE';
}

const MAX_OPTIONS = 80;

export const slashSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const { state, pos } = context;
  if (!state.facet(noteContext) || state.readOnly) return null;
  const match = context.matchBefore(SLASH_QUERY);
  if (!match) return null;
  const slash = match.from + (match.text.startsWith('/') ? 0 : 1);
  if (within(state, slash + 1, NO_MENU) || inFrontmatter(state, slash + 1) || vimTypesCommands(context.view)) return null;
  // In a table cell's editor, or on a table's line in source mode, only text at the cursor fits.
  const inline = state.facet(tableCellHost) !== null || within(state, slash + 1, TABLE);
  const view = context.view;
  const eligible = slashItems().filter((i) => (!inline || i.scope === 'inline') && (!i.when || (view !== undefined && i.when(view))));
  const query = state.sliceDoc(slash + 1, pos);
  const ranked = query === '' ? eligible : fuzzyRank(query, eligible, [(i) => i.label, (i) => i.keywords ?? ''], MAX_OPTIONS).map((r) => r.item);
  if (ranked.length === 0) return null;
  const options: Completion[] = ranked.map((item) => ({
    label: item.label,
    detail: item.hint?.(state) ?? item.group,
    type: 'slash',
    apply: (v, completion, _from, to) => applyItem(v, completion, item, slash, to),
  }));
  return { from: slash + 1, options, filter: false };
};

/** Removes the typed `/query`, then runs the item where it was. */
function applyItem(view: EditorView, completion: Completion, item: SlashItem, slash: number, to: number): void {
  view.dispatch({
    changes: { from: slash, to, insert: '' },
    selection: { anchor: slash },
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  });
  item.run(view);
}

/** The completion tooltip's class while it shows the `/` menu (the phone docks it above the keyboard). */
export function slashMenuClass(state: EditorState): string {
  return currentCompletions(state)[0]?.type === 'slash' ? 'cm-slash-menu' : '';
}

/**
 * Types a `/` (after a space when the cursor follows text) and opens the menu: the phone toolbar's
 * Insert button and the palette's "Insert…".
 */
export const openSlashMenu: Command = (view) => {
  if (view.state.readOnly || !view.state.facet(noteContext)) return false;
  const { from, to } = view.state.selection.main;
  const before = view.state.sliceDoc(from - 1, from);
  const insert = before === '' || /\s/.test(before) ? '/' : ' /';
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type', scrollIntoView: true });
  startCompletion(view);
  return true;
};

/**
 * On a touch screen the menu is docked above the editing toolbar (editor.css), where it could
 * cover the line being typed on: when it opens, the line scrolls up to sit just above it.
 */
export const slashMenuDocking = ViewPlugin.fromClass(
  class {
    private open = false;
    update(update: ViewUpdate) {
      const open = slashMenuClass(update.state) !== '';
      if (open && !this.open && isCoarsePointer()) {
        const view = update.view;
        // After the tooltip is drawn (and outside the update, where dispatching is not allowed).
        setTimeout(() => {
          const menu = view.dom.querySelector('.cm-slash-menu');
          if (!menu || !view.dom.isConnected) return;
          const height = menu.getBoundingClientRect().height;
          view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'end', yMargin: height + 24 }) });
        }, 0);
      }
      this.open = open;
    }
  },
);
