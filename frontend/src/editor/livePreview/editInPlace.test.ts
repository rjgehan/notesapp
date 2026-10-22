// Everything Live Preview renders is editable in place (DESIGN §6.6.1): a click on each rendered
// element puts the caret into its source, which then shows as text. Callouts, math blocks and
// Mermaid are in render/liveRich.test.tsx (they need the app's renderer).
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyEditors, marked, noteEditor, treeOf, typeText } from '../../test/noteEditor';
import { activeEditor } from '../activeEditor';
import { editingProperties, shownBlocks } from './blocks';

afterEach(() => destroyEditors());

const tree = treeOf('Here.md', 'Note.md', 'pic.png', 'Files/doc.pdf', 'song.mp3');

function editor(text: string, options: Parameters<typeof noteEditor>[1] = {}): EditorView {
  return noteEditor(text, { ...options, ctx: { tree: () => tree, ...options.ctx } });
}

function mousedown(el: Element | null): void {
  expect(el).not.toBeNull();
  el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
}

const shownText = (view: EditorView) => view.contentDOM.textContent ?? '';

describe('a click on what Live Preview renders puts the caret in its source', () => {
  it('an image: before the closing brackets, and its source shows (the image still after it)', () => {
    const view = editor('Look ![[pic.png|300]] here');
    expect(shownText(view)).not.toContain('![[pic.png|300]]');
    mousedown(view.contentDOM.querySelector('.cm-lp-embed-image .cm-lp-embed-content'));
    expect(marked(view)).toBe('Look ![[pic.png|300‸]] here');
    expect(shownText(view)).toContain('![[pic.png|300]]');
    expect(view.contentDOM.querySelector('.cm-lp-embed-image')).not.toBeNull();
    // Typing edits the source: the size changes.
    view.dispatch({ changes: { from: view.state.selection.main.head - 1, to: view.state.selection.main.head, insert: '4' } });
    expect(view.state.doc.toString()).toBe('Look ![[pic.png|304]] here');
  });

  it('a Markdown image: before its closing parenthesis', () => {
    const view = editor('![a cat|200](pic.png)');
    mousedown(view.contentDOM.querySelector('.cm-lp-embed-image .cm-lp-embed-content'));
    expect(marked(view)).toBe('![a cat|200](pic.png‸)');
  });

  it('a web image', () => {
    const view = editor('A ![x](https://e.com/i.png) b');
    mousedown(view.contentDOM.querySelector('.cm-lp-web-image'));
    expect(marked(view)).toBe('A ![x](https://e.com/i.png‸) b');
  });

  it('an embed that takes its own clicks (a PDF, audio, a note) has an edit button', () => {
    const view = editor('![[doc.pdf#page=2]]\n\n![[song.mp3]]\n\n![[Note]]');
    const buttons = view.contentDOM.querySelectorAll('.cm-lp-embed-edit');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute('aria-label')).toBe('Edit the embed');
    mousedown(buttons[1]);
    expect(marked(view)).toBe('![[doc.pdf#page=2]]\n\n![[song.mp3‸]]\n\n![[Note]]');
    expect(shownText(view)).toContain('![[song.mp3]]');
  });

  it('an embed shown as a link (a missing file, a block reference)', () => {
    const view = editor('See ![[Missing.png]] now');
    mousedown(view.contentDOM.querySelector('.cm-lp-embed-link'));
    expect(marked(view)).toBe('See ![[Missing.png‸]] now');
    expect(shownText(view)).toContain('![[Missing.png]]');
  });

  it('a footnote: its tooltip has Edit, which puts the caret in the reference', () => {
    const view = editor('Text[^1] more‸\n\n[^1]: The note.');
    (view.contentDOM.querySelector('.cm-lp-footnote') as HTMLElement).click();
    const edit = view.dom.querySelector<HTMLElement>('.cm-lp-footnote-tooltip .cm-lp-footnote-edit');
    expect(edit?.textContent).toBe('Edit');
    edit!.click();
    expect(marked(view)).toBe('Text[^1‸] more\n\n[^1]: The note.');
    expect(shownText(view)).toContain('[^1]');
    expect(view.dom.querySelector('.cm-lp-footnote-tooltip')).toBeNull();
  });

  it('an inline footnote: Edit puts the caret in its text', () => {
    const view = editor('Text^[an inline note].');
    (view.contentDOM.querySelector('.cm-lp-footnote') as HTMLElement).click();
    view.dom.querySelector<HTMLElement>('.cm-lp-footnote-edit')!.click();
    expect(marked(view)).toBe('Text^[an inline note‸].');
  });

  it('an inline comment shows a marker; a click shows its text with the caret in it', () => {
    const view = editor('a %%secret%% b');
    expect(shownText(view)).not.toContain('secret');
    const chip = view.contentDOM.querySelector('.cm-lp-comment-chip');
    expect(chip?.getAttribute('title')).toBe('secret');
    mousedown(chip);
    expect(marked(view)).toBe('a %%‸secret%% b');
    expect(shownText(view)).toContain('%%secret%%');
    typeText(view, 'top ');
    expect(view.state.doc.toString()).toBe('a %%top secret%% b');
  });

  it('a comment block shows a marker; a click shows it as text until the caret leaves it', () => {
    const doc = 'Text\n\n%%\nhidden\n%%\n\nAfter';
    const view = editor(doc);
    expect(shownBlocks(view.state).map((b) => b.kind)).toEqual(['comment']);
    mousedown(view.contentDOM.querySelector('.cm-lp-hidden-comment.is-editable'));
    expect(marked(view)).toBe('Text\n\n%%\n‸hidden\n%%\n\nAfter');
    expect(shownBlocks(view.state)).toEqual([]);
    expect(shownText(view)).toContain('hidden');
    typeText(view, 'not ');
    expect(view.state.doc.toString()).toBe('Text\n\n%%\nnot hidden\n%%\n\nAfter');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), userEvent: 'select' });
    expect(shownBlocks(view.state).map((b) => b.kind)).toEqual(['comment']);
  });

  it('the properties: the typed editor while editing, and Edit shows the YAML', () => {
    const view = editor('---\ntags: [a]\n---\nBody');
    expect(editingProperties(view.state)).toBe(false);
    (view.dom.querySelector('.test-properties-edit') as HTMLElement).click();
    expect(editingProperties(view.state)).toBe(true);
    expect(marked(view)).toBe('---\ntags: [a]‸\n---\nBody');
  });

  it('a table cell opens its editor on a click', () => {
    const view = editor('Intro\n\n| a | b |\n|---|---|\n| c | d |\n');
    view.dom.querySelectorAll<HTMLElement>('td')[1].click();
    const cell = activeEditor();
    expect(cell).not.toBe(view);
    expect(cell?.state.doc.toString()).toBe('d');
  });

  it('a task checkbox toggles in the note', () => {
    const view = editor('- [ ] task');
    view.contentDOM.querySelector<HTMLInputElement>('input.cm-lp-checkbox')!.click();
    expect(view.state.doc.toString()).toBe('- [x] task');
  });

  it('a block id shows when a click lands at the end of its line', () => {
    const view = editor('A paragraph ^para1\n\nNext');
    expect(shownText(view)).not.toContain('^para1');
    view.dispatch({ selection: EditorSelection.cursor('A paragraph ^para1'.length), userEvent: 'select.pointer' });
    expect(shownText(view)).toContain('^para1');
  });

  it('a code block shows its fences when a click lands in it', () => {
    const view = editor('Text\n\n```js\nlet a = 1;\n```\n');
    expect(shownText(view)).not.toContain('```');
    view.dispatch({ selection: EditorSelection.cursor('Text\n\n```js\nlet'.length), userEvent: 'select.pointer' });
    expect(shownText(view)).toContain('```js');
  });

  it('a note that cannot be written reveals nothing and shows no comment markers', () => {
    const view = editor('![[pic.png]] ![[song.mp3]] a %%c%% b\n\n%%\nblock\n%%', { mode: 'locked' });
    mousedown(view.contentDOM.querySelector('.cm-lp-embed-image .cm-lp-embed-content'));
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(view.contentDOM.querySelector('.cm-lp-comment-chip')).toBeNull();
    expect(view.contentDOM.querySelector('.cm-lp-hidden-comment.is-editable')).toBeNull();
  });
});
