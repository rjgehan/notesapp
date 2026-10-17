// The `sheet` view (DESIGN §6.21.5), a lazy chunk with Glide Data Grid and HyperFormula: the
// session's text is parsed, calculated and edited as a workbook. A file the parser refuses is
// never touched by the grid: it opens in the text editor with the parser's message instead.
import '@glideapps/glide-data-grid/dist/index.css';
import '../../styles/sheet.css';
import { FileWarning } from 'lucide-react';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import type { FileViewProps } from '../registry';
import TextView from '../TextView';
import { SheetEditor } from './SheetEditor';
import { sheetBinding, useSheetDocument } from './useSheetDocument';

function Loading() {
  return (
    <div className="view-loading" aria-busy="true">
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
    </div>
  );
}

export default function SheetView(props: FileViewProps) {
  const { path } = props;
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  const doc = useSheetDocument(session);
  const binding = sheetBinding(session);

  if (!snapshot.loaded) {
    if (snapshot.status === 'loading') return <Loading />;
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel-title">This spreadsheet could not be opened.</p>
        <p className="error-panel-detail">{snapshot.error}</p>
        {snapshot.retryAt !== null && <p className="error-panel-detail muted">Retrying automatically…</p>}
        <button type="button" className="button" onClick={() => void session.reload()}>
          Try again
        </button>
      </div>
    );
  }

  switch (doc.kind) {
    case 'loading':
      return <Loading />;
    case 'failed':
      return (
        <div className="error-panel" role="alert">
          <p className="error-panel-title">The spreadsheet engine could not be loaded.</p>
          <p className="error-panel-detail">{doc.message}</p>
          <button type="button" className="button" onClick={binding.retry}>
            Try again
          </button>
        </div>
      );
    case 'refused':
      return (
        <div className="sheet-refused">
          <div className="note-warning sheet-refused-notice" role="alert">
            <FileWarning size={16} aria-hidden />
            <div>
              <p>
                <strong>This file cannot be shown as a spreadsheet.</strong> {doc.message}
              </p>
              <p>Nothing was changed. Fix it as text below, then open it as a spreadsheet again.</p>
              <button type="button" className="button button-small" onClick={binding.retry}>
                Open as spreadsheet
              </button>
            </div>
          </div>
          <TextView {...props} />
        </div>
      );
    case 'ready':
      return <SheetEditor path={path} snapshot={snapshot} workbook={doc.workbook} version={doc.version} />;
  }
}
