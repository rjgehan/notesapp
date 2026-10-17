import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, MoveResult, WriteResult } from '../api/types';
import { usePendingNote } from '../state/pendingNote';
import { useUi } from '../state/ui';
import { applyMoveResult } from '../sync/applyEvents';
import { syncTarget } from '../sync/liveSync';
import { createNote } from './fileOps';
import { wantsNoteFocus } from './focus';
import { currentNoteMode, setNoteMode } from './noteMode';

function entry(path: string): FileEntry {
  return { path, name: path, basename: path.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 0, mtime: '2026-10-16T10:00:00.000Z', version: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', aliases: [] };
}

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [entry('Welcome.md')] });
  window.history.replaceState(null, '', '/n/Welcome.md');
  useUi.setState({ noteMode: 'read', editingNew: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  usePendingNote.setState({ pending: null, handoff: null });
  useUi.setState({ noteMode: null, editingNew: null });
});

describe('new notes open in the editor (FE-1, ux)', () => {
  it('a note created while reading view is the mode opens in edit mode, and keeps it when renamed', async () => {
    vi.spyOn(api, 'createFile').mockImplementation(async (req): Promise<WriteResult> => ({ file: entry(req.path), created: true, createdFolders: [] }));
    createNote('');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/n/Untitled.md'));
    expect(currentNoteMode()).toBe('edit');
    // The title commit renames it (own MoveResult).
    const result: MoveResult = { dryRun: false, type: 'file', from: 'Untitled.md', to: 'Bug one test.md', moved: [], createdFolders: [], linkUpdates: [], failed: [], commitId: null };
    applyMoveResult(syncTarget, result);
    expect(window.location.pathname).toBe('/n/Bug%20one%20test.md');
    expect(currentNoteMode()).toBe('edit');
    // Other notes keep the chosen reading view.
    window.history.replaceState(null, '', '/n/Welcome.md');
    expect(currentNoteMode()).toBe('read');
  });

  it('toggling the mode ends the new note’s override', () => {
    useUi.setState({ editingNew: 'Welcome.md' });
    expect(currentNoteMode()).toBe('edit');
    setNoteMode('read');
    expect(currentNoteMode()).toBe('read');
  });
});

describe('Mod-E keeps the focus in the note (FE-13)', () => {
  it('requests note focus when the toggle comes from inside the note', () => {
    useUi.setState({ noteMode: 'edit' });
    const note = document.createElement('div');
    note.className = 'markdown-view';
    const content = document.createElement('div');
    content.tabIndex = 0;
    note.appendChild(content);
    document.body.appendChild(note);
    content.focus();
    setNoteMode('read');
    expect(wantsNoteFocus()).toBe(true);
    note.remove();
  });
});
