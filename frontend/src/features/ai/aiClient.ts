// HTTP for Ask your vault and summaries (API.md §20). The answers stream as server-sent events on
// the POST response, read from fetch's body; refusals before the stream starts are ordinary problem
// documents (ApiError), network failures TransientError, as everywhere else (API.md §3).
import { ApiError, TransientError, apiFetch } from '../../api/client';
import type { AiAskRequest, AiStatus, AiStreamEventMap, AiSummarizeRequest, Problem } from '../../api/types';
import { reportServerBuild } from '../../state/buildCheck';
import { clientId } from '../../state/clientId';
import { createSseParser } from './sse';

export function fetchAiStatus(): Promise<AiStatus> {
  return apiFetch<AiStatus>('/api/ai/status');
}

export type AiStreamHandlers = { [K in keyof AiStreamEventMap]?: (data: AiStreamEventMap[K]) => void };

export type AiRequest = { url: '/api/ai/ask'; body: AiAskRequest } | { url: '/api/ai/summarize'; body: AiSummarizeRequest };

/**
 * Sends the request and calls the handlers as the events arrive. Resolves once the stream ends
 * with `done` or `error`; a stream that ends without either was cut off (a deploy, a dropped
 * connection) and rejects with a TransientError. Aborting the signal stops the answer on the server
 * too, since it notices the closed connection.
 */
export async function streamAi(request: AiRequest, handlers: AiStreamHandlers, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        'X-Client-Id': clientId,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/problem+json',
      },
      body: JSON.stringify(request.body),
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new TransientError(e instanceof Error ? e.message : 'Network error');
  }
  reportServerBuild(res.headers.get('X-Notes-Build'));
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!res.ok) {
    if (type === 'application/problem+json' || type === 'application/json') {
      const problem = (await res.json().catch(() => null)) as Problem | null;
      if (problem && typeof problem.code === 'string') {
        if (problem.code === 'busy') throw new TransientError(problem.detail || 'Server busy', res.status, 1000);
        throw new ApiError(problem);
      }
    }
    throw new TransientError(`HTTP ${res.status}`, res.status);
  }
  if (type !== 'text/event-stream' || !res.body) throw new TransientError(`Unexpected response type "${type || 'none'}"`, res.status);

  let finished = false;
  const parser = createSseParser(({ event, data }) => {
    if (!(event in EVENT_NAMES)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'done' || event === 'error') finished = true;
    const handler = handlers[event as keyof AiStreamEventMap] as ((d: unknown) => void) | undefined;
    handler?.(parsed);
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new TransientError('The answer was cut off');
  }
  if (!finished) throw new TransientError('The answer was cut off');
}

const EVENT_NAMES: Record<keyof AiStreamEventMap, true> = { start: true, delta: true, restart: true, done: true, error: true };
