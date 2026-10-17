// The `text` view (DESIGN §6.8): a plain CodeMirror editor for other text kinds, with the same
// autosave, drafts and conflict handling. The language comes from @codemirror/language-data.
import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { useEffect, useMemo, useState } from 'react';
import { SaveStatus } from '../components/SaveStatus';
import type { NoteContext } from '../editor/context';
import { plainTextExtensions, type EditorHooks } from '../editor/editorSetup';
import { NoteEditor } from '../editor/NoteEditor';
import { lastSegment } from '../features/paths';
import { useDocumentSession, useSessionSnapshot } from '../sync/useTextDocument';
import type { FileViewProps } from './registry';

export default function TextView({ path }: FileViewProps) {
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  const [language, setLanguage] = useState<LanguageSupport | null>(null);
  const name = lastSegment(path);

  useEffect(() => {
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, name);
    if (description) {
      void description.load().then((support) => {
        if (!cancelled) setLanguage(support);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [name]);

  const extensions = useMemo(
    () => (ctx: NoteContext, hooks: EditorHooks) => plainTextExtensions({ ...hooks, save: ctx.save }, language),
    [language],
  );

  // A note that never loaded has no buffer to show (its error panel offers Try again).
  const ready = snapshot.loaded;

  return (
    <div className="text-view">
      <header className="file-view-header">
        <h1 className="file-view-title">{name}</h1>
        <SaveStatus snapshot={snapshot} />
      </header>
      {ready ? (
        <NoteEditor session={session} readOnly={snapshot.status === 'readonly' || snapshot.lossy} extensions={extensions} onToggleMode={() => {}} />
      ) : snapshot.status === 'loading' ? (
        <div className="view-loading" aria-busy="true">
          <div className="skeleton-line" />
        </div>
      ) : (
        <div className="error-panel" role="alert">
          <p className="error-panel-title">This file could not be opened.</p>
          <p className="error-panel-detail">{snapshot.error}</p>
          {snapshot.retryAt !== null && <p className="error-panel-detail muted">Retrying automatically…</p>}
          <button type="button" className="button" onClick={() => void session.reload()}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
