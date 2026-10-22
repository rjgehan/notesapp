# Web clipper: install and use

The web clipper (ROADMAP item 19, design in [DESIGN.md §6.27.1](DESIGN.md)) saves a web page as a Markdown note in
`Clippings/`: the readable article, or only what you selected, with its title, address, author, dates and the tag
`clippings` in the note's properties. There are three ways to clip:

| | Where | Images | Installs from |
|---|---|---|---|
| **Browser extension** | Chrome, Edge, Firefox 128+ on the desktop | Links, or saved as attachments (optional) | This repository's `clipper/` folder, built once |
| **Bookmarklet** | Any desktop browser | Links | Settings › Web clipper |
| **iOS Shortcut** | Safari on iPhone and iPad (share sheet) | Links | Settings › Web clipper, on the phone |

Every way runs over the tailnet, so **Tailscale must be connected**. The page is always read by your browser or phone;
the NotesApp server never fetches a web page. Nothing needs configuring on the server: the Docker image already serves
the bookmarklet and the Shortcut's script, and the extension only needs NotesApp's address.

## Browser extension

The extension is not published in a store. Build it once, then load the folder.

### Build

On a computer with Node 24 (the same as for the frontend):

```sh
cd clipper
npm ci
npm run build
```

This writes `clipper/dist/chrome/` (Chrome and Edge) and `clipper/dist/firefox/` (Firefox). `npm test` runs the clipper's
tests.

### Chrome or Edge

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `clipper/dist/chrome` folder.
3. Pin **NotesApp clipper** to the toolbar (puzzle-piece menu).
4. Its options page opens from the toolbar button's **Options** link (or the extension's details). Enter NotesApp's
   address, for example `https://notes.your-tailnet.ts.net` (Settings › Web clipper shows it with a copy button), and
   press **Save**. The browser asks to let the clipper read and change data on that site: allow it. That permission is
   what lets the clipper hand the clip to NotesApp's `/clip` page.

Keep the folder where it is: the browser loads the extension from it. After pulling a new version, run `npm run build`
again and click the reload arrow on the extension's card.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `clipper/dist/firefox/manifest.json`.
3. Open the add-on's options (`about:addons` › NotesApp clipper › Options), enter NotesApp's address and press
   **Save**; allow the permission Firefox asks for.

A temporary add-on is removed when Firefox quits. To keep it, either use Firefox Developer Edition or Nightly with
`xpinstall.signatures.required` set to `false` in `about:config` and install a zip of the folder's contents, or sign it
for yourself as an unlisted add-on on addons.mozilla.org (`npx web-ext sign --channel=unlisted` in `clipper/dist/firefox`,
with your own AMO API key). Its add-on id is `clipper@notesapp.rjgehan.github.io`.

### Use

- **Toolbar button** (or `Alt+Shift+K`): **Clip the page** or **Clip the selection**.
- **Right-click** a page or a selection: *Clip this page to NotesApp* or *Clip the selection to NotesApp*.

NotesApp opens in a new tab with a preview. Change the name or the folder if you like and press **Save**; the tab then
offers to open the note. The badge on the toolbar button shows a check mark when the clip arrived, and an exclamation
mark (with the reason in its tooltip) when it did not.

### Options

| Option | Default | What it does |
|---|---|---|
| NotesApp address | (none) | Where NotesApp is. HTTPS, or `http://localhost:…` for development. |
| Folder | `Clippings` | The folder new clips go to; the preview can change it per clip. |
| Save the article's images as attachments | Off | Downloads the article's images (at most 40, 10 MB each, 40 MB in all) and stores them next to the note, per Settings › Files and links. Turning it on asks for access to **all sites**, which downloading from any site needs. The downloads send no cookies. |
| Save without the preview | Off | NotesApp opens in a background tab, saves the clip and closes again. If the save fails, the tab comes to the front with the error. |

## Bookmarklet

1. In NotesApp, open **Settings › Web clipper** on the computer.
2. Drag the **Clip to Notes** button to the bookmarks bar. (Clicking it inside NotesApp does nothing.)
3. On a page, click the bookmark. NotesApp opens in a new window with a preview: press **Save**.

Select text first to clip only that. If the browser blocks the window, allow pop-ups for that site and click the
bookmark again. A few sites keep other windows from talking to them; the NotesApp window then says so after a few
seconds: select what you want on the page, copy it, click the box in the NotesApp window and paste.

The bookmarklet contains NotesApp's address, so drag it again from Settings if the address changes.

## iPhone and iPad (Safari's share sheet)

iOS does not let web apps receive shares, so a Shortcut does the clipping, with the clipper's script running on the phone.
Open **Settings › Web clipper on the iPhone** (the copy buttons put the values on the phone's clipboard), then in the
Shortcuts app:

1. Create a shortcut named **Clip to Notes**. In its details (ⓘ), turn on **Show in Share Sheet** and let it receive
   **Safari web pages** only.
2. Add **Run JavaScript on Web Page** with the Shortcut Input. Delete its sample code, then in Settings › Web clipper tap
   **Copy the script** and paste it into the action.
3. Add **Get Contents of URL** with the URL `https://notes.your-tailnet.ts.net/api/files` (copy it from Settings),
   method **POST**.
4. Under **Headers**, add `X-Client-Id` = `ios-shortcut-clipper` and `Content-Type` = `application/json`.
5. Set **Request Body** to **File** and pick the **JavaScript Result**.
6. Optionally add **Show Notification** ("Clipped").

To clip, share a page from Safari and choose **Clip to Notes**. Select text first to clip only that. The note goes to
`Clippings/` under the article's title; when that name is taken, a number is added. Images stay links. When a newer
NotesApp changes the clipper, copy the script again.

If the Shortcut reports an error: `403 identity-not-allowed` or no answer means Tailscale is off or the phone's login is
not allowed (DEPLOY.md); `400` with "could not read this page" means the page gave the script nothing readable.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Settings › Web clipper says the server was built without the clipper | The scripts come from the Docker image's `clipper` build stage. In development, run `npm run build` in `clipper/` (the Vite dev server then serves them). |
| The extension opens its options instead of clipping | NotesApp's address is not set, or the permission for it was not granted: enter it and press **Save**. |
| "This page cannot be clipped" | Browser pages (`chrome://`, `about:`) and the extension stores cannot be scripted by any extension. |
| The bookmarklet's window waits and then asks for a paste | The site sets `Cross-Origin-Opener-Policy`. Paste, or use the extension. |
| The NotesApp tab says "NotesApp did not load in time" | Tailscale is not connected, or the address is wrong. |

## Development

The clipper is its own package in `clipper/`: `npm run typecheck`, `npm test` (Vitest with jsdom), `npm run build`. With
the backend on port 18320 and the Vite dev server on 5176 (`NOTES_DEV_BACKEND=http://127.0.0.1:18320`), set the
extension's address to `http://localhost:5176`; the dev server serves `clipper/dist/web` under `/clipper/` after a build.
