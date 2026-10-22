import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { encryptedSections, sectionInState } from './encryptedSections';

const B64 = 'QUJDREVGR0hJSktMTU5PUA==';

describe('encrypted sections in the editor (item 27)', () => {
  it('shows each section as one atomic chip instead of its ciphertext', () => {
    const doc = `PIN: %%🔐β 💡usual💡${B64} 🔐%% and 🔐β ${B64} 🔐.`;
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [encryptedSections] }), parent });
    const chips = [...view.contentDOM.querySelectorAll('.encrypted-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['🔒 Encrypted · usual', '🔒 Encrypted']);
    expect(view.contentDOM.textContent).not.toContain(B64);
    // The cursor steps over a section in one move.
    const start = doc.indexOf('%%');
    view.dispatch({ selection: EditorSelection.cursor(start) });
    const moved = view.moveByChar(view.state.selection.main, true);
    expect(moved.head).toBe(doc.indexOf(' and'));
    expect(sectionInState(view.state, start + 3)?.hint).toBe('usual');
    expect(sectionInState(view.state, 1)).toBeNull();
    view.destroy();
    parent.remove();
  });
});
