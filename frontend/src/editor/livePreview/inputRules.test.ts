import { completionStatus } from '@codemirror/autocomplete';
import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, marked, noteEditor, parsed, press, typeText } from '../../test/noteEditor';
import { collectElements } from './model';
import { tableBlocks } from './table';

afterEach(() => {
  destroyEditors();
  vi.restoreAllMocks();
});

/** The kinds of Live Preview elements on the document's lines. */
function kinds(view: ReturnType<typeof noteEditor>): string[] {
  parsed(view);
  return collectElements(view.state, [{ from: 0, to: view.state.doc.length }]).map((e) => e.kind);
}

/** The pieces of markup Live Preview hides on the first line. */
function hiddenOnFirstLine(view: ReturnType<typeof noteEditor>): string[] {
  parsed(view);
  const line = view.state.doc.line(1);
  return collectElements(view.state, [{ from: line.from, to: line.to }]).flatMap((e) => e.pieces.map((p) => view.state.sliceDoc(p.from, p.to)));
}

describe('typing shortcuts write ordinary Markdown (ROADMAP 10a)', () => {
  it('`# ` to `###### ` make headings', () => {
    for (let level = 1; level <= 6; level++) {
      const view = noteEditor('‸');
      typeText(view, '#'.repeat(level) + ' Title');
      expect(view.state.doc.toString()).toBe('#'.repeat(level) + ' Title');
      expect(kinds(view)).toEqual(['heading']);
      expect(hiddenOnFirstLine(view)).toEqual(['#'.repeat(level) + ' ']);
    }
    // Seven are not a heading.
    const view = noteEditor('‸');
    typeText(view, '####### x');
    expect(kinds(view)).toEqual([]);
  });

  it('`- ` and `* ` make bullets, `1. ` a numbered item, `> ` a quote', () => {
    for (const [typed, kind] of [
      ['- item', 'list'],
      ['* item', 'list'],
      ['1. item', 'list'],
      ['> quoted', 'quote'],
    ]) {
      const view = noteEditor('‸');
      typeText(view, typed);
      expect(view.state.doc.toString()).toBe(typed);
      expect(kinds(view)).toEqual([kind]);
    }
  });

  it('`[] `, `[ ] ` and `[x] ` make a task', () => {
    for (const [typed, task] of [
      ['[] ', '- [ ] '],
      ['[ ] ', '- [ ] '],
      ['[x] ', '- [x] '],
    ]) {
      const view = noteEditor('‸');
      typeText(view, typed);
      expect(marked(view)).toBe(task + '‸');
      typeText(view, 'Buy milk');
      expect(view.state.doc.toString()).toBe(task + 'Buy milk');
      expect(kinds(view)).toEqual(['list']);
    }
  });

  it('a task box typed after a list marker, in a quote, or in front of text completes the task', () => {
    const cases: Array<[string, string, string]> = [
      ['- ‸', '[] ', '- [ ] ‸'],
      ['1. ‸', '[] ', '1. [ ] ‸'],
      ['> ‸', '[] ', '> - [ ] ‸'],
      ['  ‸', '[] ', '  - [ ] ‸'],
      ['‸Buy milk', '[] ', '- [ ] ‸Buy milk'],
    ];
    for (const [start, typed, result] of cases) {
      const view = noteEditor(start);
      typeText(view, typed);
      expect(marked(view)).toBe(result);
    }
  });

  it('one undo gives back what was typed, and redo the task again', () => {
    const view = noteEditor('‸');
    typeText(view, '[] ');
    expect(view.state.doc.toString()).toBe('- [ ] ');
    undo(view);
    expect(marked(view)).toBe('[] ‸');
    redo(view);
    expect(view.state.doc.toString()).toBe('- [ ] ');
  });

  it('text typed after a task shortcut is its own undo step', () => {
    const view = noteEditor('‸');
    typeText(view, '[] milk');
    undo(view);
    expect(view.state.doc.toString()).toBe('- [ ] ');
    undo(view);
    expect(view.state.doc.toString()).toBe('[] ');
  });

  it('`[] ` inside text, a code block or the frontmatter is left as typed', () => {
    let view = noteEditor('a ‸');
    typeText(view, '[] ');
    expect(view.state.doc.toString()).toBe('a [] ');
    view = noteEditor('```\n‸\n```');
    typeText(view, '[] ');
    expect(view.state.doc.toString()).toBe('```\n[] \n```');
    view = noteEditor('---\ntags: x\n‸\n---\n');
    typeText(view, '[] ');
    expect(view.state.doc.toString()).toBe('---\ntags: x\n[] \n---\n');
  });

  it('`[[` opens the note list', async () => {
    const view = noteEditor('‸');
    view.focus();
    typeText(view, '[[');
    expect(view.state.doc.toString()).toBe('[[]]');
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'));
  });
});

describe('Enter shortcuts (ROADMAP 10a)', () => {
  const enter = (view: ReturnType<typeof noteEditor>) => press(view, 'Enter');

  it('`---` then Enter under a paragraph makes a rule, not a heading', () => {
    const view = noteEditor('Para\n‸');
    typeText(view, '---');
    expect(enter(view)).toBe(true);
    expect(marked(view)).toBe('Para\n\n---\n‸');
    expect(kinds(view)).toEqual(['rule']);
    // One undo: the `---` as typed.
    undo(view);
    expect(marked(view)).toBe('Para\n---‸');
  });

  it('`---` then Enter elsewhere is an ordinary Enter: already a rule, or properties on the first line', () => {
    let view = noteEditor('Para\n\n---‸');
    enter(view);
    expect(marked(view)).toBe('Para\n\n---\n‸');
    view = noteEditor('---‸');
    enter(view);
    expect(marked(view)).toBe('---\n‸');
  });

  it('a code fence then Enter closes the block, with the cursor inside', () => {
    let view = noteEditor('‸');
    typeText(view, '```');
    expect(enter(view)).toBe(true);
    expect(marked(view)).toBe('```\n‸\n```');
    view = noteEditor('text\n\n```js‸\nmore');
    expect(enter(view)).toBe(true);
    expect(marked(view)).toBe('text\n\n```js\n‸\n```\nmore');
    undo(view);
    expect(marked(view)).toBe('text\n\n```js‸\nmore');
    view = noteEditor('~~~‸');
    enter(view);
    expect(marked(view)).toBe('~~~\n‸\n~~~');
  });

  it('a fence in a quote or a list item closes with the same prefix', () => {
    let view = noteEditor('> ```‸');
    enter(view);
    expect(marked(view)).toBe('> ```\n> ‸\n> ```');
    view = noteEditor('- ```‸');
    enter(view);
    expect(marked(view)).toBe('- ```\n  ‸\n  ```');
  });

  it('Enter on the opening fence of a closed block is an ordinary Enter', () => {
    const view = noteEditor('```js‸\ncode\n```');
    enter(view);
    expect(marked(view)).toBe('```js\n‸\ncode\n```');
    // A fence that a block nested in it closes is still its own.
    const nested = noteEditor('````md‸\n```\nx\n```\n````');
    enter(nested);
    expect(nested.state.doc.toString()).toBe('````md\n\n```\nx\n```\n````');
  });

  it('a fence typed above another block gets its own closing fence', () => {
    const view = noteEditor('‸\n\n```py\nb\n```');
    typeText(view, '```');
    expect(enter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('```\n\n```\n\n```py\nb\n```');
  });

  it('a `|` header line then Enter makes a table and opens its first empty cell', () => {
    const view = noteEditor('Intro\n‸');
    typeText(view, '| Name | Age |');
    expect(enter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Intro\n\n| Name | Age |\n| ---- | --- |\n|      |     |');
    parsed(view);
    expect(tableBlocks(view.state)).toHaveLength(1);
    // The empty row's first cell is open for typing.
    const cell = view.dom.querySelector('.cm-lp-cell.is-editing');
    expect(cell?.closest('tr')?.rowIndex).toBe(1);
    expect(cell?.closest('tr')?.cells[0]).toBe(cell);
    // One undo: the header line as typed.
    undo(view);
    expect(view.state.doc.toString()).toBe('Intro\n| Name | Age |');
  });

  it('undoing the table from its open cell gives the focus back to the note', async () => {
    const view = noteEditor('‸');
    view.focus();
    typeText(view, '| a | b |');
    enter(view);
    const cell = view.dom.querySelector('.cm-lp-cell.is-editing .cm-content') as HTMLElement;
    expect(document.activeElement).toBe(cell);
    expect(press(EditorView.findFromDOM(cell)!, 'z', { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe('| a | b |');
    await Promise.resolve();
    expect(view.hasFocus).toBe(true);
  });

  it('a compact header line is padded into a table', () => {
    const view = noteEditor('|a|b‸');
    enter(view);
    expect(view.state.doc.toString()).toBe('| a   | b   |\n| --- | --- |\n|     |     |');
  });

  it('lines that are not a header line are left to an ordinary Enter', () => {
    for (const text of ['| a‸', 'a | b‸', '```\n| a | b |‸\n```', '> | a | b |‸', '- | a | b |‸']) {
      const view = noteEditor(text);
      enter(view);
      expect(view.state.doc.toString()).not.toContain('---');
      expect(view.state.doc.lines).toBe(text.split('\n').length + 1);
    }
  });

  it('typing shortcuts belong to Live Preview: source mode and locked notes keep what is typed', () => {
    let view = noteEditor('‸', { mode: 'source' });
    typeText(view, '[] ');
    expect(view.state.doc.toString()).toBe('[] ');
    view = noteEditor('| a | b |‸', { mode: 'source' });
    press(view, 'Enter');
    expect(view.state.doc.toString()).not.toContain('---');
    view = noteEditor('```‸', { mode: 'locked' });
    expect(press(view, 'Enter')).toBe(false);
  });
});
