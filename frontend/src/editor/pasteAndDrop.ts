// Paste and drop into a note (DESIGN §6.6 #10, §6.6.1): images and PDFs become attachments
// inserted at the current selection (paste) or at the drop point; an explorer row dragged in
// (`application/x-notesapp-path`) inserts a link to it. Rich text pasted from a web page, Google
// Docs or Word becomes Markdown (features/htmlToMarkdown.ts, a lazy chunk loaded when the editor
// first gets the focus); plain text, and anything pasted with Mod-Shift-V, stays plain.
import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { modKey } from '../features/platform';
import { noteContext } from './context';

export const INTERNAL_PATH_TYPE = 'application/x-notesapp-path';

/**
 * What an explorer row's drag allows. Its targets ask for different operations: an explorer
 * folder `move`, a note's editor `link` (it inserts a link), other apps `copy`. A drop whose
 * `dropEffect` the source does not allow never fires (HTML drag-and-drop processing model).
 */
export const EXPLORER_DRAG_EFFECTS: DataTransfer['effectAllowed'] = 'all';

/** Whether a drag whose source allows `allowed` can drop with `effect` (the HTML spec's table). */
export function effectAllows(allowed: DataTransfer['effectAllowed'], effect: DataTransfer['dropEffect']): boolean {
  if (effect === 'none') return false;
  if (allowed === 'all' || allowed === 'uninitialized') return true;
  return allowed.toLowerCase().includes(effect);
}

/** Pasted images and PDFs become attachments; other clipboard content stays a text paste. */
function isPastableFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type === 'application/pdf';
}

function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files];
}

// ---------- rich paste ----------

type Converter = typeof import('../features/htmlToMarkdown');

let converter: Converter | null = null;
let loading: Promise<Converter> | null = null;

/** Loads the HTML-to-Markdown chunk (once; again after a failure). */
export function loadHtmlConverter(): Promise<Converter> {
  loading ??= import('../features/htmlToMarkdown').then(
    (m) => (converter = m),
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** Until when a paste is plain text: Mod-Shift-V was just pressed. */
let plainPasteUntil = 0;

const RICH_TAGS = /<(?:b|strong|i|em|s|del|strike|mark|code|pre|a|h[1-6]|ul|ol|li|table|blockquote|img|hr)[\s>/]/i;
const RICH_STYLES = /font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic|line-through/i;
const MONOSPACE = /monospace|consolas|courier|menlo|monaco/;

/**
 * What pasted HTML holds, read from an inert document (nothing in it runs or loads): its text, and
 * whether it carries formatting the plain text lacks. A code editor's copy (VS Code, JetBrains: a
 * monospace block of coloured spans) does not: it is code, pasted as its text.
 */
export function inspectHtml(html: string): { text: string; rich: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = (doc.body.textContent ?? '').trim();
  const root = [...doc.body.children].find((el) => !['META', 'STYLE', 'LINK', 'TITLE'].includes(el.tagName));
  const style = (root?.getAttribute('style') ?? '').toLowerCase();
  const code = root !== undefined && (root.tagName === 'PRE' || /white-space\s*:\s*pre(?![-\w])/.test(style)) && MONOSPACE.test(style);
  return { text, rich: !code && (RICH_TAGS.test(html) || RICH_STYLES.test(html)) };
}

/**
 * Markdown pasted inside a line keeps its blocks apart from the text around it: a heading, list,
 * quote, table or code block starts on a line of its own, and a table or list that ends the paste
 * does not take in the rest of the line.
 */
export function blockSafePaste(state: EditorState, from: number, to: number, markdown: string): string {
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const after = state.sliceDoc(to, state.doc.lineAt(to).to);
  let insert = markdown;
  if (/^(?:#{1,6}\s|[-+*]\s|\d{1,9}[.)]\s|>|\||```|~~~)/.test(markdown)) {
    if (before.trim() !== '') insert = '\n\n' + insert;
    // A table or code block right under a paragraph would be read as part of it.
    else if (/^(?:\||```|~~~)/.test(markdown) && line.number > 1 && state.doc.line(line.number - 1).text.trim() !== '') insert = '\n' + insert;
  }
  if (after.trim() !== '' && /(?:^|\n)(?:\||[-+*]\s|\d{1,9}[.)]\s|#{1,6}\s|>|```|~~~)[^\n]*$/.test(markdown)) insert += '\n\n';
  return insert;
}

function insertPasted(view: EditorView, markdown: string): void {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const insert = blockSafePaste(state, range.from, range.to, markdown);
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  view.dispatch(state.update(tr, { userEvent: 'input.paste', scrollIntoView: true }));
}

/** Converts `html` and inserts it; the plain text if the conversion fails or comes out empty. */
function pasteHtml(view: EditorView, html: string, text: string): void {
  const settings = view.state.facet(noteContext)?.settings();
  const options = { useWikilinks: settings?.files.useWikilinks ?? true, strictLineBreaks: settings?.editor.strictLineBreaks ?? false };
  const insert = (c: Converter | null) => {
    if (view.state.readOnly || !view.dom.isConnected) return;
    let markdown = '';
    try {
      markdown = c ? c.htmlToMarkdown(html, options) : '';
    } catch (e) {
      console.error('[notesapp] rich paste failed', e);
    }
    if (markdown.trim() === '') markdown = text;
    if (markdown !== '') insertPasted(view, markdown);
  };
  if (converter) insert(converter);
  else
    loadHtmlConverter().then(insert, () => insert(null));
}

export const pasteAndDrop = EditorView.domEventHandlers({
  focus() {
    void loadHtmlConverter().catch(() => {});
    return false;
  },
  keydown(event) {
    if (modKey(event) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v') plainPasteUntil = Date.now() + 1000;
    return false;
  },
  paste(event, view) {
    const ctx = view.state.facet(noteContext);
    if (!ctx || view.state.readOnly) return false;
    const plain = Date.now() < plainPasteUntil;
    plainPasteUntil = 0;
    const data = event.clipboardData;
    const html = plain ? '' : (data?.getData('text/html') ?? '');
    const files = filesOf(data).filter(isPastableFile);
    const content = html ? inspectHtml(html) : { text: '', rich: false };
    // A copied picture comes as a file (its HTML, if any, has no text); Word and Excel add a
    // picture of the copied text, which the text wins over.
    if (files.length > 0 && content.text === '') {
      event.preventDefault();
      const { from, to } = view.state.selection.main;
      ctx.insertFiles(files, { from, to }, true);
      return true;
    }
    if (!content.rich) return false;
    event.preventDefault();
    pasteHtml(view, html, data?.getData('text/plain') ?? '');
    return true;
  },
  dragover(event, view) {
    const types = event.dataTransfer?.types ?? [];
    if (view.state.readOnly || !(types.includes('Files') || types.includes(INTERNAL_PATH_TYPE))) return false;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'link';
    return false;
  },
  drop(event, view) {
    const ctx = view.state.facet(noteContext);
    if (!ctx || view.state.readOnly || !event.dataTransfer) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    const internal = event.dataTransfer.getData(INTERNAL_PATH_TYPE);
    if (internal) {
      event.preventDefault();
      const link = ctx.linkTo(internal);
      view.dispatch({ changes: { from: pos, insert: link }, selection: EditorSelection.cursor(pos + link.length), userEvent: 'input.drop' });
      view.focus();
      return true;
    }
    const files = filesOf(event.dataTransfer);
    if (files.length === 0) return false;
    event.preventDefault();
    ctx.insertFiles(files, { from: pos, to: pos }, false);
    return true;
  },
});
