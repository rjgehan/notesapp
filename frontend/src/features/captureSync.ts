// Quick capture at runtime (DESIGN §6.27): a capture is queued on the device, then sent; the queue
// is sent again when the connection returns (the stream catches up, the browser goes online) and
// at startup. One tab sends at a time (Web Locks); the idempotency keys make overlaps harmless.
import { create } from 'zustand';
import { api } from '../api/endpoints';
import type { CaptureResult } from '../api/types';
import { OFFLINE_DB } from '../offline/db';
import { flushQueue, IdbCaptureQueue, MemoryCaptureQueue, type CaptureQueueStore, type QueuedCapture } from '../offline/captureQueue';
import { newIdempotencyKey } from '../state/clientId';
import { toast } from '../state/toasts';
import { vaultKey } from '../state/vault';
import { useUi } from '../state/ui';
import { applyCaptureResult } from '../sync/applyEvents';
import { documents } from '../sync/instance';
import { syncTarget } from '../sync/liveSync';
import { captureRequest, rememberTarget, targetLabel, type CaptureInput } from './capture';
import { dayjs } from './dates';
import { navigateTo, openPath } from './navigation';
import { displayName } from './paths';

export interface CaptureQueueState {
  /** Captures waiting for the server. */
  waiting: number;
  /** Captures the server refused (Settings › Quick capture lists them). */
  failed: QueuedCapture[];
  set(state: Partial<Pick<CaptureQueueState, 'waiting' | 'failed'>>): void;
}

export const useCaptureQueue = create<CaptureQueueState>()((set) => ({
  waiting: 0,
  failed: [],
  set: (state) => set(state),
}));

export const captureQueue: CaptureQueueStore = typeof indexedDB === 'undefined' ? new MemoryCaptureQueue() : new IdbCaptureQueue(indexedDB, vaultKey(OFFLINE_DB));

const FLUSH_SESSIONS_MS = 3000;

async function refreshState(): Promise<void> {
  const all = await captureQueue.list().catch(() => []);
  useCaptureQueue.getState().set({ waiting: all.filter((i) => !i.error).length, failed: all.filter((i) => !!i.error) });
}

function send(item: QueuedCapture): Promise<CaptureResult> {
  const opts = { idempotencyKey: item.key };
  if (!item.file) return api.capture(item.request, opts);
  const { text, target, date, time, tz } = item.request;
  return api.captureFile(item.file.name, item.file.blob, { text, target, date, time, tz }, opts);
}

let flushing: Promise<SentSummary> | null = null;

interface SentSummary {
  sent: Array<{ item: QueuedCapture; result: CaptureResult }>;
  failed: QueuedCapture[];
  waiting: number;
}

const NOTHING: SentSummary = { sent: [], failed: [], waiting: 0 };

/** Ids of captures whose refusal the capture form reports itself (no toast). */
const reportedByForm = new Set<number>();

/** Sends the queue now; resolves with what went out. Never rejects. */
export function flushCaptures(): Promise<SentSummary> {
  flushing ??= (async (): Promise<SentSummary> => {
    try {
      const run = async () => {
        const pending = (await captureQueue.list()).filter((i) => !i.error);
        if (pending.length === 0) return NOTHING;
        // An open note the capture appends to must not be dirty here, or the append (which this
        // tab learns about from its own response) would put it into conflict with itself.
        await Promise.race([documents.flushAll(), new Promise((r) => setTimeout(r, FLUSH_SESSIONS_MS))]);
        const report = await flushQueue({ store: captureQueue, send, onSent: (result) => applyCaptureResult(syncTarget, result) });
        for (const f of report.failed) {
          if (f.id === undefined || !reportedByForm.has(f.id)) toast(`A capture could not be saved: ${f.error}`, { kind: 'error', action: { label: 'Review', run: () => navigateTo('/settings/capture') } });
        }
        return { sent: report.sent, failed: report.failed, waiting: report.waiting };
      };
      return typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request(vaultKey('notesapp-capture-queue'), run) : await run();
    } catch {
      return NOTHING;
    } finally {
      await refreshState();
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** The caption of a captured file: the text, then a shared page's title and link. */
export function fileCaption(text: string | null | undefined, title: string | null | undefined, url: string | null | undefined): string | null {
  const parts = [text, title && !(text ?? '').includes(title) ? title : null, url].filter((p): p is string => !!p && p.trim() !== '');
  return parts.join(' ') || null;
}

export type CaptureOutcome = { status: 'sent'; result: CaptureResult } | { status: 'queued' } | { status: 'failed'; error: string };

/**
 * Captures now: one entry for the text (and link), or one per file with the text as the first
 * file's caption. Stored on the device first, then sent.
 */
export async function submitCapture(input: CaptureInput, files: readonly File[] = []): Promise<CaptureOutcome> {
  rememberTarget(input.target);
  const request = captureRequest(input, dayjs());
  const at = Date.now();
  const items: QueuedCapture[] = files.length === 0
    ? [{ key: newIdempotencyKey(), request, at }]
    : files.map((file, i) => ({
        key: newIdempotencyKey(),
        // A file entry has no link of its own: a shared title and URL join the first caption.
        request: i === 0 ? { ...request, text: fileCaption(request.text, request.title, request.url), url: null, title: null } : { ...request, text: null, url: null, title: null },
        file: { name: file.name || 'capture', type: file.type, blob: file },
        at,
      }));
  const ids = await captureQueue.add(items);
  for (const id of ids) reportedByForm.add(id);
  try {
    const sent: CaptureResult[] = [];
    const failed: QueuedCapture[] = [];
    // A flush already running when these were queued did not see them: one more pass.
    for (let pass = 0; pass < 2 && sent.length + failed.length < ids.length; pass++) {
      const report = await flushCaptures();
      sent.push(...report.sent.filter((s) => s.item.id !== undefined && ids.includes(s.item.id)).map((s) => s.result));
      failed.push(...report.failed.filter((f) => f.id !== undefined && ids.includes(f.id)));
      if (report.waiting > 0) break;
    }
    if (failed.length > 0) {
      // Refused for good: the form keeps the text, so the queue does not.
      for (const f of failed) await captureQueue.remove(f.id!);
      await refreshState();
      return { status: 'failed', error: failed[0].error ?? 'The capture could not be saved' };
    }
    return sent.length === ids.length ? { status: 'sent', result: sent[0] } : { status: 'queued' };
  } finally {
    for (const id of ids) reportedByForm.delete(id);
  }
}

/** Tells the user where a capture went, with a way to open it. */
export function announceCapture(outcome: CaptureOutcome, input: Pick<CaptureInput, 'target'>): void {
  if (outcome.status === 'failed') return;
  if (outcome.status === 'queued') {
    toast(`Saved on this device; it goes to ${targetLabel(input.target)} when the connection returns`);
    return;
  }
  const path = outcome.result.file.path;
  toast(`Added to ${input.target === 'daily' ? displayName(path) : 'Inbox'}`, { action: { label: 'Open', run: () => openPath(path) } });
}

let installed = false;

/** Sends what is waiting at startup, when the event stream catches up and when the browser goes online. */
export function installCaptureSync(): void {
  if (installed) return;
  installed = true;
  const later = (): void => {
    void flushCaptures().then(({ sent }) => {
      if (sent.length > 0) toast(sent.length === 1 ? 'Added the capture you made offline' : `Added ${sent.length} captures you made offline`);
    });
  };
  useUi.subscribe((state, prev) => {
    if (state.caughtUp && !prev.caughtUp) later();
  });
  window.addEventListener('online', later);
  void refreshState().then(() => {
    if (useCaptureQueue.getState().waiting > 0 && useUi.getState().caughtUp) later();
  });
}

/** Settings › Quick capture: drop a refused capture (after copying its text). */
export async function discardFailedCapture(item: QueuedCapture): Promise<void> {
  if (item.id !== undefined) await captureQueue.remove(item.id);
  await refreshState();
}

/** Settings › Quick capture: try a refused capture again. */
export async function retryFailedCapture(item: QueuedCapture): Promise<void> {
  await captureQueue.put({ ...item, error: null });
  await flushCaptures();
}
