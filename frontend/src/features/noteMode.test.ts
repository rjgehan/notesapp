import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry, MoveResult, SettingsResponse, WriteResult } from '../api/types';
import { usePendingNote } from '../state/pendingNote';
import { noteModeKey, stripNoteModes, useUi } from '../state/ui';
import { resetWorkspace, splitActive, workspace } from '../workspace/store';
import { applyMoveResult } from '../sync/applyEvents';
import { registerBuiltins } from '../extensions/builtins';
import { syncTarget } from '../sync/liveSync';
import { getCommand, runCommand } from './commands';
import { createNote } from './fileOps';
import { wantsNoteFocus } from './focus';
import { currentNoteMode, isEditingMode, noteModeOf, setNoteMode, showLivePreview, toggleSourceMode, viewModeFor } from './noteMode';
import { DEFAULT_SETTINGS } from './settings';

/** The store key of `path` in the active pane. */
const key = (path: string) => noteModeKey(workspace().activePane, path);

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
  resetWorkspace();
  useUi.setState({ noteModes: {} });
});

afterEach(() => {
  resetWorkspace();
  vi.restoreAllMocks();
  queryClient.clear();
  usePendingNote.setState({ pending: null, handoff: null });
  useUi.setState({ noteModes: {} });
});

describe('every note opens in Live Preview (DESIGN §6.6.1)', () => {
  it('is Live Preview, also when the vault default says `read` (an older build’s locked default)', () => {
    expect(currentNoteMode()).toBe('live');
    defaultMode('read');
    expect(currentNoteMode()).toBe('live');
  });

  it('an old `?mode=read` link opens the note in Live Preview', () => {
    window.history.replaceState(null, '', '/n/Welcome.md?mode=read');
    expect(currentNoteMode()).toBe('live');
  });

  it('a stored mode other than source (an older build’s `locked` or `read`) shows Live Preview', () => {
    expect(noteModeOf('locked')).toBe('live');
    expect(noteModeOf('read')).toBe('live');
    expect(noteModeOf(undefined)).toBe('live');
    expect(noteModeOf('source')).toBe('source');
    useUi.setState({ noteModes: { [key('Welcome.md')]: 'locked' as 'source' } });
    expect(currentNoteMode()).toBe('live');
  });

  it('the store keeps only source mode: any other mode forgets the choice', () => {
    useUi.getState().setNoteMode('Welcome.md', 'source');
    expect(useUi.getState().noteModes).toEqual({ 'Welcome.md': 'source' });
    useUi.getState().setNoteMode('Welcome.md', 'read');
    expect(useUi.getState().noteModes).toEqual({});
  });

  it('migrates a stored UI state: note modes and the new-note override are dropped, the rest kept', () => {
    expect(stripNoteModes({ leftOpen: false, noteModes: { 'A.md': 'locked' }, editingNew: 'A.md' })).toEqual({ leftOpen: false });
    expect(stripNoteModes(null)).toEqual({});
    expect(stripNoteModes('junk')).toEqual({});
    const persist = (useUi as unknown as { persist: { getOptions(): { version?: number; migrate?(s: unknown, v: number): unknown; merge?(p: unknown, c: unknown): unknown } } }).persist.getOptions();
    expect(persist.version).toBe(1);
    expect(persist.migrate?.({ rightOpen: true, noteModes: { 'A.md': 'locked' } }, 0)).toEqual({ rightOpen: true });
    const merged = persist.merge?.({ leftOpen: false, noteModes: { 'A.md': 'source' } }, useUi.getState()) as { leftOpen: boolean; noteModes: object };
    expect(merged.leftOpen).toBe(false);
    expect(merged.noteModes).toEqual({});
  });

  it('source mode is not saved with the UI state, so a reload shows Live Preview', () => {
    setNoteMode('source');
    const saved = JSON.parse(localStorage.getItem('notesapp:ui') ?? '{}') as { state?: Record<string, unknown> };
    expect(saved.state?.noteModes).toBeUndefined();
  });
});

describe('Show Markdown source, the escape hatch', () => {
  it('one note in source leaves the others in Live Preview', () => {
    setNoteMode('source');
    expect(currentNoteMode()).toBe('source');
    window.history.replaceState(null, '', '/n/Plan.md');
    expect(currentNoteMode()).toBe('live');
    window.history.replaceState(null, '', '/n/Welcome.md');
    expect(currentNoteMode()).toBe('source');
  });

  it('toggles, and "Back to normal view" returns to Live Preview', () => {
    toggleSourceMode();
    expect(currentNoteMode()).toBe('source');
    toggleSourceMode();
    expect(currentNoteMode()).toBe('live');
    toggleSourceMode();
    showLivePreview();
    expect(currentNoteMode()).toBe('live');
    expect(useUi.getState().noteModes).toEqual({});
  });

  it('the palette has "Show Markdown source (toggle)" and no lock or reading toggle; Mod-E is not a mode key', () => {
    registerBuiltins();
    expect(getCommand('editor.toggleSource')?.name).toBe('Show Markdown source (toggle)');
    expect(getCommand('editor.toggleSource')?.hotkey).toBeUndefined();
    expect(getCommand('editor.toggleMode')).toBeUndefined();
    expect(getCommand('editor.toggleReading')).toBeUndefined();
    runCommand('editor.toggleSource', { activePath: 'Welcome.md' });
    expect(currentNoteMode()).toBe('source');
    runCommand('editor.toggleSource', { activePath: 'Welcome.md' });
    expect(currentNoteMode()).toBe('live');
  });

  it('source mode follows a renamed note', () => {
    setNoteMode('source');
    const result: MoveResult = { dryRun: false, type: 'file', from: 'Welcome.md', to: 'Hello.md', moved: [], createdFolders: [], linkUpdates: [], failed: [], commitId: null };
    applyMoveResult(syncTarget, result);
    expect(useUi.getState().noteModes).toEqual({ [key('Hello.md')]: 'source' });
  });

  it('source mode is per pane: the same note in another pane stays in Live Preview', () => {
    const first = workspace().activePane;
    setNoteMode('source');
    splitActive('right');
    const second = workspace().activePane;
    expect(second).not.toBe(first);
    expect(currentNoteMode()).toBe('live');
    expect(useUi.getState().noteModes).toEqual({ [noteModeKey(first, 'Welcome.md')]: 'source' });
    toggleSourceMode();
    expect(useUi.getState().noteModes).toEqual({ [noteModeKey(first, 'Welcome.md')]: 'source', [noteModeKey(second, 'Welcome.md')]: 'source' });
  });

  it('switching from inside the note keeps the focus in the note', () => {
    const note = document.createElement('div');
    note.className = 'markdown-view';
    const content = document.createElement('div');
    content.tabIndex = 0;
    note.appendChild(content);
    document.body.appendChild(note);
    content.focus();
    setNoteMode('source');
    expect(wantsNoteFocus()).toBe(true);
    note.remove();
  });
});

describe('modes of other views', () => {
  it('maps a mode onto the modes a view has', () => {
    const textView = ['edit'] as const;
    const editOrRead = ['edit', 'read'] as const;
    expect(viewModeFor('live', [...textView])).toBe('edit');
    expect(viewModeFor('source', [...editOrRead])).toBe('edit');
    expect(viewModeFor('live', ['read'])).toBe('read');
    // A note asked for a reading mode shows Live Preview.
    expect(viewModeFor('read', ['live', 'source'])).toBe('live');
    expect(isEditingMode('source')).toBe(true);
    expect(isEditingMode('read')).toBe(false);
  });
});

describe('new notes', () => {
  it('a new note opens in Live Preview whatever the vault default, and keeps it when renamed', async () => {
    defaultMode('read');
    vi.spyOn(api, 'createFile').mockImplementation(async (req): Promise<WriteResult> => ({ file: entry(req.path), created: true, createdFolders: [] }));
    createNote('');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/n/Untitled.md'));
    expect(currentNoteMode()).toBe('live');
    const result: MoveResult = { dryRun: false, type: 'file', from: 'Untitled.md', to: 'Bug one test.md', moved: [], createdFolders: [], linkUpdates: [], failed: [], commitId: null };
    applyMoveResult(syncTarget, result);
    expect(window.location.pathname).toBe('/n/Bug%20one%20test.md');
    expect(currentNoteMode()).toBe('live');
    window.history.replaceState(null, '', '/n/Welcome.md');
    expect(currentNoteMode()).toBe('live');
  });
});
