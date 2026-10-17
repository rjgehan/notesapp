import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { api } from '../api/endpoints';
import { MockVault } from '../api/mock/vault';
import type { Problem } from '../api/types';
import { DocumentSession } from '../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../test/fakes';
import { ConflictBanner } from './ConflictBanner';
import ConflictCompare from './ConflictCompare';

function problem(p: Pick<Problem, 'code' | 'status'> & Partial<Problem>): ApiError {
  return new ApiError({ type: `urn:notesapp:problem:${p.code}`, title: p.code, ...p });
}

const sessions: DocumentSession[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

async function conflicted() {
  const vault = new MockVault(false);
  vault.createFile({ path: 'a.md', content: 'base' }, 'other-device-1');
  const fake = fakeApi(vault);
  const deps = sessionDeps(fake.api);
  const session = new DocumentSession('a.md', deps);
  sessions.push(session);
  await session.ready;
  session.applyEdit({ from: 4, insert: ' mine' });
  vault.externalWrite('a.md', 'base theirs');
  await session.onRemoteChanged({ version: vault.readFile('a.md').version });
  expect(session.getSnapshot().status).toBe('conflict');
  return { vault, fake, deps, session };
}

async function deleted(withEdits: boolean, trashId: string | null) {
  const vault = new MockVault(false);
  vault.createFile({ path: 'a.md', content: 'base' }, 'other-device-1');
  const fake = fakeApi(vault);
  const deps = sessionDeps(fake.api);
  const session = new DocumentSession('a.md', deps);
  sessions.push(session);
  await session.ready;
  if (withEdits) session.applyEdit({ from: 4, insert: ' mine' });
  vault.externalDelete('a.md');
  session.onRemoteDeleted(trashId);
  return { vault, fake, deps, session };
}

const lastSave = (fake: ReturnType<typeof fakeApi>) => fake.api.saveFile.mock.calls.at(-1)!;

describe('ConflictBanner', () => {
  it('shows nothing for a clean note', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'a.md', content: 'x' }, 'o');
    const session = new DocumentSession('a.md', sessionDeps(fakeApi(vault).api));
    sessions.push(session);
    await session.ready;
    const { container } = render(<ConflictBanner session={session} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Keep mine saves mine on top of theirs with flushHistory', async () => {
    const { fake, session, vault } = await conflicted();
    const theirsVersion = vault.readFile('a.md').version;
    render(<ConflictBanner session={session} />);
    expect(screen.getByRole('alert')).toHaveTextContent('changed on another device');
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(session.getSnapshot().status).toBe('clean'));
    expect(lastSave(fake)).toEqual(['a.md', { content: 'base mine', baseVersion: theirsVersion, flushHistory: true }]);
    expect(vault.readFile('a.md').content).toBe('base mine');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains a 503 history-unavailable on Keep mine and keeps my text', async () => {
    const { fake, session } = await conflicted();
    fake.failNext(() => {
      throw problem({ code: 'history-unavailable', status: 503, reason: 'commit-failed' });
    });
    render(<ConflictBanner session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await screen.findByText(/History is failing on the server, so Keep mine is blocked to protect the other version/);
    expect(session.getSnapshot().status).toBe('conflict');
    expect(session.getText()).toBe('base mine');
    expect(screen.getByRole('button', { name: /Copy my text/ })).toBeInTheDocument();
  });

  it('Take theirs replaces the buffer and keeps mine for Undo', async () => {
    const { deps, session } = await conflicted();
    render(<ConflictBanner session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take theirs' }));
    await waitFor(() => expect(session.getSnapshot().status).toBe('clean'));
    expect(session.getText()).toBe('base theirs');
    expect(deps.drafts.discarded.map((d) => d.text)).toEqual(['base mine']);
    expect(deps.notices.at(-1)).toMatch(/Replaced your version with theirs/);
  });

  it('Recreate with my text recreates a deleted note with flushHistory', async () => {
    const { fake, session, vault } = await deleted(true, null);
    render(<ConflictBanner session={session} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Deleted on another device');
    fireEvent.click(screen.getByRole('button', { name: /Recreate with my text/ }));
    await waitFor(() => expect(session.getSnapshot().status).toBe('clean'));
    expect(lastSave(fake)).toEqual(['a.md', { content: 'base mine', baseVersion: null, flushHistory: true }]);
    expect(vault.readFile('a.md').content).toBe('base mine');
  });

  it('Discard turns the banner into a tombstone and stores my text', async () => {
    const { deps, session } = await deleted(true, null);
    render(<ConflictBanner session={session} />);
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    await screen.findByText('Deleted on another device.');
    expect(screen.queryByRole('button', { name: /Recreate/ })).toBeNull();
    expect(deps.drafts.discarded.map((d) => d.text)).toEqual(['base mine']);
    expect(session.hasUnsavedChanges()).toBe(false);
  });

  it('the tombstone of a note trashed elsewhere offers Restore through its trash id', async () => {
    const { session } = await deleted(false, '01JA7Q3M9K2Z');
    const restore = vi.spyOn(api, 'restoreTrash').mockRejectedValue(problem({ code: 'not-found', status: 404 }));
    render(<ConflictBanner session={session} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Moved to trash on another device.');
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('01JA7Q3M9K2Z'));
    expect(screen.getByRole('button', { name: /Close/ })).toBeInTheDocument();
  });
});

describe('ConflictCompare', () => {
  it('Save merged sends the compared document with flushHistory', async () => {
    const { fake, session, vault } = await conflicted();
    const theirsVersion = vault.readFile('a.md').version;
    const onClose = vi.fn();
    render(<ConflictCompare session={session} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: /Compare/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save merged' }));
    });
    await waitFor(() => expect(session.getSnapshot().status).toBe('clean'));
    expect(lastSave(fake)).toEqual(['a.md', { content: 'base mine', baseVersion: theirsVersion, flushHistory: true }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('a rejected chunk takes their text into the merge', async () => {
    const { fake, session } = await conflicted();
    render(<ConflictCompare session={session} onClose={() => {}} />);
    const reject = document.querySelector<HTMLButtonElement>('.cm-deletedChunk button[name="reject"]');
    expect(reject).not.toBeNull();
    fireEvent.mouseDown(reject!);
    fireEvent.click(reject!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save merged' }));
    });
    await waitFor(() => expect(session.getSnapshot().status).toBe('clean'));
    expect(lastSave(fake)[1]).toMatchObject({ content: 'base theirs', flushHistory: true });
  });

  it('offers the view merge() result first when the base is known', async () => {
    const { session } = await conflicted();
    const merge = vi.fn((base: string, mine: string, theirs: string) => `${base}|${mine}|${theirs}`);
    render(<ConflictCompare session={session} merge={merge} onClose={() => {}} />);
    expect(merge).toHaveBeenCalledWith('base', 'base mine', 'base theirs');
    expect(screen.getByText(/Merged automatically/)).toBeInTheDocument();
    expect(document.querySelector('.cm-content')?.textContent).toContain('base|base mine|base theirs');
  });
});
