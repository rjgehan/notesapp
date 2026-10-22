// Settings › Publishing (ROADMAP item 26, DESIGN §5.28): whether public publishing is on, and every
// published note with its public link, state, republish and unpublish.
import { FileText, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import type { PublishedNote } from '../../api/types';
import { formatRelative } from '../../features/format';
import { openPath } from '../../features/navigation';
import { publishNote, STATE_LABELS, unpublishNote, usePublish } from '../../features/publish';
import { PublishedLink, PublishOffNotice } from './PublishDialog';
import '../../styles/publish.css';

function PublishedRow({ note, enabled }: { note: PublishedNote; enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="published-row">
      <div className="published-head">
        <strong>{note.title}</strong>
        <span className={`publish-state publish-state-${note.state}`}>{STATE_LABELS[note.state]}</span>
      </div>
      <PublishedLink note={note} />
      <div className="published-meta muted">
        {note.path} · published {formatRelative(note.publishedAt)}
      </div>
      <div className="published-actions">
        {note.state !== 'source-missing' && (
          <button type="button" className="button" onClick={() => openPath(note.path)}>
            <FileText size={14} aria-hidden /> Open note
          </button>
        )}
        {enabled && note.state !== 'source-missing' && (
          <button type="button" className="button" disabled={busy} onClick={() => void run(() => publishNote({ path: note.path }))}>
            <RefreshCw size={14} aria-hidden /> Republish
          </button>
        )}
        <button type="button" className="button button-danger" disabled={busy} onClick={() => void run(() => unpublishNote(note))}>
          <Trash2 size={14} aria-hidden /> Unpublish
        </button>
      </div>
    </li>
  );
}

export function PublishSettings() {
  const query = usePublish();
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="field-error">{errorMessage(query.error)}</p>;
  const { enabled, notes } = query.data;
  return (
    <div className="publish-settings">
      {enabled ? (
        <p className="publish-explain">
          Published notes are public snapshots served through Tailscale Funnel by a separate, read-only server; the app
          itself stays on your tailnet. Publish a note from its ⋯ menu or the command palette (“Publish note to the web”). A
          snapshot changes only when you republish.
        </p>
      ) : (
        <PublishOffNotice />
      )}
      <h3 className="settings-subtitle">Published notes</h3>
      {notes.length === 0 ? (
        <p className="muted">No notes are published.</p>
      ) : (
        <ul className="published-list">
          {notes.map((note) => (
            <PublishedRow key={note.slug} note={note} enabled={enabled} />
          ))}
        </ul>
      )}
    </div>
  );
}
