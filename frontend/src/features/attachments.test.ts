import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { api } from '../api/endpoints';
import { MockVault } from '../api/mock/vault';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { AttachmentResult } from '../api/types';
import { useDialogs } from '../state/dialogs';
import { useToasts } from '../state/toasts';
import { DocumentSession } from '../sync/DocumentSession';
import { pendingUploads } from '../editor/uploads';
import { DocumentRegistry } from '../sync/documents';
import { MoveMap } from '../sync/moves';
import { fakeApi, MemoryDraftStore, sessionDeps } from '../test/fakes';
import { attachmentName, insertAttachments, uploadToFolder } from './attachments';

function result(path: string): AttachmentResult {
  return {
    file: { path, name: path.split('/').pop()!, basename: 'x', extension: 'png', kind: 'image', size: 3, mtime: '2026-10-16T14:03:09.000Z', version: null, aliases: [] },
    created: true,
    createdFolders: [],
    linkText: path.split('/').pop()!,
    markdown: `![[${path.split('/').pop()}]]`,
  };
}

async function open(content: string) {
  const vault = new MockVault(false);
  vault.createFile({ path: 'Notes/a.md', content }, 'other-device-1');
  const session = new DocumentSession('Notes/a.md', sessionDeps(fakeApi(vault).api));
  await session.ready;
  return session;
}

afterEach(() => {
  useToasts.setState({ toasts: [] });
});

describe('attachmentName', () => {
  const at = new Date(2026, 9, 16, 14, 3, 9);

  it('names pasted images "Pasted image YYYYMMDDHHmmss.<ext>" in local time', () => {
    expect(attachmentName({ name: 'image.png', type: 'image/png' }, true, at)).toBe('Pasted image 20261016140309.png');
    expect(attachmentName({ name: '', type: 'image/jpeg' }, true, at)).toBe('Pasted image 20261016140309.jpg');
    expect(attachmentName({ name: 'doc.pdf', type: 'application/pdf' }, true, at)).toBe('Pasted file 20261016140309.pdf');
  });

  it('keeps the name of a dropped file (the server sanitizes it)', () => {
    expect(attachmentName({ name: 'Holiday photo.HEIC', type: '' }, false, at)).toBe('Holiday photo.HEIC');
  });
});

describe('insertAttachments', () => {
  it('shows a pending upload at the selection (not as text), then inserts the returned embed', async () => {
    const session = await open('Hello world');
    let finish!: (r: AttachmentResult) => void;
    const upload = vi.spyOn(api, 'uploadAttachment').mockImplementation(() => new Promise((r) => (finish = r)));
    const file = new File(['abc'], 'pic.png', { type: 'image/png' });
    const done = insertAttachments(session, [file], { from: 6, to: 11 }, false);
    expect(session.getText()).toBe('Hello ');
    expect(pendingUploads(session.editorState)).toEqual([expect.objectContaining({ pos: 6, label: 'pic.png' })]);
    expect(upload).toHaveBeenCalledWith('pic.png', 'Notes/a.md', file, { idempotencyKey: expect.any(String) });
    finish(result('Attachments/pic.png'));
    await done;
    expect(session.getText()).toBe('Hello ![[pic.png]]');
    expect(pendingUploads(session.editorState)).toEqual([]);
    expect(session.getSnapshot().status).toBe('dirty');
    session.dispose();
  });

  it('never autosaves a placeholder, and counts the upload as unsaved work until it lands', async () => {
    vi.useFakeTimers();
    try {
      const vault = new MockVault(false);
      vault.createFile({ path: 'Notes/a.md', content: 'note' }, 'other-device-1');
      const fake = fakeApi(vault);
      const docs = new DocumentRegistry({
        api: fake.api,
        drafts: new MemoryDraftStore(),
        moves: new MoveMap(),
        clientId: 'tab-a-000001',
        queryClient: null,
        tabs: null,
        treeEntry: () => undefined,
        notify: () => {},
        onDraftWrite: () => {},
        onSummary: () => {},
        onSessionMoved: () => {},
        caughtUp: () => true,
      });
      const session = docs.acquire('Notes/a.md', 'view');
      await session.ready;
      let finish!: (r: AttachmentResult) => void;
      vi.spyOn(api, 'uploadAttachment').mockImplementation(() => new Promise((r) => (finish = r)));
      // The paste goes after a typed line break, which autosaves while the image uploads.
      session.applyEdit({ from: 4, insert: '\n' });
      const done = insertAttachments(session, [new File(['x'], 'image.png', { type: 'image/png' })], { from: 5, to: 5 }, true);
      await vi.advanceTimersByTimeAsync(1500);
      expect(vault.readFile('Notes/a.md').content).toBe('note\n');
      expect(session.hasUnsavedChanges()).toBe(false);
      expect(docs.anyUnsaved()).toBe(true);
      finish(result('Attachments/Pasted image.png'));
      await done;
      await vi.advanceTimersByTimeAsync(1500);
      expect(vault.readFile('Notes/a.md').content).toBe('note\n![[Pasted image.png]]');
      expect(docs.anyUnsaved()).toBe(false);
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the files\' order when the later upload finishes first', async () => {
    const session = await open('A\n');
    const finish: Record<string, (r: AttachmentResult) => void> = {};
    vi.spyOn(api, 'uploadAttachment').mockImplementation((name) => new Promise((r) => (finish[name] = r)));
    const files = [new File(['1'], 'one.png', { type: 'image/png' }), new File(['2'], 'two.png', { type: 'image/png' })];
    const done = insertAttachments(session, files, { from: 2, to: 2 }, false);
    finish['two.png'](result('Attachments/two.png'));
    await Promise.resolve();
    finish['one.png'](result('Attachments/one.png'));
    await done;
    expect(session.getText()).toBe('A\n![[one.png]]\n![[two.png]]');
    session.dispose();
  });

  it('removes the placeholder of a failed upload, with its line break, and reports it', async () => {
    const session = await open('A\nB');
    vi.spyOn(api, 'uploadAttachment').mockImplementation(async (name) => {
      if (name === 'bad.png') throw new ApiError({ type: 'x', title: 'Too large', status: 413, code: 'too-large' });
      return result('Attachments/good.png');
    });
    const files = [new File(['1'], 'good.png', { type: 'image/png' }), new File(['2'], 'bad.png', { type: 'image/png' })];
    await insertAttachments(session, files, { from: 2, to: 2 }, false);
    expect(session.getText()).toBe('A\n![[good.png]]B');
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([expect.stringContaining('bad.png')]);
    session.dispose();
  });
});

describe('uploadToFolder (explorer drop, DESIGN §6.15)', () => {
  function seedTree(paths: string[]) {
    queryClient.setQueryData(queryKeys.tree(), {
      eventId: 'b.1',
      folders: [{ path: 'Pics', name: 'Pics' }],
      files: paths.map((p) => ({ ...result(p).file, path: p, name: p.split('/').pop()!, kind: p.endsWith('.md') ? 'note' : 'image' })),
    });
  }

  async function answer(choice: string | null) {
    await vi.waitFor(() => expect(useDialogs.getState().stack.length).toBe(1));
    const dialog = useDialogs.getState().stack[0];
    if (dialog.kind !== 'choice') throw new Error('expected a choice dialog');
    return { dialog, resolve: () => dialog.resolve(choice) };
  }

  afterEach(() => {
    queryClient.clear();
    useDialogs.setState({ stack: [] });
  });

  it('uploads new names with onConflict fail and an idempotency key', async () => {
    seedTree([]);
    const upload = vi.spyOn(api, 'uploadRaw').mockImplementation(async (path) => ({ file: { ...result(path).file, path }, created: true, createdFolders: [] }));
    await uploadToFolder('Pics', [new File(['1'], 'a.png', { type: 'image/png' })]);
    expect(upload).toHaveBeenCalledWith('Pics/a.png', expect.any(File), 'fail', { idempotencyKey: expect.any(String) });
  });

  it('asks before uploading over a case-insensitive collision: Replace, Keep both or Skip', async () => {
    seedTree(['Pics/A.png', 'Pics/b.png']);
    const upload = vi.spyOn(api, 'uploadRaw').mockImplementation(async (path) => ({ file: { ...result(path).file, path }, created: true, createdFolders: [] }));
    const done = uploadToFolder('Pics', [new File(['1'], 'a.png', { type: 'image/png' }), new File(['2'], 'b.png', { type: 'image/png' })]);
    const first = await answer('overwrite');
    expect(first.dialog.choices.map((c) => c.id)).toEqual(['skip', 'rename', 'overwrite']);
    expect(upload).not.toHaveBeenCalled();
    first.resolve();
    await vi.waitFor(() => expect(useDialogs.getState().stack[0]?.id).not.toBe(first.dialog.id));
    (await answer('rename')).resolve();
    await done;
    expect(upload.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['Pics/A.png', 'overwrite'],
      ['Pics/b.png', 'rename'],
    ]);
  });

  it('never offers Replace for notes, and Skip uploads nothing', async () => {
    seedTree(['Pics/Plan.md']);
    const upload = vi.spyOn(api, 'uploadRaw');
    const done = uploadToFolder('Pics', [new File(['x'], 'plan.md', { type: 'text/markdown' })]);
    const { dialog, resolve } = await answer('skip');
    expect(dialog.choices.map((c) => c.id)).toEqual(['skip', 'rename']);
    resolve();
    await done;
    expect(upload).not.toHaveBeenCalled();
  });
});
