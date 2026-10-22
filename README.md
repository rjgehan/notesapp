# NotesApp

A self-hosted, single-user notes web app modelled closely on Obsidian. The vault is a folder of plain Markdown files on your own server; every device on your Tailscale tailnet (PC, phone, laptop) opens the same notes at `https://notes.<tailnet>.ts.net`, and changes show up live everywhere.

## Features (v1)

- **Obsidian-compatible vault.** Plain `.md` files in any folder layout, `[[wikilinks]]` (aliases, headings, block ids), `![[embeds]]`, YAML frontmatter shown as properties, nested `#tags`, ordinary attachment files and a `.trash/` folder. Obsidian desktop can open a copy of the vault unchanged.
- **Never lose a keystroke.** Atomic writes, content-hash version checks, a conflict banner with side-by-side compare, unsaved edits kept in the browser until the server confirms them, and a git history of every change (inside the vault, via JGit) with diff and restore.
- **Live across devices.** Server-Sent Events update the file tree and any open note that has no unsaved edits; edits made over SSH or by other tools are picked up too.
- **Editor and reading view.** CodeMirror 6 with Live Preview: notes render as you type (headings, bold, italic, highlights, links, lists, quotes and clickable checkboxes, and tables as a grid you edit in place: cells, rows and columns, drag to reorder) while the file stays plain Markdown, with the markup hidden or shown at the cursor (a per-device setting), a styled source mode and a read-only lock per note. No Markdown to type: typing shortcuts (`# `, `- `, `[] `, `---`, a code fence, a `|` header line), formatting keys and a toolbar over selected text (bold, italic, strikethrough, highlight, code, links, headings), formatting buttons on the phone's keyboard toolbar, and rich paste that turns web pages, Google Docs and Word into Markdown. Autocomplete for links, headings and tags; a reading view with embeds, image sizes, clickable checkboxes, footnotes, `==highlights==` and `%%comments%%`.
- **Find things.** Quick switcher, command palette, full-text search (phrases, `tag:`, `path:`, negation), backlinks and unlinked mentions, outline and tags panels.
- **Organise.** Rename and move with automatic link updates (and undo), trash with restore, attachments by paste, drop or upload, daily notes and templates.
- **Drawings.** Excalidraw drawings as vault files: new `.excalidraw` drawings, and Obsidian Excalidraw `.excalidraw.md` files edited in place. Touch and Apple Pencil on iPhone and iPad, images stored as vault attachments, edits from two devices merged automatically, and changes from another device shown live. `![[Diagram.excalidraw|400]]` embeds a drawing in a note as an image that opens the editor; a drawing's texts are searchable and its links show up as backlinks; the Obsidian plugin's embedded notes, drawings and LaTeX show as static images.
- **Spreadsheets.** `.sheet` files open in a fast grid with about 400 Google-Sheets-style functions (HyperFormula), a formula bar, several sheets, named ranges, frozen rows and columns, fill, number formats (currency, percent, decimals, dates), bar, line and pie charts, and copy and paste with other spreadsheets. Embed a sheet, a range or its charts in a note with `![[Budget.sheet]]`, `![[Budget.sheet#Summary]]` or `![[Budget.sheet#Budget!A1:C10]]`; cells are searchable and `[[links]]` in them are backlinks. Import and export CSV and Excel (.xlsx) files. Spreadsheets autosave, sync live and keep their history like notes, and edits of different cells on two devices merge by themselves.
- **Tasks** *(roadmap item 4; reminder delivery comes with item 9)*. Structured to-do lists kept in the vault as readable `.tasks` JSON files under `Tasks/`: due and start dates, priorities, tags, subtasks, sections, repeating tasks (RFC 5545 rules, from the due date or from completion, read back as text such as "every 2 weeks on Monday", set from common choices, words or a raw RRULE), reminders stored for later delivery, and a yearly archive of tasks completed more than 90 days ago.
  - **Views.** Today (overdue, due and started tasks); Upcoming (the next 14 days by day, with a week strip); a page per list with sections, subtasks, drag to reorder and inline editing, or the same list as a **Kanban board** with its sections or the statuses as columns and cards that drag between and within them; a Completed log; a Filter page by tag, priority and list (bookmarkable). A detail sheet covers every field.
  - **Capture.** Quick add from anywhere (`Mod-Alt-T`, or the floating + on the phone) reads `Pay rent tomorrow 9am every month !high #home @Bills [[Apartment]]` into chips before saving. **Convert checkbox to task** turns the `- [ ]` line under the cursor into a task in the Inbox and leaves a link to it (Obsidian Tasks emoji dates and priorities come along).
  - **In notes.** `![[Home.tasks]]` embeds a live list you can check off (`#Section` or `#^task-id` for part of it); a `.tasks` file opens as its list, with its JSON a click away; `[[links]]` and `#tags` in tasks show up in backlinks, tags, search and a "Tasks linking to this note" panel.
  - Changes show at once and on every device; completing a repeating task moves it to its next date; devices editing different tasks of one list never conflict, and edits made by hand are picked up.
- **Phone-first.** A responsive layout tuned for iPhone Safari (keyboard-aware editor, toolbar, drawer, 44 px targets), dark and light themes.
- **Zero-touch deploys.** A push to `main` is tested, built for amd64 and arm64, and running on the server within about five minutes.
- **Nightly backups.** Optional, encrypted restic snapshots of the vault, its history and the Tailscale identity to a second disk and to Backblaze B2 or Amazon S3 (7 daily, 4 weekly, 12 monthly), consistent because the app is stopped for the seconds the snapshot takes, with ntfy alerts (naming the failed steps, never your files) and a documented restore drill.
- **History mirror on GitHub.** Optionally, the vault's git history is pushed to a private GitHub repository about 10 minutes after you stop editing, with a token from a compose secret; fast-forward only, so a mirror that has diverged is reported, never overwritten. Failures, and a mirror whose settings cannot be used, show in the status bar; failures are retried with backoff.
- **Small history, large files kept.** Files over 25 MB (configurable), hidden ones included, stay in the vault and in backups but out of git history; the History panel says why, and replacing such a file keeps the old one in the trash.
- **Status page and app alerts.** `/x/status` shows the server at a glance: problems first, then version and uptime, history (commits, failures, mirror, files kept out of it), the vault and index, disk space, the last backup, live-sync connections and the alerts. The app pushes its own problems (history not saved, mirror failing, disk full, …) to ntfy, deduplicated and rate-limited, without note content; the ntfy settings live outside the vault in `/data/secrets/ntfy.json`.
- **Desktop app for Windows and macOS** *(roadmap item 41)*. A thin, sandboxed window around your server with a tray icon, a system-wide quick-capture shortcut (`Ctrl+Shift+Space` / `Cmd+Shift+Space`) that opens a small always-on-top capture window, native notifications, launch at login and offline use through the app's own offline mode. Installers are built from `desktop-v*` tags; see [docs/DESKTOP.md](docs/DESKTOP.md).
- **Fast restarts.** The image runs on JDK 25 with an AOT cache made at build time, so a deploy or a nightly backup restart is back up sooner.

## Architecture

A Spring Boot 4 backend (Java 21 bytecode, run on JDK 25) serves the REST and SSE API ([docs/API.md](docs/API.md)) and the React 19 + Vite single-page app from one Docker image. The vault is a directory of Markdown files on a Docker volume: an in-memory index (links, tags, full-text search) is built at startup and kept current by a file watcher, and JGit commits every change into the vault's own `.git`. There is no database and no app login. In production the app listens only on `127.0.0.1:8080` inside the network namespace of a kernel-mode Tailscale container, whose `tailscale serve` terminates HTTPS and passes the caller's Tailscale identity; the tailnet plus host and identity allowlists are the security boundary. Watchtower on the server pulls each new image from GHCR and restarts the app. The full design is in [docs/DESIGN.md](docs/DESIGN.md).

| Path | What |
|---|---|
| `backend/` | Spring Boot app (`com.rjgehan.notes`), Maven wrapper |
| `frontend/` | React + TypeScript + Vite SPA |
| `clipper/` | The web clipper: browser extension, bookmarklet and iOS Shortcut script ([docs/CLIPPER.md](docs/CLIPPER.md)) |
| `deploy/` | `docker-compose.yml` (tailscale, notes, watchtower; optional backup sidecars), the backup scripts in `backup/`, the empty mirror-token placeholder in `mirror/`, Tailscale serve config, `.env.example`, and for CasaOS `casaos-compose.yml` (the app on the host's Tailscale), the advanced `casaos-compose-sidecar.yml` and the optional `casaos-backup-compose.yml` and `casaos-whisper-compose.yml` |
| `.github/` | CI, image publishing, Dependabot |
| `Dockerfile` | Three stages: frontend build, backend build (JDK 21), JDK 25 runtime with an AOT cache |
| `docs/` | Design, API contract, deployment runbook, roadmap |
| `scripts/` | `third-party-notices.mjs`, which regenerates `THIRD_PARTY_NOTICES.md` |

## Local development (Windows)

Needs JDK 21 and Node 24 (npm 11). Docker is not needed. Run the two halves in separate terminals:

```powershell
# Backend on http://127.0.0.1:8080. The dev profile uses .\dev-vault (created on first start,
# gitignored), needs no Tailscale and acts as a default "Owner" identity.
cd backend
.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=dev"
```

```powershell
# Frontend on http://localhost:5173. Vite proxies /api (REST and SSE) to the backend.
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

- **Another vault:** set `$env:NOTES_VAULT_DIR = "C:\path\to\a\copy"` before starting the backend. Point it at a copy, never at a vault you care about.
- **Frontend without a backend:** `$env:VITE_MOCK_API = "1"; npm run dev` uses the in-memory mock API.
- **Ports 8080 or 5173 taken:** start the backend with `"-Dspring-boot.run.arguments=--server.port=18080 --notes.allowed-hosts=localhost:5180,127.0.0.1:5180"`, then the frontend with `$env:NOTES_DEV_BACKEND = "http://127.0.0.1:18080"; npm run dev -- --port 5180 --strictPort`. The allowed hosts must name the Vite origin, because the proxy keeps the browser's `Host`.
- **Phone against dev:** possible over the tailnet, but read [DESIGN §9.1](docs/DESIGN.md#91-integration-step-after-all-three-work-packages) step 4 first; never bind Vite to `0.0.0.0`.

Checks (the same ones CI runs):

```powershell
cd backend;  .\mvnw.cmd verify                      # add "-DexcludedGroups=" to include the perf tests
cd frontend; npm run lint; npm test; npm run build
```

## How deploys work

1. **Pull requests** run the backend tests, the frontend lint, tests and build, and a Docker image build (amd64, not pushed), so the Dockerfile is exercised before anything reaches `main`.
2. **A push to `main`** (docs-only pushes excepted) runs the same checks and then [`publish.yml`](.github/workflows/publish.yml), which builds `linux/amd64` and `linux/arm64` images and pushes `ghcr.io/rjgehan/notesapp:latest` and `:sha-<7 hex>` to the private GHCR package.
3. **Watchtower** on the server polls GHCR every 5 minutes, pulls the new image and recreates the `notes` container with a 45 s graceful stop. Open browser tabs reconnect and reload themselves onto the new build.
4. **Weekly**, a scheduled run rebuilds and republishes the image so base-image security fixes arrive without a code change. Dependabot proposes grouped dependency updates weekly.

Rolling back, pausing updates, backups and everything else on the server side are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md): technical design (decisive)
- [docs/API.md](docs/API.md): the REST and SSE contract between backend and frontend
- [docs/DEPLOY.md](docs/DEPLOY.md): homeserver runbook (first deploy, operations, troubleshooting)
- [docs/CASAOS.md](docs/CASAOS.md): installing on CasaOS by pasting one compose file, and its optional alerts, mirror and backups
- [docs/CLIPPER.md](docs/CLIPPER.md): installing the web clipper (browser extension, bookmarklet, iPhone Shortcut)
- [docs/DESKTOP.md](docs/DESKTOP.md): the Windows and macOS desktop app (install, Gatekeeper steps, usage, building and releases)
- [docs/ROADMAP.md](docs/ROADMAP.md): what comes after v1

## Licence

NotesApp is free software under the GNU General Public License, version 3 only ([LICENSE](LICENSE), SPDX `GPL-3.0-only`). The spreadsheet formula engine, HyperFormula, is used under its GPL-3.0 licence option, which is why the whole repository is GPL-3.0 (decided 2026-10-17, [ROADMAP](docs/ROADMAP.md) item 6). Running your own image needs nothing further; if you ever distribute NotesApp, distribute its source under the same licence.

Third-party packages and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It is generated: after changing dependencies, run `node scripts/third-party-notices.mjs` from the repository root.
