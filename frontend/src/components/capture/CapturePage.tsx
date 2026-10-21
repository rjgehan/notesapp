// /capture (DESIGN §6.27): the capture form on its own page, outside the app shell. The installed
// app's share target lands here (`?share=<id>`, read back from the service worker's cache), as do
// the manifest's "Quick capture" shortcut, links with `?text=&url=&title=`, and the desktop app's
// capture window (ROADMAP item 41).
import { CircleCheck, NotebookText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { fromShare, targetLabel, type CaptureInput } from '../../features/capture';
import type { CaptureOutcome } from '../../features/captureSync';
import { navigateTo, openPath } from '../../features/navigation';
import { displayName } from '../../features/paths';
import { forgetShared, readShared } from '../../features/sharedItems';
import { CaptureForm } from './CaptureForm';
import '../../styles/capture.css';

interface Prefill {
  initial: Partial<CaptureInput>;
  files: File[];
  notice: string | null;
}

async function prefill(search: string): Promise<Prefill> {
  const params = new URLSearchParams(search);
  const share = params.get('share');
  if (share === 'lost') return { initial: {}, files: [], notice: 'The shared item did not arrive (the app was updating). Please share it again.' };
  if (share) {
    const item = await readShared(share).catch(() => null);
    if (!item) return { initial: {}, files: [], notice: 'The shared item is no longer available. Please share it again.' };
    return { initial: fromShare(item), files: item.files, notice: null };
  }
  const fields = fromShare({ title: params.get('title'), text: params.get('text'), url: params.get('url') });
  const target = params.get('target');
  return { initial: { ...fields, ...(target === 'daily' || target === 'inbox' ? { target } : {}) }, files: [], notice: null };
}

export function CapturePage() {
  const location = useLocation();
  const [data, setData] = useState<Prefill | null>(null);
  const [done, setDone] = useState<{ outcome: CaptureOutcome; input: CaptureInput } | null>(null);
  const [round, setRound] = useState(0);
  const shareId = new URLSearchParams(location.search).get('share');

  useEffect(() => {
    let cancelled = false;
    void prefill(location.search).then((p) => !cancelled && setData(p));
    return () => {
      cancelled = true;
    };
  }, [location.search]);

  useEffect(() => {
    document.title = 'Quick capture · Notes';
  }, []);

  const finish = (outcome: CaptureOutcome, input: CaptureInput) => {
    setDone({ outcome, input });
    // The shared item is in the capture (or its queue) now.
    if (shareId && shareId !== 'lost') void forgetShared(shareId).catch(() => undefined);
  };

  const another = () => {
    setDone(null);
    setRound((n) => n + 1);
    if (location.search) navigateTo('/capture', { replace: true });
  };

  return (
    <main className="capture-page">
      {done ? (
        <div className="capture-done" role="status">
          <CircleCheck size={28} className="capture-done-icon" aria-hidden />
          {done.outcome.status === 'sent' ? (
            <p>
              Added to <strong>{done.input.target === 'daily' ? displayName(done.outcome.result.file.path) : 'Inbox'}</strong>.
            </p>
          ) : (
            <p>Saved on this device. It goes to {targetLabel(done.input.target)} when the connection returns.</p>
          )}
          <div className="capture-done-actions">
            <button type="button" className="button button-primary" onClick={another}>
              Capture another
            </button>
            {done.outcome.status === 'sent' && (
              <button type="button" className="button" onClick={() => done.outcome.status === 'sent' && openPath(done.outcome.result.file.path)}>
                <NotebookText size={15} aria-hidden /> Open the note
              </button>
            )}
            <button type="button" className="button" onClick={() => navigateTo('/')}>
              Open NotesApp
            </button>
          </div>
        </div>
      ) : data ? (
        <>
          {data.notice && (
            <p className="field-warning capture-notice" role="status">
              {data.notice}
            </p>
          )}
          <CaptureForm key={round} initial={round === 0 ? data.initial : {}} initialFiles={round === 0 ? data.files : []} onDone={finish} onCancel={() => navigateTo('/')} />
        </>
      ) : (
        <div className="view-loading" aria-busy="true" />
      )}
    </main>
  );
}
