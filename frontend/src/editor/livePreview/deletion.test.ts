// Regressions found reviewing Live Preview (ROADMAP 10): crashes on links over a line break, and
// deletions that joined a line to a hidden block, a table or a hidden code fence, split an embed,
// or deleted hidden markers.
import { undo } from '@codemirror/commands';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyEditors, marked, noteEditor, parsed, press, typeText } from '../../test/noteEditor';
import { editingProperties } from './blocks';

afterEach(() => destroyEditors());

const ctrl = { ctrlKey: true };

describe('links over a line break (review)', () => {
  it('a link whose destination or title is on the next line shows as typed instead of crashing', () => {
    expect(noteEditor('[a](\nhttp://x)').contentDOM.textContent).toBe('[a](http://x)');
    expect(noteEditor('[a](http://x\n"title")').contentDOM.textContent).toBe('[a](http://x"title")');
    // An edit that makes one (an image losing its `!`) and typing one.
    const view = noteEditor('!‸[a](\nx.png)');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('[a](\nx.png)');
    const typed = noteEditor('x\n\n> [a](‸');
    typeText(typed, '\nhttp://x)');
    parsed(typed);
    expect(typed.state.doc.toString()).toBe('x\n\n> [a](\nhttp://x)');
  });
});

describe('deleting next to hidden blocks (review)', () => {
  it('an empty line next to the properties or a hidden comment goes, the caret staying outside the block', () => {
    let view = noteEditor('---\na: 1\n---\n‸\nBody');
    press(view, 'Backspace');
    typeText(view, 'x');
    expect(editingProperties(view.state)).toBe(false);
    expect(view.state.doc.toString()).toBe('---\na: 1\n---\nxBody');
    view = noteEditor('Text\n%%\nhidden\n%%\n‸');
    press(view, 'Backspace');
    typeText(view, 'x');
    expect(view.state.doc.toString()).toBe('Textx\n%%\nhidden\n%%');
    view = noteEditor('Text\n‸\n%%\nhidden\n%%\nAfter');
    press(view, 'Delete');
    typeText(view, 'x');
    expect(view.state.doc.toString()).toBe('Textx\n%%\nhidden\n%%\nAfter');
  });

  it('Backspace or Delete over hidden markup never joins a line to a hidden block or a table', () => {
    let view = noteEditor('Text\n%%\nhidden\n%%\n**‸b**');
    press(view, 'Backspace');
    expect(marked(view)).toBe('Text‸\n%%\nhidden\n%%\n**b**');
    view = noteEditor('---\na: 1\n---\n**‸b**');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('---\na: 1\n---\n**b**');
    view = noteEditor('Text **b‸**\n%%\nhidden\n%%\nAfter');
    press(view, 'Delete');
    expect(marked(view)).toBe('Text **b**\n%%\nhidden\n%%\n‸After');
    const table = '| a | b |\n| - | - |\n| c | d |';
    view = noteEditor(`# **Title‸**\n${table}\n\nEnd`);
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe(`# **Title**\n${table}\n\nEnd`);
  });

  it('a line never joins a hidden code fence: the caret goes into the code block, whose fences show', () => {
    let view = noteEditor('Intro‸\n```js\ncode\n```\n\n# Later');
    press(view, 'Delete');
    expect(marked(view)).toBe('Intro\n```js\n‸code\n```\n\n# Later');
    expect(view.contentDOM.textContent).toContain('```js');
    view = noteEditor('```js\ncode\n```\n‸After\n\n# Later');
    press(view, 'Backspace');
    expect(marked(view)).toBe('```js\ncode‸\n```\nAfter\n\n# Later');
    // An empty line next to a fence goes as usual.
    view = noteEditor('Intro\n‸\n```js\ncode\n```');
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe('Intro\n```js\ncode\n```');
  });
});

describe('deleting next to atoms and hidden markers (review)', () => {
  it('Backspace or Delete over hidden markup deletes an embed or footnote next to it whole', () => {
    let view = noteEditor('Some **text[^1]**‸\n\n[^1]: note');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('Some **text**\n\n[^1]: note');
    view = noteEditor('Some **text‸**[^1] more\n\n[^1]: note');
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe('Some **text** more\n\n[^1]: note');
  });

  it('a word deletion stops at hidden markup instead of deleting markers', () => {
    const cases: Array<[string, 'Backspace' | 'Delete', string]> = [
      ['**a** ‸b', 'Backspace', '**a**‸b'],
      // The caret stays inside the bold it was in.
      ['**a** **‸b**', 'Backspace', '**a****‸b**'],
      ['**a‸** **b**', 'Delete', '**a‸****b**'],
      ['a‸ **b** c', 'Delete', 'a‸**b** c'],
    ];
    for (const [text, key, expected] of cases) {
      const view = noteEditor(text);
      press(view, key, ctrl);
      expect(marked(view), text).toBe(expected);
    }
  });

  it('Backspace at the start of the note does nothing, and undo gives the caret back where it was', () => {
    let view = noteEditor('**‸b** c');
    press(view, 'Backspace');
    expect(marked(view)).toBe('**‸b** c');
    view = noteEditor('a\n**‸b**');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('a**b**');
    undo(view);
    expect(marked(view)).toBe('a\n**‸b**');
  });
});
