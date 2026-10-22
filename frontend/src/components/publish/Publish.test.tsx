import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import type { PublishedNote, PublishResponse } from '../../api/types';
import { openPublishDialog, publishedNote, slugError, suggestSlug, usePublishDialog } from '../../features/publish';
import { useDialogs } from '../../state/dialogs';
import { PublishButton } from './PublishButton';
import { PublishDialog } from './PublishDialog';
import { PublishSettings } from './PublishSettings';

const note = (over: Partial<PublishedNote> = {}): PublishedNote => ({
  path: 'Blog/Hello.md',
  slug: 'hello',
  title: 'Hello',
  url: 'https://notes.example.ts.net:8443/p/hello',
  publishedAt: '2026-10-21T10:00:00.000Z',
  state: 'current',
  ...over,
});

const response = (over: Partial<PublishResponse> = {}): PublishResponse => ({ enabled: true, baseUrl: 'https://notes.example.ts.net:8443', notes: [], ...over });

function wrap(children: React.ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

describe('publishing helpers (ROADMAP item 26)', () => {
  it('checks addresses like the server and suggests one from the title', () => {
    expect(slugError('')).toBeNull();
    expect(slugError('my-post-2')).toBeNull();
    expect(slugError('My Post')).not.toBeNull();
    expect(slugError('-edge')).not.toBeNull();
    expect(slugError('../x')).not.toBeNull();
    expect(slugError('a'.repeat(81))).not.toBeNull();
    expect(suggestSlug('Café  déjà-vu!')).toBe('cafe-deja-vu');
    expect(suggestSlug('日本語')).toBe('');
  });

  it('finds the published entry of a path', () => {
    expect(publishedNote(response({ notes: [note()] }), 'Blog/Hello.md')?.slug).toBe('hello');
    expect(publishedNote(response({ notes: [note()] }), 'Other.md')).toBeNull();
    expect(publishedNote(undefined, 'Blog/Hello.md')).toBeNull();
  });
});

describe('publish dialog', () => {
  beforeEach(() => queryClient.clear());
  afterEach(() => {
    act(() => usePublishDialog.getState().close());
    vi.restoreAllMocks();
  });

  it('publishes a note with the chosen title and address', async () => {
    vi.spyOn(api, 'getPublish').mockResolvedValue(response());
    const publish = vi.spyOn(api, 'publishNote').mockResolvedValue(note({ slug: 'greeting', title: 'Greeting' }));
    wrap(<PublishDialog />);
    act(() => openPublishDialog('Blog/Hello.md'));
    expect(await screen.findByText(/Anyone with the link can read a copy/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Greeting' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Bad Address' } });
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'greeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith({ path: 'Blog/Hello.md', title: 'Greeting', slug: 'greeting' }));
    await waitFor(() => expect(usePublishDialog.getState().path).toBeNull());
  });

  it('says publishing is off and offers no publish button', async () => {
    vi.spyOn(api, 'getPublish').mockResolvedValue(response({ enabled: false, baseUrl: null }));
    wrap(<PublishDialog />);
    act(() => openPublishDialog('Blog/Hello.md'));
    expect(await screen.findByText(/Public publishing is off on this server/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows a published note’s link and state, and unpublishes after confirming', async () => {
    vi.spyOn(api, 'getPublish').mockResolvedValue(response({ notes: [note({ state: 'changed' })] }));
    const unpublish = vi.spyOn(api, 'unpublishNote').mockResolvedValue();
    wrap(<PublishDialog />);
    act(() => openPublishDialog('Blog/Hello.md'));
    expect(await screen.findByText('https://notes.example.ts.net:8443/p/hello')).toBeInTheDocument();
    expect(screen.getByText(/Changed since publishing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Republish' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(useDialogs.getState().stack.length).toBeGreaterThan(0));
    act(() => {
      const request = useDialogs.getState().stack[0];
      if (request.kind === 'confirm') request.resolve(true);
    });
    await waitFor(() => expect(unpublish).toHaveBeenCalledWith('Blog/Hello.md'));
  });
});

describe('Settings › Publishing and the header button', () => {
  beforeEach(() => queryClient.clear());
  afterEach(() => vi.restoreAllMocks());

  it('lists published notes with their state', async () => {
    vi.spyOn(api, 'getPublish').mockResolvedValue(
      response({ notes: [note(), note({ path: 'Gone.md', slug: 'gone', title: 'Gone', state: 'source-missing' })] }),
    );
    wrap(<PublishSettings />);
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.getByText('Note no longer exists')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Unpublish/ })).toHaveLength(2);
    // A note that is gone cannot be opened or republished, only unpublished.
    expect(screen.getAllByRole('button', { name: /Republish/ })).toHaveLength(1);
  });

  it('explains that publishing is off when it is', async () => {
    vi.spyOn(api, 'getPublish').mockResolvedValue(response({ enabled: false }));
    wrap(<PublishSettings />);
    expect(await screen.findByText(/Public publishing is off on this server/)).toBeInTheDocument();
    expect(screen.getByText('No notes are published.')).toBeInTheDocument();
  });

  it('shows the globe only while publishing is on or for a published note', async () => {
    vi.spyOn(api, 'getPublish').mockResolvedValue(response({ enabled: false }));
    const { container } = wrap(<PublishButton path="Blog/Hello.md" />);
    await waitFor(() => expect(api.getPublish).toHaveBeenCalled());
    expect(container.querySelector('.publish-toggle')).toBeNull();
    queryClient.clear();
    vi.spyOn(api, 'getPublish').mockResolvedValue(response({ enabled: false, notes: [note()] }));
    wrap(<PublishButton path="Blog/Hello.md" />);
    expect(await screen.findByRole('button', { name: 'Published: Up to date' })).toBeInTheDocument();
  });
});
