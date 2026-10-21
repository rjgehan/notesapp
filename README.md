# NotesApp

A self-hosted, single-user notes web app modelled closely on Obsidian. The vault is a folder of plain Markdown files on your own server; every device on your Tailscale tailnet (PC, phone, laptop) opens the same notes at `https://notes.<tailnet>.ts.net`, and changes show up live everywhere.

## Features (v1)

- **Obsidian-compatible vault.** Plain `.md` files in any folder layout, `[[wikilinks]]` (aliases, headings, block ids), `![[embeds]]`, YAML frontmatter shown as properties, nested `#tags`, ordinary attachment files and a `.trash/` folder. Obsidian desktop can open a copy of the vault unchanged.
- **Never lose a keystroke.** Atomic writes, content-hash version checks, a conflict banner with side-by-side compare, unsaved edits kept in the browser until the server confirms them, and a git history of every change (inside the vault, via JGit) with diff and restore.
- **Live across devices.** Server-Sent Events update the file tree and any open note that has no unsaved edits; edits made over SSH or by other tools are picked up too.
- **Editor and reading view.** CodeMirror 6 in styled source mode with autocomplete for links, headings and tags; a reading view with embeds, image sizes, clickable checkboxes, footnotes, `==highlights==` and `%%comments%%`.
- **Find things.** Quick switcher, command palette, full-text search (phrases, `tag:`, `path:`, negation), backlinks and unlinked mentions, outline and tags panels.
- **Organise.** Rename and move with automatic link updates (and undo), trash with restore, attachments by paste, drop or upload, daily notes and templates.
- **Phone-first.** A responsive layout tuned for iPhone Safari (keyboard-aware editor, toolbar, drawer, 44 px targets), dark and light themes.
- **Zero-touch deploys.** A push to `main` is tested, built for amd64 and arm64, and running on the server within about five minutes.

## Architecture

A Spring Boot 4 backend (Java 21) serves the REST and SSE API ([docs/API.md](docs/API.md)) and the React 19 + Vite single-page app from one Docker image. The vault is a directory of Markdown files on a Docker volume: an in-memory index (links, tags, full-text search) is built at startup and kept current by a file watcher, and JGit commits every change into the vault's own `.git`. There is no database and no app login. In production the app listens only on `127.0.0.1:8080` inside the network namespace of a kernel-mode Tailscale container, whose `tailscale serve` terminates HTTPS and passes the caller's Tailscale identity; the tailnet plus host and identity allowlists are the security boundary. Watchtower on the server pulls each new image from GHCR and restarts the app. The full design is in [docs/DESIGN.md](docs/DESIGN.md).

| Path | What |
|---|---|
| `backend/` | Spring Boot app (`com.rjgehan.notes`), Maven wrapper |
| `frontend/` | React + TypeScript + Vite SPA |
| `deploy/` | `docker-compose.yml` (tailscale, notes, watchtower), Tailscale serve config, `.env.example`, and `casaos-compose.yml` for CasaOS |
| `.github/` | CI, image publishing, Dependabot |
| `Dockerfile` | Three stages: frontend build, backend build, JRE runtime |
| `docs/` | Design, API contract, deployment runbook, roadmap |

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
- [docs/CASAOS.md](docs/CASAOS.md): installing on CasaOS by pasting one compose file
- [docs/ROADMAP.md](docs/ROADMAP.md): what comes after v1
