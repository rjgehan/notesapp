import { ApiError } from '../client';
import type { ErrorCode, Problem } from '../types';

const TABLE: Record<ErrorCode, [number, string]> = {
  'bad-request': [400, 'Bad request'],
  'invalid-path': [400, 'Invalid path'],
  'invalid-name': [400, 'Invalid name'],
  'move-into-self': [400, 'Cannot move a folder into itself'],
  'client-id-required': [403, 'Client id required'],
  'cross-origin': [403, 'Cross-origin request rejected'],
  'identity-not-allowed': [403, 'Identity not allowed'],
  'reserved-path': [403, 'Reserved path'],
  'not-found': [404, 'Not found'],
  'method-not-allowed': [405, 'Method not allowed'],
  'already-exists': [409, 'Already exists'],
  'case-collision': [409, 'Name differs only by case'],
  'type-mismatch': [409, 'Wrong entry type'],
  'version-conflict': [409, 'Version conflict'],
  'settings-read-only': [409, 'Settings are read-only'],
  'task-conflict': [409, 'Task changed on the server'],
  'malformed-file': [409, 'File cannot be read'],
  'too-large': [413, 'Too large'],
  'not-text': [415, 'Not a text file'],
  'unsupported-media-type': [415, 'Unsupported media type'],
  'unknown-host': [421, 'Unknown host'],
  'io-error': [500, 'Storage error'],
  'permission-denied': [500, 'Permission denied'],
  'internal-error': [500, 'Internal error'],
  busy: [503, 'Busy, retry'],
  'history-unavailable': [503, 'History unavailable'],
  'insufficient-storage': [507, 'Insufficient storage'],
  'not-audio': [415, 'Not an audio or video file'],
  'transcription-off': [409, 'Transcription is off'],
  'transcription-failed': [503, 'Transcription failed'],
};

/** Builds and throws the server's problem document for `code` (API.md §3). */
export function fail(code: ErrorCode, detail: string, extra: Partial<Problem> & Record<string, unknown> = {}): never {
  const [status, title] = TABLE[code];
  const problem = { type: `urn:notesapp:problem:${code}`, title, status, detail, code, ...extra } as Problem;
  throw new ApiError(problem);
}
