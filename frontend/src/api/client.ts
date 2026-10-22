// HTTP client for /api (API.md §2, §3). Every failure is classified as an ApiError (a problem
// document: handled by the flow that made the request) or a TransientError (keep data, retry).
import { reportServerBuild } from '../state/buildCheck';
import { clientId } from '../state/clientId';
import { noteServerAnswer, noteTransientFailure } from '../state/connection';
import type { ErrorCode, Problem, VersionConflictProblem } from './types';

/** A problem+json response (API.md §3). Branch on `problem.code`, never on `detail`. */
export class ApiError extends Error {
  readonly problem: Problem;
  readonly status: number;

  constructor(problem: Problem) {
    super(problem.detail || problem.title || problem.code);
    this.name = 'ApiError';
    this.problem = problem;
    this.status = problem.status;
  }
}

/** Network errors, 502/504, non-problem 503, `busy`, and non-JSON responses (API.md §3, transient class). */
export class TransientError extends Error {
  readonly status: number | null;
  /** From `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'TransientError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isProblem(e: unknown, code: ErrorCode): e is ApiError {
  return e instanceof ApiError && e.problem.code === code;
}

export function isVersionConflict(e: unknown): e is ApiError & { problem: VersionConflictProblem } {
  return isProblem(e, 'version-conflict');
}

const STORAGE_CODES: ReadonlySet<ErrorCode> = new Set(['io-error', 'internal-error', 'permission-denied', 'insufficient-storage']);

/** Server storage problems: keep the data and the draft, retry with backoff, show a storage error. */
export function isStorageProblem(e: unknown): e is ApiError {
  return e instanceof ApiError && STORAGE_CODES.has(e.problem.code);
}

export function isTransient(e: unknown): e is TransientError {
  return e instanceof TransientError;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body. */
  json?: unknown;
  /** Raw body (uploads). */
  body?: Blob | ArrayBuffer;
  contentType?: string;
  idempotencyKey?: string;
  keepalive?: boolean;
  signal?: AbortSignal;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function mediaType(res: Response): string {
  return (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
}

/** Performs a request under /api and returns the parsed JSON body (undefined for 204). */
export async function apiFetch<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'X-Client-Id': clientId,
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = opts.contentType || 'application/octet-stream';
    body = opts.body;
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body,
      keepalive: opts.keepalive,
      signal: opts.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    noteTransientFailure();
    throw new TransientError(e instanceof Error ? e.message : 'Network error');
  }

  reportServerBuild(res.headers.get('X-Notes-Build'));
  const type = mediaType(res);
  const isJson = type === 'application/json' || type === 'application/problem+json';
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));

  if (res.ok) {
    if (res.status === 204) {
      noteServerAnswer();
      return undefined as T;
    }
    if (!isJson) {
      noteTransientFailure();
      throw new TransientError(`Unexpected response type "${type || 'none'}"`, res.status, retryAfter);
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      // A body cut off mid-stream (a deploy, a dropped connection) or an empty JSON body is a
      // network failure like any other (API.md §3): the caller keeps its data and retries.
      noteTransientFailure();
      throw new TransientError(`HTTP ${res.status} with an unreadable body`, res.status, retryAfter);
    }
    noteServerAnswer();
    return data;
  }

  if (res.status === 502 || res.status === 504 || !isJson) {
    noteTransientFailure();
    throw new TransientError(`HTTP ${res.status}`, res.status, retryAfter);
  }
  let problem: Problem;
  try {
    problem = (await res.json()) as Problem;
  } catch {
    noteTransientFailure();
    throw new TransientError(`HTTP ${res.status} with an unreadable body`, res.status, retryAfter);
  }
  if (!problem || typeof problem.code !== 'string') {
    if (res.status === 503) {
      noteTransientFailure();
      throw new TransientError('Service unavailable', res.status, retryAfter);
    }
    problem = { type: 'about:blank', title: res.statusText, status: res.status, code: 'internal-error', detail: `HTTP ${res.status}` };
  }
  if (problem.code === 'busy') {
    noteTransientFailure();
    throw new TransientError(problem.detail || 'Server busy', res.status, retryAfter ?? 1000);
  }
  noteServerAnswer();
  throw new ApiError(problem);
}

/** Query-string builder that encodes every value with encodeURIComponent (API.md §1.3: `+` must be `%2B`). */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

const FRIENDLY: Partial<Record<ErrorCode, string>> = {
  'invalid-name': "Names can't contain # ^ [ ] | or %%.",
  'case-collision': 'A file with the same name (different case) already exists.',
  'too-large': 'This file is too large to edit here; download it instead.',
  'history-unavailable': 'History is not available on the server',
  'permission-denied': 'The server cannot write to this folder. It may have been created as another user over SSH.',
  'insufficient-storage': 'The server is low on disk space.',
  'identity-not-allowed': "This device's Tailscale login is not allowed to use NotesApp.",
  'settings-read-only': 'Settings were written by a newer version of NotesApp and are read-only here.',
  'block-not-found': 'That block changed in the meantime. Type the link again to pick it.',
};

/** User-facing text for an error (DESIGN §6.20). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const p = e.problem;
    let text = FRIENDLY[p.code] ?? p.detail ?? p.title;
    if (p.code === 'history-unavailable' && p.reason) text += ` (${p.reason})`;
    if (p.code === 'permission-denied' && p.path) text += ` (${p.path})`;
    if (p.status >= 500 && p.incidentId) text += ` · incident ${p.incidentId}`;
    return text;
  }
  if (e instanceof TransientError) return 'Offline: changes kept on this device';
  return e instanceof Error ? e.message : String(e);
}
