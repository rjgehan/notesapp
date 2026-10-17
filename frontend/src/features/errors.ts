// Error toasts for user actions (DESIGN §6.20). A transient failure never shows an error toast:
// the connection indicator shows the Offline state, and a neutral notice says the action did not
// happen. Everything else shows the friendly text of its problem code.
import { errorMessage, isTransient } from '../api/client';
import { toast } from '../state/toasts';

export const OFFLINE_ACTION_MESSAGE = "You're offline. Try again when the connection returns.";

/** Reports a failed action; `subject` (a file name) prefixes the message. */
export function toastError(e: unknown, subject?: string): void {
  const prefix = subject ? `${subject}: ` : '';
  if (isTransient(e)) {
    toast(prefix + OFFLINE_ACTION_MESSAGE);
    return;
  }
  toast(prefix + errorMessage(e), { kind: 'error' });
}
