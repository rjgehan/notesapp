import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import { MockVault } from '../api/mock/vault';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { CreateFileRequest, FolderTemplate, MoveRequest, SaveFileRequest, Settings } from '../api/types';
import { useDialogs } from '../state/dialogs';
import { usePendingNote, updatePendingTitle } from '../state/pendingNote';
import { documents } from '../sync/instance';
import { createNamedNote, createNote } from './fileOps';
import { folderTemplateFor } from './folderTemplates';
import { DEFAULT_SETTINGS } from './settings';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  usePendingNote.setState({ pending: null, handoff: null });
  useDialogs.setState({ stack: [] });
});

function withRules(rules: FolderTemplate[], folder = 'Templates'): Settings {
  return { ...DEFAULT_SETTINGS, templates: { ...DEFAULT_SETTINGS.templates, folder, folderTemplates: rules } };
}

describe('folderTemplateFor (ROADMAP item 30)', () => {
  const settings = withRules([
    { folder: '', template: 'Templates/Any.md' },
    { folder: 'Work', template: 'Templates/Work.md' },
    { folder: 'Work/Meetings', template: 'Templates/Meeting.md' },
    { folder: 'Unused', template: '' },
  ]);

  it('takes the deepest folder that contains the new note', () => {
    expect(folderTemplateFor('Work/Meetings/2026', settings)).toBe('Templates/Meeting.md');
    expect(folderTemplateFor('Work/Meetings', settings)).toBe('Templates/Meeting.md');
    expect(folderTemplateFor('Work', settings)).toBe('Templates/Work.md');
    expect(folderTemplateFor('Workshop', settings)).toBe('Templates/Any.md');
    expect(folderTemplateFor('', settings)).toBe('Templates/Any.md');
    expect(folderTemplateFor('Unused', settings)).toBe('Templates/Any.md');
  });

  it('gives notes in the templates folder none, and none without rules', () => {
    expect(folderTemplateFor('Templates', settings)).toBeNull();
    expect(folderTemplateFor('Templates/Sub', settings)).toBeNull();
    expect(folderTemplateFor('Work', withRules([]))).toBeNull();
  });
});

describe('New notes from folder templates', () => {
  function setup(rules: FolderTemplate[]) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Templates/Meeting.md', content: '# {{title}}\nTopic: {{prompt:Topic}}\n\n{{cursor}}\n\nNotes' }, 'o');
    vault.createFile({ path: 'Meetings/Agenda.md', content: '' }, 'o');
    queryClient.setQueryData(queryKeys.tree(), vault.getTree());
    queryClient.setQueryData(queryKeys.settings(), { settings: withRules(rules), version: 'v1', readOnly: false });
    vi.spyOn(api, 'readFile').mockImplementation(async (path: string) => structuredClone(vault.readFile(path)));
    const created = vi.spyOn(api, 'createFile').mockImplementation(async (req: CreateFileRequest) => structuredClone(vault.createFile(req, 'me')));
    vi.spyOn(api, 'move').mockImplementation(async (req: MoveRequest) => structuredClone(vault.move(req, 'me')));
    vi.spyOn(api, 'saveFile').mockImplementation(async (path: string, req: SaveFileRequest) => structuredClone(vault.saveFile(path, req, 'me')));
    return { vault, created };
  }

  async function answer(values: string[] | null) {
    await vi.waitFor(() => expect(useDialogs.getState().stack.at(-1)?.kind).toBe('fields'));
    const request = useDialogs.getState().stack.at(-1);
    if (request?.kind === 'fields') request.resolve(values);
  }

  it('asks the questions, renders the title the user typed and puts the caret at {{cursor}}', async () => {
    const { vault } = setup([{ folder: 'Meetings', template: 'Templates/Meeting.md' }]);
    createNote('Meetings');
    await vi.waitFor(() => expect(usePendingNote.getState().pending).not.toBeNull());
    updatePendingTitle(usePendingNote.getState().pending!.id, 'Standup', true);
    await answer(['Roadmap']);
    await vi.waitFor(() => expect(window.location.pathname).toBe('/n/Meetings/Standup.md'));
    const session = documents.get('Meetings/Standup.md')!;
    await vi.waitFor(() => expect(session.getText()).toBe('# Standup\nTopic: Roadmap\n\n\n\nNotes'));
    await session.flush();
    expect(vault.readFile('Meetings/Standup.md').content).toBe('# Standup\nTopic: Roadmap\n\n\n\nNotes');
    expect(session.editorState.selection.main.head).toBe('# Standup\nTopic: Roadmap\n\n'.length);
  });

  it('creates nothing when the questions are cancelled', async () => {
    const { created } = setup([{ folder: '', template: 'Templates/Meeting.md' }]);
    createNote('Meetings');
    await answer(null);
    await vi.waitFor(() => expect(usePendingNote.getState().pending).toBeNull());
    expect(created).not.toHaveBeenCalled();
  });

  it('applies to a note named in the quick switcher, and not to other files', async () => {
    const { vault } = setup([{ folder: '', template: 'Templates/Meeting.md' }]);
    const done = createNamedNote('Retro', null, true);
    await answer(['Wins']);
    await done;
    expect(vault.readFile('Retro.md').content).toBe('# Retro\nTopic: Wins\n\n\n\nNotes');
    createNote('', '', 'sheet', 'spreadsheet');
    await vi.waitFor(() => expect(vault.readFile('Untitled.sheet').content).toBe(''));
    expect(useDialogs.getState().stack).toEqual([]);
  });
});
