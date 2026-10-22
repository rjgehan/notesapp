import { afterEach, describe, expect, it } from 'vitest';
import { destroyEditors, noteEditor } from '../../test/noteEditor';

afterEach(() => destroyEditors());

const NOTE = ['A paragraph ^para1', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '^tbl', '', '```', 'code ^kept', '```', '', 'Last line'].join('\n');

describe('block ids in Live Preview (ROADMAP item 20)', () => {
  it('hide in a locked note, outside code', () => {
    const view = noteEditor(NOTE, { mode: 'locked' });
    const text = view.contentDOM.textContent ?? '';
    expect(text).toContain('A paragraph');
    expect(text).not.toContain('^para1');
    expect(text).not.toContain('^tbl');
    expect(text).toContain('code ^kept');
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it('show while editing when the caret touches them, and in source mode', () => {
    const view = noteEditor('‸' + NOTE);
    expect(view.contentDOM.textContent).not.toContain('^para1');
    view.dispatch({ selection: { anchor: NOTE.indexOf('^para1') + 3 } });
    expect(view.contentDOM.textContent).toContain('^para1');
    expect(noteEditor(NOTE, { mode: 'source' }).contentDOM.textContent).toContain('^para1');
  });
});
