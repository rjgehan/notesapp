// The `pdf` view: the browser's PDF viewer in an iframe, plus "Open in new tab".
import { ExternalLink } from 'lucide-react';
import { api } from '../api/endpoints';
import { FileInfo } from './FileInfo';
import type { FileViewProps } from './registry';

export default function PdfView({ entry }: FileViewProps) {
  const url = api.rawUrl(entry);
  return (
    <div className="media-view pdf-view">
      <FileInfo entry={entry} />
      <a className="link-button" href={url} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={14} aria-hidden /> Open in new tab
      </a>
      <iframe className="pdf-frame" src={url} title={entry.name} />
    </div>
  );
}
