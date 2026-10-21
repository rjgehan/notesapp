// A note editor for tests (Live Preview or source mode), with markers for the selection: `‸` is the
// cursor, `«` and `»` the anchor and head of a selection.
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { buildVaultTree } from '../api/vaultTree';
import type { NoteContext } from '../editor/context';
import { noteExtensions } from '../editor/editorSetup';
import type { LivePreviewConfig } from '../editor/livePreview';
import { DEFAULT_SETTINGS } from '../features/settings';

const views: EditorView[] = [];

/** Destroys the editors made since the last call (call it in afterEach). */
export function destroyEditors(): void {
  for (const v of views.splice(0)) v.destroy();
}

export const testTree = buildVaultTree({
  eventId: 'b.1',
  folders: [],
  files: [{ path: 'Note.md', name: 'Note.md', basename: 'Note', extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] }],
});

export function testContext(overrides: Partial<NoteContext> = {}): NoteContext {
  return {
    path: () => 'Here.md',
    tree: () => testTree,
    settings: () => DEFAULT_SETTINGS,
    openLink: () => {},
    openTag: () => {},
    noteMeta: () => Promise.reject(new Error('unused')),
    vaultTags: async () => [],
    recentPaths: () => [],
    save: () => {},
    toggleMode: () => {},
    insertFiles: () => {},
    linkTo: (p) => `[[${p}]]`,
    showMenu: () => {},
    ...overrides,
  };
}

export interface TestEditorOptions {
  /** `live` (default), `source` or `locked`. */
  mode?: 'live' | 'source' | 'locked';
  config?: Partial<LivePreviewConfig>;
  ctx?: Partial<NoteContext>;
  readOnly?: boolean;
}

/** Splits marked text into the document and its selection. */
export function unmark(marked: string): { doc: string; selection: EditorSelection } {
  const cursor = marked.indexOf('‸');
  if (cursor >= 0) return { doc: marked.slice(0, cursor) + marked.slice(cursor + 1), selection: EditorSelection.single(cursor) };
  const a = marked.indexOf('«');
  const b = marked.indexOf('»');
  if (a < 0 || b < 0) return { doc: marked, selection: EditorSelection.single(marked.length) };
  const doc = marked.replace('«', '').replace('»', '');
  // Positions in the document without the markers.
  const anchor = a < b ? a : a - 1;
  const head = b < a ? b : b - 1;
  return { doc, selection: EditorSelection.single(anchor, head) };
}

/** The document with the selection marked as in `unmark`. */
export function marked(view: EditorView): string {
  const doc = view.state.doc.toString();
  const { anchor, head } = view.state.selection.main;
  if (anchor === head) return doc.slice(0, head) + '‸' + doc.slice(head);
  const marks = [
    { at: anchor, s: '«' },
    { at: head, s: '»' },
  ].sort((x, y) => y.at - x.at);
  let out = doc;
  for (const m of marks) out = out.slice(0, m.at) + m.s + out.slice(m.at);
  return out;
}

/** A note editor attached to the document. */
export function noteEditor(text: string, { mode = 'live', config, ctx, readOnly = false }: TestEditorOptions = {}): EditorView {
  const { doc, selection } = unmark(text);
  const livePreview: LivePreviewConfig | null = mode === 'source' ? null : { visibility: 'hide-all', locked: mode === 'locked', checkboxes: !readOnly, ...config };
  const state = EditorState.create({
    doc,
    selection,
    extensions: noteExtensions(testContext(ctx), { onLocalChange: () => {}, onBlur: () => {}, readOnly, spellcheck: false, autocorrect: false, livePreview }),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

/** A key press through the editor's keymaps (no browser default behind it). */
export function press(view: EditorView, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...mods }), 'editor');
}

/** Types text a character at a time, as the browser does: through the editor's input handlers. */
export function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    let tr: Transaction | null = null;
    const insert = () => (tr ??= view.state.update({ changes: { from, to, insert: ch }, selection: EditorSelection.cursor(from + ch.length), userEvent: 'input.type' }));
    if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
  }
}

/** Parses the whole document (tests check the tree right after an edit). */
export function parsed(view: EditorView): void {
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  // A state's tree is the parse as of its transaction: one more transaction brings the finished one in.
  view.dispatch({});
}
