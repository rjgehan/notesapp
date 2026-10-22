import { EditorSelection } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyEditors, marked, noteEditor } from '../../test/noteEditor';
import { noteTouchEnd } from './pointer';

afterEach(() => {
  destroyEditors();
  noteTouchEnd(-Infinity);
});

describe('taps and selection handles on the phone (ROADMAP 10c)', () => {
  it('a tap (a plain selection change just after a touch) lands where a click does', () => {
    // The caret lands inside the hidden `**` after "bold": a click puts it inside the bold text.
    let view = noteEditor('a **bold** b');
    noteTouchEnd();
    view.dispatch({ selection: EditorSelection.cursor(9), userEvent: 'select' });
    expect(marked(view)).toBe('a **bold‸** b');
    // Without a touch, the keyboard's stop stays where it is.
    noteTouchEnd(-Infinity);
    view = noteEditor('a **bold** b');
    view.dispatch({ selection: EditorSelection.cursor(9), userEvent: 'select' });
    expect(marked(view)).toBe('a **bold*‸* b');
  });

  it('a selection handle dragged into hidden markup stops at its edge, so the markup stays hidden', () => {
    const view = noteEditor('a **bold** b');
    noteTouchEnd();
    view.dispatch({ selection: EditorSelection.range(0, 9), userEvent: 'select' });
    expect(marked(view)).toBe('«a **bold**» b');
    expect(view.contentDOM.textContent).toBe('a bold b');
  });
});
