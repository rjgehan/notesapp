import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUnsavedProbe } from '../state/buildCheck';
import { resetConnectionState } from '../state/connection';
import { useUi } from '../state/ui';
import { ApiError, apiFetch, errorMessage, isStorageProblem, query, TransientError } from './client';

function respond(status: number, body: string | null, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

const problem = (code: string, status: number, extra: object = {}) =>
  JSON.stringify({ type: `urn:notesapp:problem:${code}`, title: code, status, code, detail: 'x', ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
  useUi.setState({ newBuildAvailable: false });
  resetConnectionState();
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a failure');
}

describe('apiFetch', () => {
  it('sends the client id, Accept and an Idempotency-Key', async () => {
    const fetch = respond(201, '{"ok":true}', { 'Content-Type': 'application/json' });
    vi.stubGlobal('fetch', fetch);
    await apiFetch('/api/files', { method: 'POST', json: { path: 'a.md' }, idempotencyKey: 'key-12345678' });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(headers['Idempotency-Key']).toBe('key-12345678');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"path":"a.md"}');
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal('fetch', respond(204, null));
    expect(await apiFetch('/api/trash/x', { method: 'DELETE' })).toBeUndefined();
  });

  it.each([
    ['a network error', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')))],
    ['an empty 502', respond(502, '')],
    ['a 504', respond(504, 'gateway', { 'Content-Type': 'text/plain' })],
    ['a non-problem 503', respond(503, '<html></html>', { 'Content-Type': 'text/html' })],
    ['a 200 that is not JSON', respond(200, '<html></html>', { 'Content-Type': 'text/html' })],
  ])('classifies %s as transient', async (_name, fetch) => {
    vi.stubGlobal('fetch', fetch);
    expect(await failure(apiFetch('/api/tree'))).toBeInstanceOf(TransientError);
  });

  it('classifies a 2xx JSON body cut off mid-stream, or empty, as transient (FE-11)', async () => {
    const truncated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"file":{"pa'));
        controller.error(new TypeError('network error'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(truncated, { status: 200, headers: { 'Content-Type': 'application/json' } })));
    expect(await failure(apiFetch('/api/files'))).toBeInstanceOf(TransientError);
    vi.stubGlobal('fetch', respond(200, '', { 'Content-Type': 'application/json' }));
    expect(await failure(apiFetch('/api/files'))).toBeInstanceOf(TransientError);
  });

  it('treats 503 busy as transient and honours Retry-After', async () => {
    vi.stubGlobal('fetch', respond(503, problem('busy', 503), { 'Content-Type': 'application/problem+json', 'Retry-After': '2' }));
    const e = (await failure(apiFetch('/api/files'))) as TransientError;
    expect(e).toBeInstanceOf(TransientError);
    expect(e.retryAfterMs).toBe(2000);
  });

  it('turns other problems into ApiError', async () => {
    vi.stubGlobal('fetch', respond(409, problem('version-conflict', 409, { currentVersion: 'v2' }), { 'Content-Type': 'application/problem+json' }));
    const e = (await failure(apiFetch('/api/files'))) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.problem).toMatchObject({ code: 'version-conflict', currentVersion: 'v2' });
  });

  it('recognizes server storage problems', async () => {
    vi.stubGlobal('fetch', respond(500, problem('io-error', 500, { incidentId: 'abc' }), { 'Content-Type': 'application/problem+json' }));
    const e = await failure(apiFetch('/api/files'));
    expect(isStorageProblem(e)).toBe(true);
    expect(errorMessage(e)).toContain('incident abc');
  });

  it('goes offline after three consecutive transient failures', async () => {
    vi.stubGlobal('fetch', respond(502, ''));
    for (let i = 0; i < 3; i++) await failure(apiFetch('/api/tree'));
    expect(useUi.getState().connection).toBe('offline');
  });

  it('shows the new-version banner on a build mismatch while edits are unsaved', async () => {
    setUnsavedProbe(() => true);
    vi.stubGlobal('fetch', respond(200, '{}', { 'Content-Type': 'application/json', 'X-Notes-Build': 'abc1234' }));
    await apiFetch('/api/me');
    expect(useUi.getState().newBuildAvailable).toBe(true);
  });
});

describe('query', () => {
  it('encodes + as %2B and skips missing values', () => {
    expect(query({ path: 'Projects/Plan B + notes.md', v: undefined, n: 2 })).toBe('?path=Projects%2FPlan%20B%20%2B%20notes.md&n=2');
  });
});
