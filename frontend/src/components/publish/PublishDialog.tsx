// The publish dialog (ROADMAP item 26, DESIGN §5.28): publish a note as a public snapshot, or
// republish, retitle, move to another address and unpublish it. Mounted through registerOverlay.
import { Copy, ExternalLink, Globe } from 'lucide-react';
import { useId, useState } from 'react';
import { errorMessage } from '../../api/client';
import type { PublishedNote, PublishResponse } from '../../api/types';
import { formatRelative } from '../../features/format';
import { displayName } from '../../features/paths';
import {
  copyPublicLink,
  publishedNote,
  publishNote,
  slugError,
  STATE_LABELS,
  suggestSlug,
  unpublishNote,
  usePublish,
  usePublishDialog,
} from '../../features/publish';
import { Modal } from '../overlays/Modal';
import '../../styles/publish.css';

export function PublishOffNotice() {
  return (
    <p className="publish-off">
      Public publishing is off on this server. Nothing in the vault is public. To share notes outside your tailnet, the
      server owner sets <code>NOTES_PUBLISH_ENABLED=true</code> and adds the Funnel entry to <code>serve.json</code>, as
      DEPLOY.md “Public publishing” describes.
    </p>
  );
}

export function PublishedLink({ note }: { note: PublishedNote }) {
  const absolute = /^https?:\/\//.test(note.url);
  return (
    <div className="publish-link">
      <code>{note.url}</code>
      <button type="button" className="icon-button" aria-label="Copy public link" title="Copy public link" onClick={() => void copyPublicLink(note)}>
        <Copy size={15} aria-hidden />
      </button>
      {absolute && (
        <a className="icon-button" href={note.url} target="_blank" rel="noopener noreferrer" aria-label="Open public page" title="Open public page">
          <ExternalLink size={15} aria-hidden />
        </a>
      )}
    </div>
  );
}

function PublishForm({ path, onClose }: { path: string; onClose(): void }) {
  const query = usePublish();
  if (query.isPending) return <p className="dialog muted">Loading…</p>;
  if (query.isError) return <p className="dialog field-error">{errorMessage(query.error)}</p>;
  return <PublishFields path={path} data={query.data} onClose={onClose} />;
}

function PublishFields({ path, data, onClose }: { path: string; data: PublishResponse; onClose(): void }) {
  const existing = publishedNote(data, path);
  const [title, setTitle] = useState(existing?.title ?? displayName(path));
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [busy, setBusy] = useState(false);
  const slugId = useId();
  const error = slugError(slug.trim());

  const submit = async () => {
    if (error || busy) return;
    setBusy(true);
    const done = await publishNote({ path, title: title.trim() || undefined, slug: slug.trim() || undefined });
    setBusy(false);
    if (done) onClose();
  };

  return (
    <form
      className="dialog publish-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="dialog-title">
        <Globe size={18} aria-hidden /> {existing ? 'Published' : 'Publish'} “{displayName(path)}”
      </h2>
      {!data.enabled && !existing ? (
        <PublishOffNotice />
      ) : (
        <>
          {existing ? (
            <>
              <PublishedLink note={existing} />
              <p className={`publish-state publish-state-${existing.state}`}>
                {STATE_LABELS[existing.state]} · published {formatRelative(existing.publishedAt)}
              </p>
              {!data.enabled && <PublishOffNotice />}
            </>
          ) : (
            <p className="publish-explain">
              Anyone with the link can read a copy of this note as it is now, through Tailscale Funnel. Later edits stay
              private until you republish. Links to notes you have not published show as plain text, and the images,
              audio and video it embeds are copied with it; frontmatter and comments are left out.
            </p>
          )}
          {data.enabled && (
            <>
              <label className="field">
                <span className="field-label">Title</span>
                <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
              </label>
              <div className="field">
                <label className="field-label" htmlFor={slugId}>
                  Address
                </label>
                <span className="publish-slug">
                  <span className="muted">/p/</span>
                  <input
                    id={slugId}
                    className="text-input"
                    value={slug}
                    placeholder={suggestSlug(title) || 'chosen by the server'}
                    onChange={(e) => setSlug(e.target.value)}
                    aria-invalid={!!error}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </span>
              </div>
              {error && <p className="field-error">{error}</p>}
            </>
          )}
        </>
      )}
      <div className="dialog-actions">
        {existing && (
          <button
            type="button"
            className="button button-danger"
            disabled={busy}
            onClick={async () => {
              if (await unpublishNote(existing)) onClose();
            }}
          >
            Unpublish
          </button>
        )}
        <button type="button" className="button" onClick={onClose}>
          {data.enabled ? 'Cancel' : 'Close'}
        </button>
        {data.enabled && (
          <button type="submit" className="button button-primary" disabled={busy || !!error}>
            {existing ? 'Republish' : 'Publish'}
          </button>
        )}
      </div>
    </form>
  );
}

export function PublishDialog() {
  const path = usePublishDialog((s) => s.path);
  const close = usePublishDialog((s) => s.close);
  if (path === null) return null;
  return (
    <Modal label="Publish" onClose={close} className="publish-modal">
      <PublishForm key={path} path={path} onClose={close} />
    </Modal>
  );
}
