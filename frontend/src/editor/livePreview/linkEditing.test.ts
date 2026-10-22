// Editing a link's hidden target in hide-all mode (DESIGN §6.6.1, "Editing a link"): a caret or a
// selection inside a link shows its full markup once no button is held; at its edges the link
// stays rendered, Mod-click follows it without adding a cursor.
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, marked, noteEditor, press, treeOf } from '../../test/noteEditor';
import { LINK_REVEAL_DELAY_MS } from './index';
import { collectElements, HIDE_ALL, isRevealed, selectionInLink } from './model';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { markdownNoteLanguage } from '../language';

afterEach(() => {
  destroyEditors();
  vi.useRealTimers();
});

const tree = treeOf('Note.md', 'Here.md');
const shown = (view: EditorView) => view.contentDOM.textContent ?? '';

async function focused(text: string): Promise<EditorView> {
  const view = noteEditor(text, { ctx: { tree: () => tree } });
  view.focus();
  await vi.waitFor(() => expect(view.hasFocus).toBe(true));
  // The focus change reaches the plugin in an update.
  view.dispatch({});
  return view;
}

describe('a link shows its target while the caret is inside it', () => {
  it('[[Note|alias]]: a caret in the alias shows the whole link, leaving it hides it again', async () => {
    const view = await focused('See [[Note|ali‸as]] now');
    expect(shown(view)).toContain('[[Note|alias]]');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expect(shown(view)).not.toContain('[[');
    expect(shown(view)).toContain('alias');
  });

  it('[text](url): the url shows and can be edited', async () => {
    const view = await focused('A [te‸xt](https://a.example) b');
    expect(shown(view)).toContain('[text](https://a.example)');
    const at = view.state.doc.toString().indexOf('a.example');
    view.dispatch({ changes: { from: at, to: at + 1, insert: 'b' }, selection: EditorSelection.cursor(at + 1) });
    expect(view.state.doc.toString()).toBe('A [text](https://b.example) b');
    expect(shown(view)).toContain('(https://b.example)');
  });

  it('[[Note#Heading]]: the heading part shows', async () => {
    const view = await focused('Go [[Note#Hea‸ding]].');
    expect(shown(view)).toContain('[[Note#Heading]]');
  });

  it('a caret just before or just after a link leaves it rendered', async () => {
    const view = await focused('See ‸[[Note|alias]] now');
    expect(shown(view)).not.toContain('[[');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.toString().indexOf(' now')) });
    expect(shown(view)).not.toContain('[[');
  });

  it('ArrowLeft from after a link steps into it, which shows its markup', async () => {
    const view = await focused('See [[Note|alias]]‸ now');
    expect(shown(view)).not.toContain('[[');
    press(view, 'ArrowLeft');
    expect(marked(view)).toBe('See [[Note|alias‸]] now');
    expect(shown(view)).toContain('[[Note|alias]]');
  });

  it('an unfocused editor and a read-only note keep links rendered', () => {
    const view = noteEditor('See [[Note|ali‸as]] now', { ctx: { tree: () => tree } });
    expect(shown(view)).not.toContain('[[');
    const locked = noteEditor('See [[Note|ali‸as]] now', { ctx: { tree: () => tree }, readOnly: true });
    expect(shown(locked)).not.toContain('[[');
  });

  it('a selection over the whole link, and one around it, do not reveal it', () => {
    const created = EditorState.create({ doc: 'a [[Note|x]] b', extensions: [markdownNoteLanguage()] });
    ensureSyntaxTree(created, created.doc.length, 5000);
    const state = created.update({}).state;
    const [el] = collectElements(state, [{ from: 0, to: state.doc.length }]).filter((e) => e.kind === 'wikilink');
    expect(selectionInLink(el, EditorSelection.single(2, 12))).toBe(false);
    expect(selectionInLink(el, EditorSelection.single(0, 14))).toBe(false);
    expect(selectionInLink(el, EditorSelection.single(9, 10))).toBe(true);
    expect(isRevealed(el, EditorSelection.single(10), HIDE_ALL)).toBe(false);
    expect(isRevealed(el, EditorSelection.single(10), { ...HIDE_ALL, linkAtCaret: true })).toBe(true);
  });

  it('while the mouse button is down the link stays rendered; it shows after the button is up', async () => {
    const view = await focused('See [[Note|alias]] now‸');
    vi.useFakeTimers();
    view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.toString().indexOf('lias')), userEvent: 'select.pointer' });
    expect(shown(view)).not.toContain('[[');
    window.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
    expect(shown(view)).not.toContain('[[');
    vi.advanceTimersByTime(LINK_REVEAL_DELAY_MS);
    expect(shown(view)).toContain('[[Note|alias]]');
  });

  it('deleting all of a shown link’s text keeps its markup (the target is being edited)', async () => {
    const view = await focused('a [[Note|x‸]] b');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('a [[Note|]] b');
  });

  it('Mod-click on a link adds no cursor in it', async () => {
    const view = await focused('See [[Note|alias]] now‸');
    const link = view.contentDOM.querySelector('.cm-lp-link');
    expect(link).not.toBeNull();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, metaKey: true });
    link!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(1);
  });
});
