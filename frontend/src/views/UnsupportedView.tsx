// The `unsupported` view: file information and a Download button.
import { FileQuestionMark } from 'lucide-react';
import { FileInfo } from './FileInfo';
import type { FileViewProps } from './registry';

export default function UnsupportedView({ entry }: FileViewProps) {
  return (
    <div className="media-view">
      <FileInfo entry={entry} />
      <div className="empty-state">
        <FileQuestionMark size={40} aria-hidden />
        <p>NotesApp cannot display {entry.extension ? `.${entry.extension}` : 'this kind of'} files. Download it to open it elsewhere.</p>
      </div>
    </div>
  );
}
