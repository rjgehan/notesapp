// Toast stack (aria-live polite), with an optional action such as Undo.
import { X } from 'lucide-react';
import { useEffect } from 'react';
import { useToasts, type Toast } from '../../state/toasts';

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    if (toast.timeout <= 0) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.timeout);
    return () => clearTimeout(timer);
  }, [toast.id, toast.timeout, dismiss]);
  return (
    <div className={`toast toast-${toast.kind}`}>
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
