// The globe in a note's header (ROADMAP item 26): opens the publish dialog. Shown while public
// publishing is on, and for a note that is published (so it can be unpublished even when off).
import { Globe } from 'lucide-react';
import { openPublishDialog, publishedNote, STATE_LABELS, usePublish } from '../../features/publish';

export function PublishButton({ path }: { path: string }) {
  const { data } = usePublish();
  const published = publishedNote(data, path);
  if (!data || (!data.enabled && !published)) return null;
  const label = published ? `Published: ${STATE_LABELS[published.state]}` : 'Publish to the web';
  return (
    <button
      type="button"
      className={`icon-button publish-toggle${published ? ' is-on' : ''}${published?.state === 'changed' ? ' is-stale' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => openPublishDialog(path)}
    >
      <Globe size={16} />
    </button>
  );
}
