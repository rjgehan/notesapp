// Public publishing (ROADMAP item 26, DESIGN §5.28): the published-notes query, the publish
// dialog's target, and the publish / unpublish / copy-link actions. The server renders the
// snapshot; nothing here decides what a public page contains.
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '../api/endpoints';
import { queryClient } from '../api/queryClient';
import { queryKeys, STALE } from '../api/queryKeys';
import type { PublishedNote, PublishRequest, PublishResponse } from '../api/types';
import { toast } from '../state/toasts';
import { confirmAction } from '../state/dialogs';
import { toastError } from './errors';

export function usePublish() {
  return useQuery({ queryKey: queryKeys.publish(), queryFn: () => api.getPublish(), staleTime: STALE.publish });
}

/** The published entry of `path`, if any. */
export function publishedNote(data: PublishResponse | undefined, path: string | null): PublishedNote | null {
  if (!data || path === null) return null;
  return data.notes.find((n) => n.path === path) ?? null;
}

/** The note the publish dialog is open for. */
export const usePublishDialog = create<{ path: string | null; open(path: string): void; close(): void }>()((set) => ({
  path: null,
  open: (path) => set({ path }),
  close: () => set({ path: null }),
}));

export function openPublishDialog(path: string): void {
  usePublishDialog.getState().open(path);
}

/** Slugs the server accepts: lower-case letters, digits and inner hyphens, 1 to 80 characters. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export function slugError(slug: string): string | null {
  if (slug === '') return null; // the server picks one
  return SLUG_PATTERN.test(slug) ? null : 'Use lower-case letters, digits and hyphens (not at either end), at most 80.';
}

/** What the server would make of a title when no address is given (mirrors PublishService.slugify). */
export function suggestSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function refresh(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.publish() });
}

export async function publishNote(req: PublishRequest): Promise<PublishedNote | null> {
  try {
    const note = await api.publishNote(req);
    await refresh();
    toast(`Published at ${note.url}`);
    return note;
  } catch (e) {
    toastError(e, 'Could not publish');
    return null;
  }
}

/** Asks first: the public page disappears at once. */
export async function unpublishNote(note: PublishedNote): Promise<boolean> {
  const ok = await confirmAction({
    title: 'Unpublish note',
    message: `“${note.title}” will no longer be public at ${note.url}. The note itself is not changed.`,
    confirmLabel: 'Unpublish',
    danger: true,
  });
  if (!ok) return false;
  try {
    await api.unpublishNote(note.path);
    await refresh();
    toast('Unpublished');
    return true;
  } catch (e) {
    toastError(e, 'Could not unpublish');
    return false;
  }
}

export async function copyPublicLink(note: PublishedNote): Promise<void> {
  try {
    await navigator.clipboard.writeText(note.url);
    toast(note.url.startsWith('/') ? 'Path copied (set NOTES_PUBLISH_BASE_URL for full links)' : 'Public link copied');
  } catch {
    toast('The browser refused clipboard access', { kind: 'error' });
  }
}

export const STATE_LABELS: Record<PublishedNote['state'], string> = {
  current: 'Up to date',
  changed: 'Changed since publishing',
  'source-missing': 'Note no longer exists',
  'snapshot-missing': 'Page missing; republish',
};
