// The `image` view: a zoomable image (click toggles fit and actual size).
import { useState } from 'react';
import { api } from '../api/endpoints';
import { FileInfo } from './FileInfo';
import type { FileViewProps } from './registry';

export default function ImageView({ entry }: FileViewProps) {
  const [actual, setActual] = useState(false);
  return (
    <div className="media-view">
      <FileInfo entry={entry} />
      <div className={`image-stage${actual ? ' is-actual' : ''}`}>
        <img
          src={api.rawUrl(entry)}
          alt={entry.name}
          onClick={() => setActual(!actual)}
          title={actual ? 'Click to fit' : 'Click for actual size'}
        />
      </div>
    </div>
  );
}
