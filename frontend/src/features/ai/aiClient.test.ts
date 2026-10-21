import { describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../../api/client';
import { streamAi } from './aiClient';

function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' }, ...init });
}

const ask = { url: '/api/ai/ask' as const, body: { question: 'Budget?' } };

describe('streamAi (API.md §20)', () => {
  it('posts the request with the client id and streams the events to the handlers', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        'event:start\ndata:{"model":"claude-sonnet-5-5","sources":[{"path":"A.md","chars":10,"truncated":false}],"omitted":0,"excluded":1}\n\n',
        'event:delta\ndata:{"text":"It is "}\n\nevent:del',
        'ta\ndata:{"text":"12k [[A]]"}\n\n',
        'event:done\ndata:{"model":"claude-sonnet-5-5","stopReason":"end_turn","refusalCategory":null,"fellBack":false,"usage":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":0,"cacheCreationInputTokens":0},"costUsd":0.01,"monthCostUsd":0.5}\n\n',
      ]),
    );
    const text: string[] = [];
    const start = vi.fn();
    const done = vi.fn();
    await streamAi(ask, { start, delta: (d) => text.push(d.text), done }, undefined, fetchImpl as unknown as typeof fetch);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ excluded: 1 }));
    expect(text.join('')).toBe('It is 12k [[A]]');
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.01 }));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ai/ask');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(headers.Accept).toContain('text/event-stream');
    expect(JSON.parse(init.body as string)).toEqual({ question: 'Budget?' });
  });

  it('turns a problem document into an ApiError', async () => {
    const problem = { type: 'urn:notesapp:problem:ai-unavailable', title: 'x', status: 409, code: 'ai-unavailable', reason: 'off', detail: 'off' };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(problem), { status: 409, headers: { 'Content-Type': 'application/problem+json' } }));
    await expect(streamAi(ask, {}, undefined, fetchImpl as unknown as typeof fetch)).rejects.toSatisfy((e) => e instanceof ApiError && e.problem.code === 'ai-unavailable');
  });

  it('reports a stream that ends without done or error as cut off', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(['event:delta\ndata:{"text":"par"}\n\n']));
    await expect(streamAi(ask, {}, undefined, fetchImpl as unknown as typeof fetch)).rejects.toSatisfy((e) => e instanceof TransientError && e.message === 'The answer was cut off');
  });

  it('an error event ends the stream normally', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(['event:start\ndata:{"model":"m","sources":[],"omitted":0,"excluded":0}\n\nevent:error\ndata:{"code":"auth","message":"Bad key"}\n\n']));
    const error = vi.fn();
    await streamAi(ask, { error }, undefined, fetchImpl as unknown as typeof fetch);
    expect(error).toHaveBeenCalledWith({ code: 'auth', message: 'Bad key' });
  });

  it('a network failure is transient and an abort is an AbortError', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(streamAi(ask, {}, undefined, failing as unknown as typeof fetch)).rejects.toBeInstanceOf(TransientError);
    const aborting = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(streamAi(ask, {}, undefined, aborting as unknown as typeof fetch)).rejects.toSatisfy((e) => e instanceof DOMException && e.name === 'AbortError');
  });
});
