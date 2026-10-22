import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltins } from '../extensions/builtins';
import { runCommand } from '../features/commands';
import { clearActiveEditor, setActiveEditor } from './activeEditor';
import { editorKit } from './kitHandle';

let view: EditorView | null = null;

afterEach(() => {
  if (view) {
    clearActiveEditor(view);
    view.destroy();
    view = null;
  }
});

describe('the editor kit (the editor code palette commands run, outside the main chunk)', () => {
  it('is not loaded by the app shell: an editor brings it, and a command without it loads it first', async () => {
    registerBuiltins();
    expect(editorKit()).toBeNull();
    view = new EditorView({ state: EditorState.create({ doc: 'word', selection: EditorSelection.range(0, 4) }), parent: document.body });
    setActiveEditor(view);
    runCommand('editor.bold', { activePath: 'Plan.md' });
    await vi.waitFor(() => expect(view!.state.doc.toString()).toBe('**word**'));
    expect(editorKit()).not.toBeNull();
    // Loaded: the next command runs at once, inside the key press or tap.
    runCommand('editor.italic', { activePath: 'Plan.md' });
    expect(view.state.doc.toString()).not.toBe('**word**');
  });
});
