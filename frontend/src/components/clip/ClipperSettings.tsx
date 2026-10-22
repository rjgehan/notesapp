// Settings › Web clipper (DESIGN §6.27.1): the bookmarklet to drag to the bookmarks bar, the
// browser extension, and the iPhone Shortcut for Safari's share sheet, spelled out step by step.
// The bookmarklet and the Shortcut's script are the clipper build's, served under /clipper/.
import { Copy, Scissors } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { bookmarkletFor } from '../../features/clip';
import { toast } from '../../state/toasts';
import '../../styles/capture.css';

/** The fixed client id the clipping Shortcut sends (every mutation needs one, API.md §2). */
export const CLIP_SHORTCUT_CLIENT_ID = 'ios-shortcut-clipper';

type Asset = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; text: string };

/** A text file of the clipper build; "missing" on a server built without it (development). */
function useClipperAsset(name: string): Asset {
  const [asset, setAsset] = useState<Asset>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    fetch(`/clipper/${name}`, { credentials: 'same-origin' })
      .then(async (res) => {
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || type.includes('text/html')) throw new Error(String(res.status));
        return res.text();
      })
      .then(
        (text) => !cancelled && setAsset({ state: 'ready', text }),
        () => !cancelled && setAsset({ state: 'missing' }),
      );
    return () => {
      cancelled = true;
    };
  }, [name]);
  return asset;
}

/** Copies synchronously inside the click (iOS refuses a copy after an await). */
function copy(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${what}`),
    () => toast('The browser refused clipboard access', { kind: 'error' }),
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="capture-copy">
      <code>{value}</code>
      <button type="button" className="icon-button" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => copy(value, label)}>
        <Copy size={15} aria-hidden />
      </button>
    </div>
  );
}

function BookmarkletLink({ href }: { href: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  // React refuses javascript: URLs in href, so the attribute is set directly. Clicking it here
  // does nothing (the app's CSP blocks javascript: URLs); it is only for dragging.
  useEffect(() => {
    ref.current?.setAttribute('href', href);
  }, [href]);
  return (
    <a ref={ref} className="clip-bookmarklet" onClick={(e) => e.preventDefault()} draggable title="Drag me to the bookmarks bar">
      <Scissors size={14} aria-hidden /> Clip to Notes
    </a>
  );
}

const MISSING = 'This server was built without the clipper (the Docker image includes it; in development run npm run build in clipper/).';

export function ClipperSettings() {
  const origin = window.location.origin;
  const bookmarklet = useClipperAsset('bookmarklet.js');
  const script = useClipperAsset('shortcut.js');
  const href = bookmarklet.state === 'ready' ? bookmarkletFor(bookmarklet.text, origin) : null;

  return (
    <>
      <p className="setting-note clip-note">
        Saves a web page as a Markdown note in <strong>Clippings</strong>: the readable article (or what you selected), with its title, address and
        the date in the properties. The page is read in your browser or on your phone, never fetched by the server. Clips travel over the tailnet,
        so Tailscale must be connected.
      </p>

      <h3 className="settings-subtitle">Bookmarklet (any desktop browser)</h3>
      {bookmarklet.state === 'missing' && <p className="field-warning">{MISSING}</p>}
      {href && (
        <>
          <p className="setting-note clip-note">
            Drag this button to the bookmarks bar: <BookmarkletLink href={href} />
          </p>
          <p className="setting-note clip-note">
            On a page, click it: NotesApp opens in a new window with a preview, where you choose the name and folder and press <strong>Save</strong>.
            Select text first to clip only that. Allow pop-ups for the site if the browser blocks the window. A few sites keep other windows from
            talking to them; the window then asks you to copy and paste what you want to keep. Images stay links to the web.
          </p>
        </>
      )}

      <h3 className="settings-subtitle">Browser extension (Chrome, Edge, Firefox)</h3>
      <p className="setting-note clip-note">
        The extension adds a toolbar button and <em>Clip this page / the selection to NotesApp</em> to the right-click menu, works on every site,
        can save the article&rsquo;s images as attachments, and can save without the preview. It is not in a store: build it from the repository
        (<code>clipper/</code>, see <code>docs/CLIPPER.md</code>), then load <code>clipper/dist/chrome</code> (chrome://extensions or
        edge://extensions, Developer mode, <em>Load unpacked</em>) or <code>clipper/dist/firefox</code> (about:debugging, <em>Load Temporary
        Add-on</em>). In its options, enter this address:
      </p>
      <CopyValue value={origin} label="the address" />

      <h3 className="settings-subtitle">iPhone and iPad (Safari&rsquo;s share sheet)</h3>
      {script.state === 'missing' && <p className="field-warning">{MISSING}</p>}
      <ol className="capture-steps">
        <li>
          In the Shortcuts app, create a shortcut named <strong>Clip to Notes</strong>. In its details, turn on <em>Show in Share Sheet</em> and let
          it receive <em>Safari web pages</em> only.
        </li>
        <li>
          Add <em>Run JavaScript on Web Page</em> (input: Shortcut Input), delete its sample code and paste the clipper&rsquo;s script:{' '}
          <button type="button" className="button button-small" disabled={script.state !== 'ready'} onClick={() => script.state === 'ready' && copy(script.text, 'the script')}>
            <Copy size={14} aria-hidden /> Copy the script
          </button>
          {script.state === 'ready' && <span className="muted"> ({Math.round(script.text.length / 1024)} KB)</span>}
        </li>
        <li>
          Add <em>Get Contents of URL</em> with this URL, method <strong>POST</strong>:
          <CopyValue value={`${origin}/api/files`} label="the URL" />
        </li>
        <li>
          Headers: <code>X-Client-Id</code> with the value below, and <code>Content-Type</code> set to <code>application/json</code>:
          <CopyValue value={CLIP_SHORTCUT_CLIENT_ID} label="the client id" />
        </li>
        <li>
          Request body: <em>File</em>, set to the <em>JavaScript Result</em>.
        </li>
        <li>Optionally end with <em>Show Notification</em> (&ldquo;Clipped&rdquo;).</li>
      </ol>
      <p className="setting-note clip-note">
        Share a page from Safari and pick <strong>Clip to Notes</strong>. Select text first to clip only that. The note goes to{' '}
        <code>Clippings/</code> under the article&rsquo;s title (a number is added when the name is taken); images stay links to the web.
      </p>
    </>
  );
}
