import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearActiveEditor, setActiveEditor } from '../../editor/activeEditor';
import { wantsNoteFocus } from '../../features/focus';
import { usePendingNote } from '../../state/pendingNote';

const renameEntry = vi.fn<(path: string, basename: string, type: 'file' | 'folder') => Promise<string>>();
vi.mock('../../features/fileOps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/fileOps')>()),
  renameEntry: (path: string, basename: string, type: 'file' | 'folder') => renameEntry(path, basename, type),
}));

const { InlineTitle } = await import('./InlineTitle');

function fakeEditor(): EditorView & { focus: ReturnType<typeof vi.fn> } {
  return { focus: vi.fn() } as unknown as EditorView & { focus: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  usePendingNote.setState({ pending: null, handoff: null });
  renameEntry.mockReset();
});

describe('InlineTitle', () => {
  it('keeps the new-note title selected across the handoff, so typing replaces "Untitled"', () => {
    usePendingNote.setState({ handoff: { path: 'Untitled.md', title: 'Untitled', selectionStart: 0, selectionEnd: 8 } });
    render(<InlineTitle path="Untitled.md" editable />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('Note title');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
    expect(usePendingNote.getState().handoff).toBeNull();
  });

  it('continues with the caret where it was when part of the title was already typed', () => {
    usePendingNote.setState({ handoff: { path: 'Untitled.md', title: 'Meet', selectionStart: 4, selectionEnd: 4 } });
    render(<InlineTitle path="Untitled.md" editable />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('Note title');
    expect(input.value).toBe('Meet');
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
  });

  it('moves on to the text on Enter when the name is unchanged', () => {
    const editor = fakeEditor();
    setActiveEditor(editor);
    render(<InlineTitle path="Plan.md" editable />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('Note title');
    input.focus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(renameEntry).not.toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalled();
    clearActiveEditor(editor);
  });

  it('renames on Enter and asks the renamed note to take the focus', async () => {
    let resolveRename: (path: string) => void = () => {};
    renameEntry.mockImplementation(() => new Promise((r) => (resolveRename = r)));
    render(<InlineTitle path="Untitled.md" editable />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('Note title');
    input.focus();
    fireEvent.input(input, { target: { value: 'Meeting notes' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(renameEntry).toHaveBeenCalledWith('Untitled.md', 'Meeting notes', 'file'));
    expect(wantsNoteFocus()).toBe(true);
    resolveRename('Meeting notes.md');
  });

  it('hands the focus to the editor inside the key press, and the blur commits the rename', async () => {
    renameEntry.mockResolvedValue('Meeting notes.md');
    const content = document.createElement('div');
    content.tabIndex = 0;
    document.body.append(content);
    const editor = { focus: vi.fn(() => content.focus()) } as unknown as EditorView;
    setActiveEditor(editor);
    render(<InlineTitle path="Untitled.md" editable />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('Note title');
    input.focus();
    fireEvent.input(input, { target: { value: 'Meeting notes' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement).toBe(content);
    await waitFor(() => expect(renameEntry).toHaveBeenCalledWith('Untitled.md', 'Meeting notes', 'file'));
    clearActiveEditor(editor);
    content.remove();
  });

  it('does not steal focus later when the rename fails', async () => {
    renameEntry.mockRejectedValue(new Error('already exists'));
    render(<InlineTitle path="Untitled.md" editable />);
    const input = screen.getByLabelText<HTMLTextAreaElement>('Note title');
    input.focus();
    fireEvent.input(input, { target: { value: 'Taken' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe('Untitled'));
    expect(wantsNoteFocus()).toBe(false);
  });
});
