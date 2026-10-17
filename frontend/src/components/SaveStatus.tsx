// Save-status pill (DESIGN §6.9): Saved ✓ · Saving… · Unsaved · Offline · Server storage error · Conflict.
import { Check, CloudOff, LoaderCircle, Lock, TriangleAlert, CircleAlert, Pencil, Trash } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SessionSnapshot } from '../sync/DocumentSession';

const LABELS: Record<SessionSnapshot['status'], { text: string; icon: ReactNode; tone: string }> = {
  loading: { text: 'Loading…', icon: <LoaderCircle size={13} className="spin" />, tone: 'muted' },
  clean: { text: 'Saved', icon: <Check size={13} />, tone: 'success' },
  dirty: { text: 'Unsaved', icon: <Pencil size={13} />, tone: 'muted' },
  saving: { text: 'Saving…', icon: <LoaderCircle size={13} className="spin" />, tone: 'muted' },
  offline: { text: 'Offline', icon: <CloudOff size={13} />, tone: 'warning' },
  'storage-error': { text: 'Server storage error', icon: <TriangleAlert size={13} />, tone: 'error' },
  conflict: { text: 'Conflict', icon: <CircleAlert size={13} />, tone: 'error' },
  deleted: { text: 'Deleted', icon: <Trash size={13} />, tone: 'warning' },
  readonly: { text: 'Read-only', icon: <Lock size={13} />, tone: 'muted' },
  error: { text: 'Not saved', icon: <TriangleAlert size={13} />, tone: 'error' },
};

const TITLES: Partial<Record<SessionSnapshot['status'], string>> = {
  offline: 'Offline: changes kept on this device',
  'storage-error': 'The server could not store the note; retrying',
  conflict: 'The note changed on another device',
};

export function SaveStatus({ snapshot, compact = false }: { snapshot: SessionSnapshot; compact?: boolean }) {
  const label = LABELS[snapshot.status];
  const title = snapshot.error ?? TITLES[snapshot.status] ?? label.text;
  return (
    <span className={`save-status tone-${label.tone}${compact ? ' is-compact' : ''}`} role="status" aria-live="polite" title={title}>
      {label.icon}
      <span className={compact ? 'visually-hidden' : 'save-status-text'}>{label.text}</span>
    </span>
  );
}
