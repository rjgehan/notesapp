// The `media` view: native audio and video controls.
import { api } from '../api/endpoints';
import { FileInfo } from './FileInfo';
import type { FileViewProps } from './registry';

export default function MediaView({ entry }: FileViewProps) {
  const url = api.rawUrl(entry);
  return (
    <div className="media-view">
      <FileInfo entry={entry} />
      {entry.kind === 'video' ? (
        <video className="media-player" src={url} controls playsInline preload="metadata" />
      ) : (
        <audio className="media-player" src={url} controls preload="metadata" />
      )}
    </div>
  );
}
