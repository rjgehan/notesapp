// The `media` view: native audio and video controls. A video file without a picture (a voice note
// recorded as WebM) plays in an audio player.
import { useState } from 'react';
import { api } from '../api/endpoints';
import { FileInfo } from './FileInfo';
import type { FileViewProps } from './registry';

export default function MediaView({ entry }: FileViewProps) {
  const url = api.rawUrl(entry);
  const [audioOnly, setAudioOnly] = useState(false);
  return (
    <div className="media-view">
      <FileInfo entry={entry} />
      {entry.kind === 'video' && !audioOnly ? (
        <video
          className="media-player"
          src={url}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            if (e.currentTarget.videoWidth === 0 && e.currentTarget.videoHeight === 0) setAudioOnly(true);
          }}
        />
      ) : (
        <audio className="media-player" src={url} controls preload="metadata" />
      )}
    </div>
  );
}
