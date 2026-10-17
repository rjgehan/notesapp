import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { CreateTaskRequest, FileEntry, SettingsResponse, Task, TreeResponse } from '../api/types';
import { DEFAULT_SETTINGS } from '../features/settings';
import { useToasts } from '../state/toasts';
import { DocumentSession } from '../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../test/fakes';
import { checkboxAt, convertCheckbox, linkDisplay, parseCheckboxLine, parseCheckboxText, taskLink } from './convert';
import { taskStore } from './store';
import { makeList, makeTask } from './testing';

function file(path: string): FileEntry {
  const name = path.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  return { path, name, basename: name.slice(0, dot), extension: name.slice(dot + 1), kind: path.endsWith('.md') ? 'note' : 'text', size: 1, mtime: '2026-10-17T10:00:00Z', version: 'v1', aliases: [] };
}

const inbox = makeList({ id: 'INBOX', name: 'Inbox', path: 'Tasks/Inbox.tasks' });
const toasts = () => useToasts.getState().toasts.map((t) => t.message);

beforeEach(() => {
  queryClient.setQueryData<TreeResponse>(queryKeys.tree(), { eventId: 'b.1', folders: [{ path: 'Tasks', name: 'Tasks' }], files: [file('Weekend.md'), file('Tasks/Inbox.tasks')] });
  taskStore.reset();
  taskStore.setLists([inbox], [], taskStore.generation());
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

describe('reading a checkbox line', () => {
  it('finds open checkboxes only, with their list marker, in lists and quotes', () => {
    expect(parseCheckboxLine('- [ ] Buy milk')).toEqual({ prefix: '- ', text: 'Buy milk' });
    expect(parseCheckboxLine('  > 1. [ ]   Call Bob  ')).toEqual({ prefix: '  > 1. ', text: 'Call Bob' });
    expect(parseCheckboxLine('* [ ] x')).toEqual({ prefix: '* ', text: 'x' });
    expect(parseCheckboxLine('- [x] Done')).toBeNull();
    expect(parseCheckboxLine('- [ ]')).toBeNull();
    expect(parseCheckboxLine('- Buy milk')).toBeNull();
    expect(parseCheckboxLine('[ ] no marker')).toBeNull();
  });

  it('reads the Obsidian Tasks emoji fields into task fields', () => {
    expect(parseCheckboxText('Pay rent 📅 2026-11-01 ⏫ 🔁 every month #home ➕ 2026-10-01')).toEqual({
      title: 'Pay rent #home',
      due: '2026-11-01',
      start: null,
      priority: 3,
      repeat: 'every month',
    });
    expect(parseCheckboxText('Mow ⏳ 2026-10-20 🛫 2026-10-19 🔽')).toMatchObject({ title: 'Mow', start: '2026-10-20', priority: 1 });
    expect(parseCheckboxText('Plant 🛫 2026-10-19 🔼️')).toMatchObject({ title: 'Plant', start: '2026-10-19', priority: 2 });
    expect(parseCheckboxText('📅 2026-11-01')).toMatchObject({ title: '📅 2026-11-01', due: '2026-11-01' });
    expect(parseCheckboxText('Call [[Bob]] about #work')).toEqual({ title: 'Call [[Bob]] about #work', due: null, start: null, priority: 0, repeat: null });
  });

  it('writes the link’s text without link syntax', () => {
    expect(linkDisplay('Call [[Bob|Robert]] about [[Plan#Goals]] #work')).toBe('Call Robert about Plan › Goals #work');
    expect(linkDisplay('a|b ] c')).toBe('ab c');
  });

  it('links to the task in the configured style', () => {
    expect(taskLink('Tasks/Inbox.tasks', '01JC', 'Call [[Bob]]', 'Weekend.md')).toBe('[[Inbox.tasks#^01JC|Call Bob]]');
    queryClient.setQueryData<SettingsResponse>(queryKeys.settings(), { settings: { ...DEFAULT_SETTINGS, files: { ...DEFAULT_SETTINGS.files, useWikilinks: false, newLinkFormat: 'absolute' } }, version: 'v1', readOnly: false });
    expect(taskLink('Tasks/Inbox.tasks', '01JC', 'Call Bob', 'Weekend.md')).toBe('[Call Bob](Tasks/Inbox.tasks#%5E01JC)');
  });
});

describe('Convert checkbox to task (ROADMAP item 4)', () => {
  async function open(content: string) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Weekend.md', content }, 'other-device-1');
    const fake = fakeApi(vault);
    const session = new DocumentSession('Weekend.md', sessionDeps(fake.api));
    await session.ready;
    vi.useFakeTimers();
    return { vault, session };
  }
  const created = (req: CreateTaskRequest, id = 'T1'): Task => makeTask({ id, listId: 'INBOX', title: req.title, due: req.due ?? null, priority: req.priority ?? 0 });
  const lineStart = (s: DocumentSession, text: string) => s.getText().indexOf(text);

  it('creates the task in the Inbox, then puts a link to it in place of the checkbox', async () => {
    const { session } = await open('# Plan\n\n- [ ] Book the dentist 📅 2026-10-21 ⏫\n- [ ] Renew passport\n');
    const create = vi.fn(async (req: CreateTaskRequest) => created(req));
    const at = checkboxAt(session, 'Weekend.md', lineStart(session, '- [ ] Book') + 4)!;
    expect(await convertCheckbox(at, create)).toBe('T1');
    expect(create).toHaveBeenCalledWith({ title: 'Book the dentist', due: '2026-10-21', priority: 3 });
    expect(session.getText()).toBe('# Plan\n\n- [[Inbox.tasks#^T1|Book the dentist]]\n- [ ] Renew passport\n');
    expect(toasts().at(-1)).toBe('Moved “Book the dentist” to Inbox');
  });

  it('finds the line again when edits elsewhere moved it while the task was created', async () => {
    const { session } = await open('- [ ] Renew passport\n');
    const at = checkboxAt(session, 'Weekend.md', 3)!;
    await convertCheckbox(at, async (req) => {
      session.applyEdit({ from: 0, insert: 'Added above\n' });
      session.applyEdit({ from: session.editorState.doc.length, insert: 'and below' });
      return created(req, 'T2');
    });
    expect(session.getText()).toBe('Added above\n- [[Inbox.tasks#^T2|Renew passport]]\nand below');
  });

  it('follows the line through a change made on another device meanwhile', async () => {
    const { vault, session } = await open('- [ ] Renew passport\n');
    const at = checkboxAt(session, 'Weekend.md', 3)!;
    await convertCheckbox(at, async (req) => {
      const current = vault.readFile('Weekend.md');
      const saved = vault.saveFile('Weekend.md', { content: '# Errands\n' + current.content + 'Milk\n', baseVersion: current.version }, 'other-device-1');
      await session.onRemoteChanged(saved.file);
      return created(req, 'T4');
    });
    expect(session.getText()).toBe('# Errands\n- [[Inbox.tasks#^T4|Renew passport]]\nMilk\n');
  });

  it('leaves the note alone when the line itself changed meanwhile', async () => {
    const { session } = await open('- [ ] Renew passport\n');
    const at = checkboxAt(session, 'Weekend.md', 3)!;
    await convertCheckbox(at, async (req) => {
      session.applyEdit({ from: session.getText().indexOf('passport') + 'passport'.length, insert: ' and visa' });
      return created(req, 'T3');
    });
    expect(session.getText()).toBe('- [ ] Renew passport and visa\n');
    expect(toasts().at(-1)).toContain('The line changed meanwhile, so it was left in the note');
  });

  it('keeps the line when the task cannot be created', async () => {
    const { session } = await open('- [ ] Renew passport\n');
    const at = checkboxAt(session, 'Weekend.md', 3)!;
    expect(await convertCheckbox(at, async () => null)).toBeNull();
    expect(session.getText()).toBe('- [ ] Renew passport\n');
  });

  it('reads a recurrence, and keeps one it cannot read in the title', async () => {
    const { session } = await open('- [ ] Water plants 🔁 every week\n- [ ] Odd 🔁 every blue moon\n');
    const create = vi.fn(async (req: CreateTaskRequest) => created(req, `R${create.mock.calls.length}`));
    await convertCheckbox(checkboxAt(session, 'Weekend.md', 3)!, create);
    expect(create.mock.calls[0][0]).toEqual({ title: 'Water plants', recurrence: { rrule: 'FREQ=WEEKLY', from: 'due' } });
    await convertCheckbox(checkboxAt(session, 'Weekend.md', lineStart(session, '- [ ] Odd') + 3)!, create);
    expect(create.mock.calls[1][0]).toEqual({ title: 'Odd 🔁 every blue moon' });
  });

  it('offers nothing on a line that is not an open checkbox', async () => {
    const { session } = await open('- [x] Done\nplain\n');
    expect(checkboxAt(session, 'Weekend.md', 2)).toBeNull();
    expect(checkboxAt(session, 'Weekend.md', 12)).toBeNull();
  });
});
