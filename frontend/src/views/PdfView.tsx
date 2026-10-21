// The `pdf` view: the browser's PDF viewer in an iframe, plus "Open in new tab". `?page=N` (a
// search hit in the PDF's text, API.md §12.1) opens it at that page.
import { ExternalLink } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { pdfViewerUrl } from '../features/searchLinks';
import { FileInfo } from './FileInfo';
import type { FileViewProps } from './registry';

export default function PdfView({ entry }: FileViewProps) {
  const [params] = useSearchParams();
  const src = pdfViewerUrl(api.rawUrl(entry), params.get('page'));
  return (
    <div className="media-view pdf-view">
      <FileInfo entry={entry} />
      <a className="link-button" href={src} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={14} aria-hidden /> Open in new tab
      </a>
      {/* Keyed by the URL: changing only the fragment of an iframe's src does not move the viewer. */}
      <iframe key={src} className="pdf-frame" src={src} title={entry.name} />
    </div>
  );
}
