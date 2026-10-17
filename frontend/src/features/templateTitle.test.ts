import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import { MockVault } from '../api/mock/vault';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { CreateFileRequest, MoveRequest, SaveFileRequest } from '../api/types';
import { usePendingNote, updatePendingTitle } from '../state/pendingNote';
import { documents } from '../sync/instance';
import { createNote } from './fileOps';
import { DEFAULT_SETTINGS } from './settings';
import { retitleText } from './templateTitle';
import { templateRenderer } from './templates';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  usePendingNote.setState({ pending: null, handoff: null });
});

describe('retitleText', () => {
  it('updates the lines a title placeholder rendered, where each occurs once', () => {
    const before = '---\ntitle: Untitled\n---\n# Untitled\n\nAgenda';
    const after = '---\ntitle: Standup\n---\n# Standup\n\nAgenda';
    expect(retitleText(before + '\n- typed already', before, after)).toBe(after + '\n- typed already');
    // A line the user has changed meanwhile is left alone.
    expect(retitleText('# Untitled (draft)\n\nAgenda', '# Untitled\n\nAgenda', '# Standup\n\nAgenda')).toBe('# Untitled (draft)\n\nAgenda');
  });
});

describe('New note from template (FE-16, ux)', () => {
  it('renders {{title}} with the title the user typed, not "Untitled"', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Templates/Meeting.md', content: '# {{title}}\n\nNotes' }, 'o');
    queryClient.setQueryData(queryKeys.tree(), vault.getTree());
    queryClient.setQueryData(queryKeys.settings(), { settings: DEFAULT_SETTINGS, version: 'v1', readOnly: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(api, 'readFile').mockImplementation(async (path: string) => structuredClone(vault.readFile(path)));
    vi.spyOn(api, 'createFile').mockImplementation(async (req: CreateFileRequest) => {
      await gate;
      return structuredClone(vault.createFile(req, 'me'));
    });
    vi.spyOn(api, 'move').mockImplementation(async (req: MoveRequest) => structuredClone(vault.move(req, 'me')));
    vi.spyOn(api, 'saveFile').mockImplementation(async (path: string, req: SaveFileRequest) => structuredClone(vault.saveFile(path, req, 'me')));

    createNote('', templateRenderer('Templates/Meeting.md'));
    await vi.waitFor(() => expect(usePendingNote.getState().pending).not.toBeNull());
    // The title is typed and committed before the note exists.
    updatePendingTitle(usePendingNote.getState().pending!.id, 'Standup 10-16', true);
    release();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/n/Standup%2010-16.md'));
    const session = documents.get('Standup 10-16.md')!;
    await session.flush();
    expect(vault.readFile('Standup 10-16.md').content).toBe('# Standup 10-16\n\nNotes');
  });
});
