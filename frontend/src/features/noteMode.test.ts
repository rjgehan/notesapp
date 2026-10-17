import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, MoveResult, SettingsResponse, WriteResult } from '../api/types';
import { usePendingNote } from '../state/pendingNote';
import { useUi } from '../state/ui';
import { applyMoveResult } from '../sync/applyEvents';
import { registerBuiltins } from '../extensions/builtins';
import { syncTarget } from '../sync/liveSync';
import { getCommand, runCommand } from './commands';
import { createNote } from './fileOps';
import { wantsNoteFocus } from './focus';
import { currentNoteMode, isEditingMode, setNoteMode, toggleNoteMode, toggleReadingView, toggleSourceMode, viewModeFor } from './noteMode';
import { DEFAULT_SETTINGS } from './settings';

function entry(path: string): FileEntry {
  return { path, name: path, basename: path.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 0, mtime: '2026-10-16T10:00:00.000Z', version: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', aliases: [] };
}

function defaultMode(mode: 'edit' | 'read'): void {
  const response: SettingsResponse = { settings: { ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, defaultMode: mode } }, version: 'v', readOnly: false };
  queryClient.setQueryData(queryKeys.settings(), response);
}

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'b.1', folders: [], files: [entry('Welcome.md'), entry('Plan.md')] });
  window.history.replaceState(null, '', '/n/Welcome.md');
  useUi.setState({ noteModes: {}, editingNew: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  usePendingNote.setState({ pending: null, handoff: null });
  useUi.setState({ noteModes: {}, editingNew: null });
});

describe('note modes (ROADMAP 10a)', () => {
  it('Live Preview is the default for every note; `edit` as the vault default means Live Preview', () => {
    expect(currentNoteMode()).toBe('live');
    defaultMode('read');
    expect(currentNoteMode()).toBe('read');
  });

  it('a mode chosen for one note leaves the others in their own mode', () => {
    setNoteMode('source');
    expect(currentNoteMode()).toBe('source');
    window.history.replaceState(null, '', '/n/Plan.md');
    expect(currentNoteMode()).toBe('live');
    window.history.replaceState(null, '', '/n/Welcome.md');
    expect(currentNoteMode()).toBe('source');
  });

  it('choosing the default mode forgets the choice', () => {
    setNoteMode('locked');
    expect(useUi.getState().noteModes).toEqual({ 'Welcome.md': 'locked' });
    setNoteMode('live');
    expect(useUi.getState().noteModes).toEqual({});
  });

  it('Mod-E locks and unlocks editing; the reading view goes back to editing', () => {
    toggleNoteMode();
    expect(currentNoteMode()).toBe('locked');
    toggleNoteMode();
    expect(currentNoteMode()).toBe('live');
    setNoteMode('source');
    toggleNoteMode();
    expect(currentNoteMode()).toBe('locked');
    setNoteMode('read');
    toggleNoteMode();
    expect(currentNoteMode()).toBe('live');
  });

  it('the palette has Toggle source mode and Toggle lock editing', () => {
    registerBuiltins();
    expect(getCommand('editor.toggleSource')?.name).toBe('Toggle source mode');
    expect(getCommand('editor.toggleMode')?.name).toBe('Toggle lock editing');
    runCommand('editor.toggleSource', { activePath: 'Welcome.md' });
    expect(currentNoteMode()).toBe('source');
    runCommand('editor.toggleMode', { activePath: 'Welcome.md' });
    expect(currentNoteMode()).toBe('locked');
    runCommand('editor.toggleMode', { activePath: 'Welcome.md' });
    expect(currentNoteMode()).toBe('live');
  });

  it('the source toggle switches between Live Preview and source, and opens a locked note in source', () => {
    toggleSourceMode();
    expect(currentNoteMode()).toBe('source');
    toggleSourceMode();
    expect(currentNoteMode()).toBe('live');
    setNoteMode('locked');
    toggleSourceMode();
    expect(currentNoteMode()).toBe('source');
  });

  it('the reading view stays reachable, and ?mode=read forces it', () => {
    toggleReadingView();
    expect(currentNoteMode()).toBe('read');
    toggleReadingView();
    expect(currentNoteMode()).toBe('live');
    window.history.replaceState(null, '', '/n/Welcome.md?mode=read');
    expect(currentNoteMode()).toBe('read');
  });

  it('modes follow a renamed note', () => {
    setNoteMode('source');
    const result: MoveResult = { dryRun: false, type: 'file', from: 'Welcome.md', to: 'Hello.md', moved: [], createdFolders: [], linkUpdates: [], failed: [], commitId: null };
    applyMoveResult(syncTarget, result);
    expect(useUi.getState().noteModes).toEqual({ 'Hello.md': 'source' });
  });

  it('maps a mode onto the modes a view has', () => {
    const textView = ['edit'] as const;
    const editOrRead = ['edit', 'read'] as const;
    expect(viewModeFor('live', [...textView])).toBe('edit');
    expect(viewModeFor('source', [...editOrRead])).toBe('edit');
    expect(viewModeFor('locked', [...editOrRead])).toBe('read');
    expect(viewModeFor('locked', ['read'])).toBe('read');
    expect(viewModeFor('locked', ['live', 'source', 'locked', 'read'])).toBe('locked');
    expect(isEditingMode('locked')).toBe(false);
    expect(isEditingMode('source')).toBe(true);
  });
});

describe('new notes open in the editor (FE-1, ux)', () => {
  it('a note created while reading view is the default opens in Live Preview, and keeps it when renamed', async () => {
    defaultMode('read');
    vi.spyOn(api, 'createFile').mockImplementation(async (req): Promise<WriteResult> => ({ file: entry(req.path), created: true, createdFolders: [] }));
    createNote('');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/n/Untitled.md'));
    expect(currentNoteMode()).toBe('live');
    // The title commit renames it (own MoveResult).
    const result: MoveResult = { dryRun: false, type: 'file', from: 'Untitled.md', to: 'Bug one test.md', moved: [], createdFolders: [], linkUpdates: [], failed: [], commitId: null };
    applyMoveResult(syncTarget, result);
    expect(window.location.pathname).toBe('/n/Bug%20one%20test.md');
    expect(currentNoteMode()).toBe('live');
    // Other notes keep the default reading view.
    window.history.replaceState(null, '', '/n/Welcome.md');
    expect(currentNoteMode()).toBe('read');
  });

  it('toggling the mode ends the new note’s override', () => {
    defaultMode('read');
    useUi.setState({ editingNew: 'Welcome.md' });
    expect(currentNoteMode()).toBe('live');
    setNoteMode('read');
    expect(currentNoteMode()).toBe('read');
  });

  it('a new note that was locked opens in the editor', () => {
    useUi.setState({ noteModes: { 'Welcome.md': 'locked' }, editingNew: 'Welcome.md' });
    expect(currentNoteMode()).toBe('live');
  });
});

describe('Mod-E keeps the focus in the note (FE-13)', () => {
  it('requests note focus when the toggle comes from inside the note', () => {
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
