// Settings › Quick capture (DESIGN §6.27): how to capture from everywhere, with the iPhone Share
// Sheet Shortcut spelled out step by step (iOS does not let web apps receive shares), and the
// captures the server refused.
import { Copy, RotateCcw, Trash2 } from 'lucide-react';
import { useCaptureQueue, discardFailedCapture, retryFailedCapture } from '../../features/captureSync';
import { formatRelative } from '../../features/format';
import { keyLabel } from '../../features/platform';
import { toast } from '../../state/toasts';
import '../../styles/capture.css';

/** The fixed client id the Shortcut sends (the CSRF rule: every mutation needs one, API.md §2). */
export const SHORTCUT_CLIENT_ID = 'ios-shortcut-capture';

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to the clipboard');
  } catch {
    toast('The browser refused clipboard access', { kind: 'error' });
  }
}

function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="capture-copy">
      <code>{value}</code>
      <button type="button" className="icon-button" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => void copy(value)}>
        <Copy size={15} aria-hidden />
      </button>
    </div>
  );
}

function FailedCaptures() {
  const failed = useCaptureQueue((s) => s.failed);
  const waiting = useCaptureQueue((s) => s.waiting);
  return (
    <>
      {waiting > 0 && (
        <p className="setting-note">
          {waiting} {waiting === 1 ? 'capture is' : 'captures are'} waiting on this device for the connection.
        </p>
      )}
      {failed.length > 0 && (
        <>
          <h3 className="settings-subtitle">Captures the server refused</h3>
          <ul className="discarded-list">
            {failed.map((f) => (
              <li key={f.id} className="discarded-item">
                <div className="discarded-head">
                  <span className="discarded-name">{f.file ? f.file.name : f.request.target === 'daily' ? "Today's note" : 'Inbox'}</span>
                  <span className="muted">{formatRelative(f.at)}</span>
                </div>
                <p className="field-error">{f.error}</p>
                {f.request.text && <pre className="discarded-preview">{f.request.text}</pre>}
                <div className="discarded-actions">
                  {f.request.text && (
                    <button type="button" className="button button-small" onClick={() => void copy(f.request.text ?? '')}>
                      <Copy size={14} aria-hidden /> Copy
                    </button>
                  )}
                  <button type="button" className="button button-small" onClick={() => void retryFailedCapture(f)}>
                    <RotateCcw size={14} aria-hidden /> Try again
                  </button>
                  <button type="button" className="button button-small" onClick={() => void discardFailedCapture(f)}>
                    <Trash2 size={14} aria-hidden /> Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function CaptureSettings() {
  const origin = window.location.origin;
  const body = '{"text": <Shortcut Input>, "target": "inbox", "date": <Current Date as yyyy-MM-dd>, "time": <Current Date as HH:mm>}';
  return (
    <>
      <p className="setting-note setting-prose">
        Captures go to the end of <strong>Inbox.md</strong> (at the top of the vault) or of today&rsquo;s daily note, one list item each with the time.
        Without a connection they wait on this device.
      </p>
      <h3 className="settings-subtitle">In the app</h3>
      <ul className="capture-steps">
        <li>
          <kbd>{keyLabel('Mod-Shift-Space')}</kbd> anywhere, the ribbon&rsquo;s inbox button, or <em>Quick capture</em> in the command palette.
        </li>
        <li>On the phone: the <strong>+</strong> button at the top, or <em>Capture</em> in the sidebar.</li>
        <li>
          Installed as an app on Android or Windows (Chrome or Edge), NotesApp appears in the share sheet for text, links and pictures, and its
          icon&rsquo;s menu has <em>Quick capture</em>.
        </li>
      </ul>
      <h3 className="settings-subtitle">iPhone Share Sheet</h3>
      <p className="setting-note">
        iOS does not let web apps receive shares, so a Shortcut sends them. It talks to NotesApp over the tailnet, so Tailscale must be connected.
      </p>
      <ol className="capture-steps">
        <li>
          In the Shortcuts app, create a shortcut named <strong>Add to Notes</strong>. In its details, turn on <em>Show in Share Sheet</em> and let
          it receive <em>Text</em>, <em>URLs</em> and <em>Safari web pages</em>.
        </li>
        <li>
          Add <em>Format Date</em> (Current Date, custom format <code>yyyy-MM-dd</code>) and another (custom format <code>HH:mm</code>), so
          &ldquo;today&rdquo; is the phone&rsquo;s.
        </li>
        <li>
          Add <em>Get Contents of URL</em> with this URL, method <strong>POST</strong>:
          <CopyValue value={`${origin}/api/capture`} label="the URL" />
        </li>
        <li>
          Headers: <code>X-Client-Id</code> with the value below (every change needs one), and <code>Content-Type</code> set to{' '}
          <code>application/json</code>:
          <CopyValue value={SHORTCUT_CLIENT_ID} label="the client id" />
        </li>
        <li>
          Request body <em>JSON</em> with the fields <code>text</code> (Shortcut Input), <code>target</code> (<code>inbox</code> or{' '}
          <code>daily</code>), <code>date</code> and <code>time</code> (the two formatted dates):
          <CopyValue value={body} label="the body" />
        </li>
        <li>Optionally end with <em>Show Notification</em> (&ldquo;Added to Inbox&rdquo;).</li>
      </ol>
      <p className="setting-note setting-prose">
        For photos, make a second shortcut that receives <em>Images</em> and posts the <em>File</em> (request body: File, Shortcut Input) to:
      </p>
      <CopyValue value={`${origin}/api/capture/file?name=photo.jpg&target=inbox&date=<yyyy-MM-dd>&time=<HH:mm>&text=<caption>`} label="the photo URL" />
      <FailedCaptures />
    </>
  );
}
