// Shared header for binary file views: name, size, modified time and a Download button.
import { Download } from 'lucide-react';
import { api } from '../api/endpoints';
import type { FileEntry } from '../api/types';
import { formatBytes } from '../features/format';

export function FileInfo({ entry }: { entry: FileEntry }) {
  return (
    <header className="file-view-header">
      <div>
        <h1 className="file-view-title">{entry.name}</h1>
        <p className="file-view-meta">
          {formatBytes(entry.size)} · modified {new Date(entry.mtime).toLocaleString()}
        </p>
      </div>
      <a className="button" href={api.rawUrl(entry, { download: true })} download={entry.name}>
        <Download size={15} aria-hidden /> Download
      </a>
    </header>
  );
}
