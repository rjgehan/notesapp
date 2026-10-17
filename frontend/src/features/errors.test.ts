import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, TransientError } from '../api/client';
import { useToasts } from '../state/toasts';
import { OFFLINE_ACTION_MESSAGE, toastError } from './errors';

const last = () => useToasts.getState().toasts.at(-1);

beforeEach(() => useToasts.setState({ toasts: [] }));

describe('toastError (DESIGN §6.20)', () => {
  it('never shows an error toast for a transient failure', () => {
    toastError(new TransientError('HTTP 502', 502));
    expect(last()).toMatchObject({ kind: 'info', message: OFFLINE_ACTION_MESSAGE });
  });

  it('shows the friendly text of a problem code, with the subject first', () => {
    toastError(new ApiError({ type: 'urn:notesapp:problem:invalid-name', title: 'Invalid name', status: 400, code: 'invalid-name' }), 'a#b.md');
    expect(last()).toMatchObject({ kind: 'error', message: "a#b.md: Names can't contain # ^ [ ] | or %%." });
  });

  it('adds the incident id of a server error', () => {
    toastError(new ApiError({ type: 'urn:notesapp:problem:internal-error', title: 'Internal error', status: 500, code: 'internal-error', detail: 'Boom', incidentId: 'inc-42' }));
    expect(last()).toMatchObject({ kind: 'error', message: 'Boom · incident inc-42' });
  });
});
