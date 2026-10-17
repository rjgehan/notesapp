// Transient notifications (aria-live polite), with an optional action such as Undo.
import { create } from 'zustand';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
  action?: ToastAction;
  /** ms; 0 keeps it until dismissed. */
  timeout: number;
}

interface ToastState {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  push(toast) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== toast.message), { ...toast, id }].slice(-4) }));
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(message: string, opts: { kind?: Toast['kind']; action?: ToastAction; timeout?: number } = {}): number {
  return useToasts.getState().push({
    message,
    kind: opts.kind ?? 'info',
    action: opts.action,
    timeout: opts.timeout ?? (opts.action ? 8000 : 4000),
  });
}
