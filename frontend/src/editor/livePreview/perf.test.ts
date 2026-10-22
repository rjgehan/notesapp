// Live Preview on a long note (ROADMAP 10c): a 10,000-line note stays responsive. Decorations are
// computed for the visible ranges only; the state fields that find tables, comment blocks and
// footnotes keep what an edit did not touch (mapped through it) instead of reading the note again.
// Timings are compared with styled source mode on the same note (the editor's own cost: its
// incremental parse), with room for a busy test machine; work that grows with the note shows as
// a multiple of it. Call counts check that a keystroke reads none of the tables, comment blocks
// or footnotes again.
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, noteEditor, parsed, treeOf } from '../../test/noteEditor';

afterEach(() => destroyEditors());

/** A note of `lines` lines of everything Live Preview renders. */
export function longNote(lines = 10_000): string {
  const out = ['---', 'tags: [long]', 'title: Long', '---'];
  for (let i = 0; out.length < lines; i++) {
    switch (i % 12) {
      case 0:
        out.push(`## Section ${i}`, '');
        break;
      case 1:
        out.push(`Paragraph ${i} with **bold**, *italic*, ==mark==, \`code\`, [[Note]], [a link](https://e.com) and a footnote[^${i}].`, '');
        break;
      case 2:
        out.push(`- item ${i}`, `  - nested ${i}`, `- [ ] task ${i}`, `- [x] done ${i}`, '');
        break;
      case 3:
        out.push('| a | b |', '|---|---|', `| ${i} | **${i}** |`, '');
        break;
      case 4:
        out.push('```js', `const x${i} = ${i};`, '```', '');
        break;
      case 5:
        out.push(`> quote ${i} with %%a comment%%`, '');
        break;
      case 6:
        out.push('%%', `hidden ${i}`, '%%', '');
        break;
      case 7:
        out.push(`![[pic.png|200]] and ![img](https://e.com/${i}.png)`, '');
        break;
      case 8:
        out.push(`[^${i - 7}]: The footnote of paragraph ${i - 7}.`, '');
        break;
      default:
        out.push(`Plain line ${i} of text that wraps a little, as prose does in a note.`, '');
    }
  }
  return out.slice(0, lines).join('\n');
}

const ctx = { tree: () => treeOf('Here.md', 'Note.md', 'pic.png') };

/** Keystrokes at the end of line `line`, the parse caught up between them (as it is while you type); their median time. */
function keystrokes(view: EditorView, line: number, count = 15): number {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line).to) });
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({});
    const head = view.state.selection.main.head;
    const started = performance.now();
    view.dispatch({ changes: { from: head, insert: 'a' }, selection: EditorSelection.cursor(head + 1), userEvent: 'input.type' });
    times.push(performance.now() - started);
  }
  return times.sort((a, b) => a - b)[count >> 1];
}

describe('Live Preview on a 10,000-line note (ROADMAP 10c)', () => {
  it('a keystroke costs about what styled source mode does, at the start, in the middle and at the end', { timeout: 120_000 }, () => {
    const text = longNote();
    expect(text.split('\n')).toHaveLength(10_000);
    const lines = [6, 5_000, 9_990];
    const median = (mode: 'source' | 'live') => {
      const view = noteEditor(text, { mode, ctx });
      const times = lines.map((line) => keystrokes(view, line));
      destroyEditors();
      return times;
    };
    const source = median('source');
    const live = median('live');
    const report = lines.map((line, i) => `line ${line}: source ${source[i].toFixed(2)} ms, Live Preview ${live[i].toFixed(2)} ms`).join('; ');
    lines.forEach((_, i) => expect(live[i], report).toBeLessThan(3 * source[i] + 4));
  });

  it('a keystroke reads none of the note’s tables, comment blocks or footnotes again', { timeout: 120_000 }, () => {
    const view = noteEditor(longNote(), { ctx });
    parsed(view);
    // A footnote shows, so the footnotes have been read once.
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(7).to) });
    const slices = vi.spyOn(EditorState.prototype, 'sliceDoc');
    const lines = vi.spyOn(Text.prototype, 'iterLines');
    // Lines of prose (the first letter on a blank line may start a footnote's continuation, and
    // reads the footnotes again once; the caret does not rest in a table).
    const prose = (n: number) => {
      while (!view.state.doc.line(n).text.startsWith('Plain line')) n++;
      return n;
    };
    for (const line of [prose(5), prose(5_000), prose(9_960)]) {
      slices.mockClear();
      lines.mockClear();
      keystrokes(view, line, 10);
      // The visible lines are read again (decorations); reading every table or comment block
      // would be over 800 slices a keystroke here.
      expect(slices.mock.calls.length, `line ${line}`).toBeLessThan(10 * 300);
      expect(lines, `line ${line}`).not.toHaveBeenCalled();
    }
  });

  it('opens, moves and jumps quickly', { timeout: 120_000 }, () => {
    const started = performance.now();
    const view = noteEditor(longNote(), { ctx });
    expect(performance.now() - started).toBeLessThan(5_000);
    const move = performance.now();
    for (let i = 0; i < 20; i++) view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(5_000 + i).from) });
    for (const n of [1, 9_999, 2_500, 7_500, 5_000]) view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).from), scrollIntoView: true });
    expect((performance.now() - move) / 25).toBeLessThan(50);
  });
});

