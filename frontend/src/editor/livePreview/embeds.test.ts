import { EditorSelection, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, fakeEmbed, marked, noteEditor, press, testContext, treeOf, typeText } from '../../test/noteEditor';
import { noteExtensions } from '../editorSetup';
import { footnoteIndex } from './footnotes';

afterEach(() => {
  destroyEditors();
  vi.restoreAllMocks();
});

const tree = treeOf('Here.md', 'Note.md', 'pic.png', 'Files/doc.pdf', 'song.mp3');

function editor(text: string, options: Parameters<typeof noteEditor>[1] = {}): EditorView {
  return noteEditor(text, { ...options, ctx: { tree: () => tree, ...options.ctx } });
}

/** What the embeds of a note show: the fake renderer's text, a web image's address, or a link's text. */
function embeds(view: EditorView): string[] {
  return [...view.contentDOM.querySelectorAll('.cm-lp-embed, .cm-lp-embed-link')].map((el) => {
    if (el.classList.contains('cm-lp-embed-link')) return `link:${el.textContent}${el.classList.contains('cm-unresolved') ? ' (unresolved)' : ''}`;
    const img = el.querySelector('img');
    if (img) return `img:${img.getAttribute('src')}`;
    if (el.querySelector('.cm-lp-remote-image')) return `remote:${el.textContent}`;
    return el.textContent ?? '';
  });
}

describe('images and embeds (ROADMAP 10b)', () => {
  it('shows vault files through the app’s embed renderer, with their part, text and size', () => {
    const view = editor('![[pic.png|300]] and ![[Note#Head|alias]]\n\n![[doc.pdf#page=2]] ![a cat|200x100](pic.png) ![[song.mp3]]');
    expect(embeds(view)).toEqual(['pic.png||300x', 'Note.md#Head|alias|', 'Files/doc.pdf#page=2||', 'pic.png|a cat|200x100', 'song.mp3||']);
  });

  it('shows embeds of missing files, of the note itself and of block references as links', () => {
    const view = editor('![[Missing.png]] ![[Here]] ![[#Section]] ![[Note#^block]]', { ctx: { path: () => 'Here.md' } });
    expect(embeds(view)).toEqual(['link:Missing.png (unresolved)', 'link:Here', 'link:Section', 'link:Note > ^block']);
  });

  it('web images load, or wait for a click when remote images are off; other schemes show as typed', () => {
    expect(embeds(editor('![x](https://e.com/i.png)'))).toEqual(['img:https://e.com/i.png']);
    const view = editor('![a chart](https://e.com/i.png)', { config: { remoteImages: false } });
    expect(embeds(view)).toEqual(['remote:a chart']);
    view.contentDOM.querySelector<HTMLElement>('.cm-lp-remote-image')!.click();
    expect(embeds(view)).toEqual(['img:https://e.com/i.png']);
    // `data:` images are part of the note.
    expect(embeds(editor('![d](data:image/png;base64,AAAA)', { config: { remoteImages: false } }))).toEqual(['img:data:image/png;base64,AAAA']);
    const evil = editor('![x](javascript:alert(1))');
    expect(embeds(evil)).toEqual([]);
    expect(evil.contentDOM.textContent).toContain('![x](javascript:alert(1))');
  });

  it('builds nothing from the note’s text as HTML', () => {
    const view = editor('![<img src=x onerror=alert(1)>](https://e.com/"><script>x</script>.png) ![[<b>x</b>.png]]');
    expect(view.contentDOM.querySelector('script, b, img[onerror]')).toBeNull();
  });

  it('an edit elsewhere redraws no embed', () => {
    const view = editor('Title\n\n![[pic.png]]');
    const before = view.contentDOM.querySelector('.cm-lp-embed');
    view.dispatch({ changes: { from: 0, insert: 'My ' } });
    expect(view.contentDOM.querySelector('.cm-lp-embed')).toBe(before);
  });

  it('removes what the renderer mounted when the embed goes', () => {
    const unmount = vi.fn();
    const view = editor('a ![[pic.png]]', { ctx: { renderEmbed: (el, embed) => (fakeEmbed(el, embed), unmount) } });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'a' } });
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it('the cursor steps over an embed, and Backspace after it deletes it whole', () => {
    const view = editor('a ![[pic.png]]‸ b');
    // CodeMirror's own Backspace deletes an atomic range whole.
    press(view, 'Backspace');
    expect(marked(view)).toBe('a ‸ b');
    const before = editor('a ‸![[pic.png]] b');
    press(before, 'Delete');
    expect(marked(before)).toBe('a ‸ b');
  });

  it('a revealed embed shows its source and still shows the file after it', () => {
    const view = editor('x ![[pic.png]] y');
    view.dispatch({ selection: EditorSelection.range(5, 8) });
    expect(view.contentDOM.textContent).toContain('![[pic.png]]');
    expect(embeds(view)).toEqual(['pic.png||']);
  });
});

describe('footnotes (ROADMAP 10b)', () => {
  it('numbers footnotes by their first reference, as the markdown-it plugin does', () => {
    const view = editor('B[^b] then A[^a], ^[inline] and B again[^b]; none[^x].\n\n[^a]: Alpha.\n[^b]: Beta\n    continued.');
    expect([...view.contentDOM.querySelectorAll('.cm-lp-footnote')].map((el) => el.textContent)).toEqual(['[1]', '[2]', '[3]', '[1]', '[^x]']);
    expect([...view.contentDOM.querySelectorAll('.cm-lp-footnote-label')].map((el) => el.textContent)).toEqual(['2.', '1.']);
    expect(view.contentDOM.querySelector('.cm-lp-footnote.is-missing')?.textContent).toBe('[^x]');
  });

  it('reads definitions and references outside code and frontmatter only', () => {
    const doc = '---\nx: "[^1]"\n---\nA[^1] `[^2]`\n\n```\n[^2]: in code\n```\n[^1]: One\n[^2]: Two';
    const index = footnoteIndex(editor(doc).state.doc);
    expect(index.number('1')).toBe(1);
    expect(index.number('2')).toBeNull();
    expect(index.definition('1')?.map((p) => p.text)).toEqual(['One']);
  });

  it('a tap on a number shows the footnote’s text; moving the cursor or Escape hides it', () => {
    const view = editor('Text[^1] more‸\n\n[^1]: The **note**, see [[Note]].');
    view.contentDOM.querySelector<HTMLElement>('.cm-lp-footnote')!.click();
    const tooltip = view.dom.querySelector('.cm-lp-footnote-tooltip');
    expect(tooltip?.textContent).toBe('The note, see Note.');
    expect(tooltip?.querySelector('strong')?.textContent).toBe('note');
    expect(press(view, 'Escape')).toBe(true);
    expect(view.dom.querySelector('.cm-lp-footnote-tooltip')).toBeNull();
    view.contentDOM.querySelector<HTMLElement>('.cm-lp-footnote')!.click();
    typeText(view, 'x');
    expect(view.dom.querySelector('.cm-lp-footnote-tooltip')).toBeNull();
  });

  it('a link in the footnote’s text follows', () => {
    const openLink = vi.fn();
    const view = editor('Text[^1]\n\n[^1]: See [[Note]].', { ctx: { openLink } });
    view.contentDOM.querySelector<HTMLElement>('.cm-lp-footnote')!.click();
    view.dom.querySelector<HTMLElement>('.cm-lp-footnote-tooltip .cm-lp-link')!.click();
    expect(openLink).toHaveBeenCalledWith('Note', null);
  });

  it('an inline footnote shows its own text', () => {
    const view = editor('Text^[an *inline* note].');
    view.contentDOM.querySelector<HTMLElement>('.cm-lp-footnote')!.click();
    expect(view.dom.querySelector('.cm-lp-footnote-tooltip')?.textContent).toBe('an inline note');
  });

  it('a footnote without text says so', () => {
    const view = editor('Text[^nope]');
    view.contentDOM.querySelector<HTMLElement>('.cm-lp-footnote')!.click();
    expect(view.dom.querySelector('.cm-lp-footnote-tooltip.is-missing')).not.toBeNull();
  });
});

describe('comments and code fences (ROADMAP 10b)', () => {
  it('Backspace after a hidden inline comment deletes the letter before it, never the comment', () => {
    const view = editor('ab%%note%%‸ c');
    expect(view.contentDOM.textContent).toBe('ab c');
    expect(press(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('a%%note%% c');
  });

  it('a code block’s fences hide while no selection touches it; its language shows', () => {
    const view = editor('Intro‸\n\n```js\nlet a;\n```');
    expect(view.contentDOM.textContent).toBe('Introjslet a;');
    expect(view.contentDOM.querySelectorAll('.cm-lp-fence-line')).toHaveLength(2);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length - 5) });
    expect(view.contentDOM.textContent).toBe('Intro```jslet a;```');
    // Locked: hidden whatever the selection.
    const locked = editor('```js\nlet a;\n```‸', { mode: 'locked' });
    expect(locked.contentDOM.textContent).toBe('jslet a;');
    expect(marked(locked)).toBe('```js\nlet a;\n```‸');
  });
});

describe('images in table cells (ROADMAP 10b)', () => {
  it('a cell shows its images; other embeds show as typed', () => {
    // In a table, a wikilink's pipe is escaped.
    const view = editor('| a | b |\n|---|---|\n| ![[pic.png\\|40]] | ![[Note]] |');
    const cells = [...view.contentDOM.querySelectorAll('td')];
    expect(cells[0].querySelector('.test-embed')?.textContent).toBe('pic.png||40x');
    expect(cells[1].querySelector('.cm-lp-embed-source')?.textContent).toBe('![[Note]]');
  });
});

describe('switching modes (ROADMAP 10b)', () => {
  it('locking a note makes its tables read-only, and unlocking editable again', () => {
    const view = editor('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(view.contentDOM.querySelector('.cm-lp-table')?.classList.contains('is-editable')).toBe(true);
    const reconfigure = (locked: boolean) =>
      view.dispatch({ effects: StateEffect.reconfigure.of(noteExtensions(testContext({ tree: () => tree }), { onLocalChange: () => {}, onBlur: () => {}, readOnly: false, spellcheck: false, autocorrect: false, livePreview: { visibility: 'hide-all', locked, checkboxes: true } })) });
    reconfigure(true);
    expect(view.contentDOM.querySelector('.cm-lp-table')?.classList.contains('is-editable')).toBe(false);
    reconfigure(false);
    expect(view.contentDOM.querySelector('.cm-lp-table')?.classList.contains('is-editable')).toBe(true);
  });
});
