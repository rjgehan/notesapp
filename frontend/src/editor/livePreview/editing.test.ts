import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVaultTree } from '../../api/vaultTree';
import { DEFAULT_SETTINGS } from '../../features/settings';
import type { NoteContext } from '../context';
import { noteExtensions } from '../editorSetup';
import type { LivePreviewConfig } from './decorations';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.restoreAllMocks();
});

const tree = buildVaultTree({
  eventId: 'b.1',
  folders: [],
  files: [{ path: 'Note.md', name: 'Note.md', basename: 'Note', extension: 'md', kind: 'note', size: 1, mtime: '2026-10-16T10:00:00.000Z', version: 'v', aliases: [] }],
});

function context(overrides: Partial<NoteContext> = {}): NoteContext {
  return {
    path: () => 'Here.md',
    tree: () => tree,
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
    renderEmbed: () => () => {},
    renderProperties: () => () => {},
    ...overrides,
  };
}

interface Options {
  config?: Partial<LivePreviewConfig>;
  ctx?: Partial<NoteContext>;
  readOnly?: boolean;
}

/** A note editor in Live Preview, with `‸` marking the cursor. */
function editor(marked: string, { config, ctx, readOnly = false }: Options = {}): EditorView {
  const cursor = marked.indexOf('‸');
  const doc = cursor >= 0 ? marked.slice(0, cursor) + marked.slice(cursor + 1) : marked;
  const livePreview: LivePreviewConfig = { visibility: 'hide-all', locked: false, checkboxes: !readOnly, ...config };
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(Math.max(0, cursor)),
    extensions: noteExtensions(context(ctx), { onLocalChange: () => {}, onBlur: () => {}, readOnly, spellcheck: false, autocorrect: false, livePreview }),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

/** The document with `‸` at the cursor. */
function text(view: EditorView): string {
  const doc = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return doc.slice(0, head) + '‸' + doc.slice(head);
}

function press(view: EditorView, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}): boolean {
  const handled = runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...mods }), 'editor');
  // Unhandled keys do nothing in these tests (no browser default to fall back on).
  return handled;
}

function type(view: EditorView, s: string): void {
  view.dispatch(view.state.replaceSelection(s), { userEvent: 'input.type' });
}

function click(view: EditorView, pos: number): void {
  view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select.pointer' });
}

describe('hidden markup is atomic (ROADMAP 10a)', () => {
  it('arrow keys step over hidden markers, stopping once at each edge', () => {
    const view = editor('a **bo‸ld** b');
    press(view, 'ArrowRight');
    press(view, 'ArrowRight');
    expect(text(view)).toBe('a **bold‸** b');
    press(view, 'ArrowRight');
    expect(text(view)).toBe('a **bold**‸ b');
    press(view, 'ArrowLeft');
    expect(text(view)).toBe('a **bold‸** b');
  });

  it('ArrowLeft where a line’s text starts goes to the line before, over the hidden heading marks', () => {
    const view = editor('para\n# ‸Title');
    press(view, 'ArrowLeft');
    expect(text(view)).toBe('para‸\n# Title');
    press(view, 'ArrowRight');
    expect(text(view)).toBe('para\n# ‸Title');
  });

  it('the cursor never rests in front of hidden block markup', () => {
    const view = editor('x\n- item\n> quote\n  - [ ] task');
    for (const [pos, settled] of [
      [2, 4],
      [3, 4],
      [9, 11],
      [17, 25],
      [20, 25],
    ]) {
      view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select' });
      expect(view.state.selection.main.head).toBe(settled);
    }
  });

  it('a click at the end of bold text lands inside it; before bold text, outside it', () => {
    const view = editor('x **bold** y');
    click(view, 10);
    expect(text(view)).toBe('x **bold‸** y');
    click(view, 4);
    expect(text(view)).toBe('x ‸**bold** y');
  });

  it('a click at the end of a link lands after it', () => {
    const view = editor('[[Note]] and [t](https://x.y) z');
    click(view, 6);
    expect(text(view)).toBe('[[Note]]‸ and [t](https://x.y) z');
    click(view, 15);
    expect(text(view)).toBe('[[Note]] and [t](https://x.y)‸ z');
  });

  it('a click between a link and bold text lands outside both', () => {
    const view = editor('[[a]]**b**');
    click(view, 3);
    expect(text(view)).toBe('[[a]]‸**b**');
  });

  it('does not move the cursor in reveal-at-cursor mode, where the markup shows', () => {
    const view = editor('x **bold** y', { config: { visibility: 'reveal-at-cursor' } });
    click(view, 10);
    expect(text(view)).toBe('x **bold**‸ y');
  });
});

describe('typing at the edges of formatting', () => {
  it('continues bold text typed at its end', () => {
    const view = editor('x **bold** y');
    click(view, 10);
    type(view, 'er');
    expect(view.state.doc.toString()).toBe('x **bolder** y');
  });

  it('continues italic text after Backspace at its end', () => {
    const view = editor('an *idea*‸ here');
    press(view, 'Backspace');
    expect(text(view)).toBe('an *ide‸* here');
    type(view, 'al');
    expect(view.state.doc.toString()).toBe('an *ideal* here');
  });

  it('does not extend a link typed after', () => {
    const view = editor('see [[Note]] now');
    click(view, 10);
    type(view, '!');
    expect(view.state.doc.toString()).toBe('see [[Note]]! now');
  });

  it('typed Markdown closes as typed: text after a typed closing marker is plain', () => {
    const view = editor('‸');
    for (const ch of '**b**') type(view, ch);
    type(view, ' c');
    expect(view.state.doc.toString()).toBe('**b** c');
  });
});

describe('Backspace and Delete next to hidden markup', () => {
  it('Backspace after bold text deletes its last letter, not a marker', () => {
    const view = editor('**bold**‸ x');
    press(view, 'Backspace');
    expect(text(view)).toBe('**bol‸** x');
  });

  it('Backspace at the start of bold text deletes the letter before it', () => {
    const view = editor('x **‸bold**');
    press(view, 'Backspace');
    expect(text(view)).toBe('x**‸bold**');
  });

  it('Delete before bold text deletes its first letter', () => {
    const view = editor('x ‸**bold**');
    press(view, 'Delete');
    expect(text(view)).toBe('x ‸**old**');
  });

  it('Delete at the end of bold text deletes the letter after it', () => {
    const view = editor('**bold‸** x');
    press(view, 'Delete');
    expect(text(view)).toBe('**bold‸**x');
  });

  it('Backspace after a link deletes its last letter and stays after it', () => {
    const view = editor('[[Note]]‸ x');
    press(view, 'Backspace');
    expect(text(view)).toBe('[[Not]]‸ x');
  });

  it('deleting the last letter of formatting removes its markers too', () => {
    const view = editor('a **b**‸ c');
    press(view, 'Backspace');
    expect(text(view)).toBe('a ‸ c');
  });

  it('deleting all the text of a link removes the link', () => {
    const view = editor('a [t](https://x.y)‸ c');
    press(view, 'Backspace');
    expect(text(view)).toBe('a ‸ c');
  });

  it('a selection deleting all of the text of bold removes the bold', () => {
    const view = editor('a **bold** c');
    view.dispatch({ selection: EditorSelection.range(4, 8) });
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('a  c');
  });

  it('deleting nested formatting removes every empty level', () => {
    const view = editor('a ***b***‸ c');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('a  c');
  });

  it('Ctrl-Backspace after bold text deletes its last word', () => {
    const view = editor('**one two**‸ x');
    press(view, 'Backspace', { ctrlKey: true });
    expect(text(view)).toBe('**one ‸** x');
  });

  it('Backspace where a heading’s text starts removes the heading marks; the next one joins the line', () => {
    const view = editor('para\n# ‸Title');
    press(view, 'Backspace');
    expect(text(view)).toBe('para\n‸Title');
    press(view, 'Backspace');
    expect(text(view)).toBe('para‸Title');
  });

  it('Backspace in an empty list item ends the list (the Markdown keymap still runs)', () => {
    const view = editor('- a\n- ‸');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).not.toContain('- a\n- ');
  });

  it('Delete at the end of a line joins the next line’s text without its hidden heading marks', () => {
    const view = editor('para‸\n## Title');
    press(view, 'Delete');
    expect(text(view)).toBe('para‸Title');
  });

  it('Delete on an empty line before a heading removes the line and keeps the heading', () => {
    const view = editor('para\n‸\n## Title');
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe('para\n## Title');
  });

  it('Backspace at the start of a line before bold text joins the lines', () => {
    const view = editor('a\n**‸b**');
    press(view, 'Backspace');
    expect(text(view)).toBe('a‸**b**');
  });

  it('acts as plain Backspace in reveal-at-cursor mode, where the markers show', async () => {
    const view = editor('**bold**‸ x', { config: { visibility: 'reveal-at-cursor' } });
    view.focus();
    // CodeMirror reports a focus change in an update shortly after the focus event.
    await vi.waitFor(() => expect(view.contentDOM.textContent).toContain('**'));
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('**bold* x');
  });

  it('changes nothing in a read-only note', () => {
    const view = editor('**bold**‸ x', { readOnly: true });
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('**bold** x');
  });
});

describe('Enter at the start of a heading', () => {
  it('opens a line above it and keeps the heading', () => {
    const view = editor('# ‸Title');
    press(view, 'Enter');
    expect(text(view)).toBe('\n# ‸Title');
  });

  it('elsewhere in a heading, Enter splits the line as usual', () => {
    const view = editor('# Ti‸tle');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('# Ti\ntle');
  });
});

describe('task checkboxes', () => {
  it('toggle the one character between their brackets', () => {
    const view = editor('- [ ] a\n- [X] b\n> 1. [ ] c');
    const boxes = () => [...view.contentDOM.querySelectorAll<HTMLInputElement>('input.cm-lp-checkbox')];
    expect(boxes().map((b) => b.checked)).toEqual([false, true, false]);
    boxes()[0].click();
    expect(view.state.doc.toString()).toBe('- [x] a\n- [X] b\n> 1. [ ] c');
    boxes()[1].click();
    expect(view.state.doc.toString()).toBe('- [x] a\n- [ ] b\n> 1. [ ] c');
    boxes()[2].click();
    expect(view.state.doc.toString()).toBe('- [x] a\n- [ ] b\n> 1. [x] c');
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
  });

  it('toggle in a locked note, as in the reading view', () => {
    const view = editor('- [ ] a', { config: { locked: true } });
    view.contentDOM.querySelector<HTMLInputElement>('input.cm-lp-checkbox')!.click();
    expect(view.state.doc.toString()).toBe('- [x] a');
  });

  it('are disabled while the note cannot be written', () => {
    const view = editor('- [ ] a', { readOnly: true });
    const box = view.contentDOM.querySelector<HTMLInputElement>('input.cm-lp-checkbox')!;
    expect(box.disabled).toBe(true);
    box.click();
    expect(view.state.doc.toString()).toBe('- [ ] a');
  });
});

describe('rendered links', () => {
  function linkEl(view: EditorView, label: string): HTMLElement {
    const el = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-lp-link')].find((e) => e.textContent === label);
    if (!el) throw new Error(`no link "${label}"`);
    return el;
  }

  function pointer(view: EditorView, type: 'mouse' | 'touch'): void {
    const ev = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(ev, 'pointerType', { value: type });
    view.contentDOM.dispatchEvent(ev);
  }

  it('follow on a click while the note is locked', () => {
    const openLink = vi.fn();
    const view = editor('see [[Note#Plan|the plan]] and [[Other]]', { config: { locked: true }, ctx: { openLink } });
    pointer(view, 'mouse');
    linkEl(view, 'the plan').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(openLink).toHaveBeenCalledWith('Note', 'Plan');
    linkEl(view, 'Other').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(openLink).toHaveBeenLastCalledWith('Other', null);
  });

  it('place the caret on a plain click while editing, and follow on Mod-click', () => {
    const openLink = vi.fn();
    const view = editor('see [[Note]]', { ctx: { openLink } });
    pointer(view, 'mouse');
    linkEl(view, 'Note').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(openLink).not.toHaveBeenCalled();
    linkEl(view, 'Note').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    expect(openLink).toHaveBeenCalledWith('Note', null);
  });

  it('follow on a tap while editing', () => {
    const openLink = vi.fn();
    const view = editor('see [[Note#Head]]', { ctx: { openLink } });
    pointer(view, 'touch');
    linkEl(view, 'Note > Head').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(openLink).toHaveBeenCalledWith('Note', 'Head');
  });

  it('open web links in a new tab without access to the app, and never script URLs', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const view = editor('[site](https://example.com/x) [bad](javascript:alert(1)) <https://a.b>', { config: { locked: true } });
    linkEl(view, 'site').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
    linkEl(view, 'bad').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(open).toHaveBeenCalledTimes(1);
    linkEl(view, 'https://a.b').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(open).toHaveBeenLastCalledWith('https://a.b', '_blank', 'noopener,noreferrer');
  });

  it('dim unresolved links, as in v1', () => {
    const view = editor('[[Note]] [[Missing]]');
    expect(linkEl(view, 'Missing').closest('.cm-unresolved')).not.toBeNull();
    expect(linkEl(view, 'Note').closest('.cm-unresolved')).toBeNull();
  });

  it('open tag search on a click in a locked note', () => {
    const openTag = vi.fn();
    const view = editor('a #project/alpha b', { config: { locked: true }, ctx: { openTag } });
    view.contentDOM.querySelector<HTMLElement>('.cm-hashtag')!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(openTag).toHaveBeenCalledWith('project/alpha');
  });
});

describe('the rendered editor', () => {
  it('shows bullets, rules and heading text without their markup, and keeps the document', () => {
    const doc = '# Title\n\n- one\n\n---\n\n**b**';
    const view = editor(doc);
    expect(view.contentDOM.querySelectorAll('.cm-lp-bullet')).toHaveLength(1);
    expect(view.contentDOM.querySelectorAll('.cm-lp-rule')).toHaveLength(1);
    expect(view.contentDOM.textContent).not.toContain('#');
    expect(view.contentDOM.textContent).not.toContain('**');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('a locked note cannot be edited by keys or commands', () => {
    const view = editor('**b**‸', { config: { locked: true } });
    expect(view.state.readOnly).toBe(true);
    press(view, 'Backspace');
    press(view, 'b', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe('**b**');
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
  });
});
