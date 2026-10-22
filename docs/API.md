# NotesApp REST and SSE API: v1 contract

| | |
|---|---|
| Status | **Binding.** WP-Backend and WP-Frontend implement this independently and in parallel. |
| Date | 2026-10-16 (revision 2, matching DESIGN.md revision 2; integration amendments in §6.3, §11.3, §14.4, §15.1 and §17, agreed by both sides). Roadmap amendments, 2026-10-17: drawings (item 5) in §10.3, §11.2, §12.1 and §12.2; §20 tasks (item 4), with additions to §2, §3, §10.3, §11.2, §12.1, §16.4 and §17 to §19. 2026-10-21, items 4 and 5 together: §1.8 indexed documents, which §10.3, §11.2, §12.1, §12.2 and §20.9 refer to. 2026-10-21: §21 bookmarks (item 12) and §22 heading renames (item 21), with additions to §16.4 and §17 to §19; spreadsheets (item 6) in §10.3, §12.1 and §12.3. 2026-10-21: quick capture (§8.5, §8.6) and the installable app's routes (§18), ROADMAP items 7 and 8. 2026-10-21: flashcards (item 34) in §16.4, §17, §18, §19 and §34; habits (item 35) in §17, §18, §19 and §35. 2026-10-21: canvases (item 25) as indexed documents in §1.8, §11.2, §12.1 and §12.2. 2026-10-21: the PDF viewer (item 32) in §9.1; voice notes and transcription (item 33) in §3, §17, §18, §19 and §23. 2026-10-21: Ask your vault and summaries (item 18) in §3, §5, §17, §18, §19 and §24. |
| Change control | Only the architect changes this file. If an implementer finds a gap, they stop, raise it, and the file is amended first; both sides then adapt. |
| Related | [DESIGN.md](DESIGN.md) explains *how* and *why*. This file defines *what goes over the wire*. |

Field names, enum strings, error codes, event names and status codes in this file are exact. The TypeScript interfaces in §17 are copied verbatim into `frontend/src/api/types.ts`. The Java records in §19 live in `com.rjgehan.notes.api.dto` (event records in `com.rjgehan.notes.events`).

---

## 1. Conventions

### 1.1 Transport and base path

| Environment | Origin |
|---|---|
| Production | `https://notes.<tailnet>.ts.net` |
| Development | `http://localhost:5173` (Vite proxies `/api` to `http://127.0.0.1:8080`) |

- All endpoints live under **`/api`**. The exceptions are the health endpoints (§6.3) and the SPA routes.
- The client always uses **same-origin, relative URLs** such as `/api/tree`. There is no CORS.
- There is no versioned path prefix. Breaking changes are made in lock-step, because the frontend and backend ship in one image. An open tab can still be running an older bundle after a deploy; it detects this through `hello.buildSha` and the `X-Notes-Build` header (§2, §16.3) and reloads (DESIGN §6.18).

### 1.2 Media types

| Direction | Type |
|---|---|
| JSON request bodies | `Content-Type: application/json` (UTF-8). Any other type returns `415 unsupported-media-type`. |
| Upload request bodies (§9.2, §9.3) | Raw bytes with any `Content-Type`. Send the file's MIME type or `application/octet-stream`. |
| Successful JSON responses | `application/json` |
| Errors | `application/problem+json` (§3) |
| SSE | `text/event-stream` (§16) |

- A field typed `T | null` is **always present** in responses, with `null` meaning "no value".
- An optional request field (`field?:`) may be omitted.
- Unknown request fields are ignored.
- The order of JSON keys carries no meaning.

### 1.3 Vault paths

A **vault path** is a vault-relative, `/`-separated, NFC-normalized string with no leading or trailing `/`. Examples: `Welcome.md`, `Projects/Plan B.md`, `Attachments/Pasted image 20261016140322.png`.

- The root folder is the empty string `""`. It appears only in folder contexts, such as `TemplatesResponse.folder`; you cannot address the root as a file.
- Case is preserved in output. Uniqueness and link resolution are case-insensitive (DESIGN §4.4). Implicit parent folders in a new path resolve case-insensitively to existing folders (`daily/x.md` lands in `Daily/x.md`), and responses always carry the real path. A final segment that differs from an existing sibling only by case returns `409 case-collision`.
- The server NFC-normalizes every incoming path, so clients may send NFD (iOS often does). Output is always NFC, also for files whose on-disk names are NFD.
- **Safety rules** (every path, every endpoint): no blank path, empty segment, `.` or `..` segment, leading or trailing `/`, `\`, control character, symlink, or path over 1024 characters or segment over 255 UTF-8 bytes. A violation returns `400 invalid-path`. Any segment starting with `.` returns `403 reserved-path`.
- **New-name rules** apply only to names a request **introduces**: create, folder create, upload of a new file, move target, and trash restore with an explicit `to`. On top of the safety rules, no segment may contain `:`, `*`, `?`, `"`, `<`, `>`, `|`, `#`, `^`, `[`, `]` or `%%`; have leading or trailing whitespace; end in `.` or a space; be a Windows reserved name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, with any extension); exceed **240** UTF-8 bytes; or match a name the server ignores (`*.tmp`, `*.part`, `*.crdownload`, `*~`, `*.swp`, `*.swx`, `4913`, `Thumbs.db`, ...; DESIGN §4.5). A violation returns `400 invalid-name`.
- Existing files whose names break the new-name rules (for example `Meeting 10:30.md` created over SSH) are fully addressable: they can be read, saved, downloaded, deleted, used as a move `from` and restored. Trash restore to the original path, `PUT /api/files` with `baseVersion: null`, and history restore never apply the new-name rules, because they bring back a name that existed.

**Encoding paths in requests.**

- **In a query parameter**, the value must be encoded with `encodeURIComponent`. This matters for `+`, which must be sent as `%2B`, because Tomcat decodes a bare `+` in a query string as a space.
  ```
  GET /api/files?path=Projects%2FPlan%20B%20%2B%20notes.md      →  path = "Projects/Plan B + notes.md"
  ```
- **In a JSON body**, paths are plain strings: `{"from": "Projects/Plan B.md"}`.

### 1.4 Text positions

- All positions refer to the decoded file text **with any leading BOM removed**, which is exactly `TextFile.content`.
- `line` is a **0-based** line number in that text, counted by `\n`. The frontmatter counts.
- `from` and `to` are **UTF-16 code-unit offsets** into that text. They form a half-open range `[from, to)`. These are the same as JavaScript string indices and Java `String` indices. A `\r\n` line break counts as **two** code units; a client that keeps its document LF-only maps server offsets by subtracting the `\r\n` pairs before them (DESIGN §6.6).
- A `TextRange` inside a snippet (`context`, `text`) is relative to that snippet string.

### 1.5 Time

All instants are ISO-8601 UTC strings with **exactly three** fractional digits (milliseconds, truncated), for example `2026-10-16T14:03:22.120Z` or `2026-10-16T14:03:02.000Z`. The server truncates nanosecond file times and second-precision git times to this form.

### 1.6 Versions

`Version` is 40 lowercase hex characters: the git blob id of the file's exact bytes on disk.

```
version = lowercase_hex( SHA1( "blob " + decimal(byteLength) + "\0" + bytes ) )
```

| Bytes | Version |
|---|---|
| empty file | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` |
| `hello\n` | `ce013625030ba8dba906f756967f9e9ca394464a` |

- Only text-kind files (`note`, `text`) within their size limit have a version. Binary files and over-size text files report `version: null`.
- Clients never compute versions; they echo them back as `baseVersion`.

### 1.7 Limits

| Limit | Value |
|---|---|
| Text file content (UTF-8 bytes) | 5 MiB (5,242,880) by default; the server can raise it per extension (`notes.limits.text-size-overrides`). Beyond it `413 too-large`, with `limit` set to the limit that applied. |
| JSON request body | 16 MiB (`Content-Length` checked before reading); beyond it `413 too-large` |
| Upload body | 100 MiB (104,857,600); beyond it `413 too-large` |
| Versioned file size | 25 MiB (26,214,400) by default (`notes.git.large-file-threshold`, never below the text file size above); a larger file is stored but kept out of git history (§6.2 `git.largeFiles`, §14.1 `excluded`) |
| Free disk space after an upload | at least 1 GiB; otherwise `507 insufficient-storage` |
| Path length | 1024 UTF-16 characters; each existing segment 255 UTF-8 bytes; each **new** segment 240 UTF-8 bytes |
| `POST /api/links/resolve` targets | 1 to 500 |
| Search `limit` | 1 to 200 (default 50) |
| History `limit` | 1 to 200 (default 50) |

### 1.8 Indexed documents

Besides notes, the server indexes the content of some structured text files (DESIGN §6.8, the `DocumentIndexer` extension point). Such a **document** is not a note, but it is searched, linked and tagged like one.

| Files | What is indexed | Links a move (§10.3) or a heading rename (§22) rewrites |
|---|---|---|
| `.tasks` lists (§20.9) | The list's name; each task's title, tags, related notes (`links`) and notes | Those in titles and notes, and each path in `links` |
| `.excalidraw` drawings (DESIGN §6.8.1) | Each text element's text, each element link (web links excluded), each image stored as a vault attachment, frame names | None: the drawing is reported as `not-rewritable` |
| `.sheet` spreadsheets (§12.3) | What each cell shows (its text or number, or its formula's cached result), sheet names, chart titles | None: the spreadsheet is reported as `not-rewritable` |
| `.canvas` boards (DESIGN §6.8.2) | Each text card's Markdown, group names, link nodes' addresses, edge labels, and each file node as an embed of its file (with its subpath) | Those in cards, group names and edge labels, and each file node's `file`; only those JSON strings change |
| `.excalidraw.md` drawings | A note, scanned as one; also the texts and links that only its drawing JSON holds | Those in its Markdown, as in any note; not those only its JSON holds (`not-rewritable`) |

- `GET /api/search` (§12.1) can return a document; its `matches` are lines of the indexed text, never of the file's JSON.
- The links and embeds in a document make it a backlink source (§11.2), and its tags count in `GET /api/tags` (§12.2) and `tag:` search. Positions (`line`, `from`, `to`) refer to the indexed text, not to the file.
- A document is not a note: `GET /api/notes/meta` answers `409 type-mismatch`, it never appears in unlinked mentions, and it does not count in `/api/status` `vault.notes`.
- A move or a heading rename rewrites the links in a document where its type can write them back; otherwise the document is left as it is and reported in `MoveResult.failed` with `not-rewritable`.

---

## 2. Common headers and CSRF rules

| Header | Requests | Rule |
|---|---|---|
| `X-Client-Id` | **Required** on every `POST`, `PUT`, `PATCH` and `DELETE` under `/api`. The client sends it on *every* request. | Must match `^[A-Za-z0-9-]{8,64}$`. A missing or malformed value gets `403 client-id-required`. One value per page load, for example `crypto.randomUUID()`. The server uses it as the `origin` of the events your writes cause, and does not echo those events back to you (§16.4). |
| `Origin` | Sent automatically by browsers | On mutating requests, if present, its host:port must equal the `Host` header, compared case-insensitively. `Origin: null` is rejected. Failure gets `403 cross-origin`. |
| `Sec-Fetch-Site` | Sent automatically by browsers | On mutating requests, if present, it must be `same-origin` or `none`. Anything else gets `403 cross-origin`. |
| `Accept` | Optional | `application/json`, or `text/event-stream` for §16 |
| `Idempotency-Key` | Optional on `POST /api/files`, `PUT /api/files/raw`, `POST /api/attachments`, `POST /api/capture`, `POST /api/capture/file` and every `POST`, `PATCH` and `DELETE` of the task API (§20) | Any string of 8 to 64 characters from `[A-Za-z0-9-]`, unique per logical operation (for example `crypto.randomUUID()` generated once and reused for every retry). The server keeps a per-boot cache of 1,000 keys for 1 hour; a request whose key, method and path match an earlier one gets the **stored status and body** of the first result, and nothing is done again. Without it, a retried "New note" whose response was lost would create `Untitled 1.md`. |
| `Host` | Sent by every client | Must match the server's allowlist (`notes.<tailnet>.ts.net` in production). Otherwise `421 unknown-host`. |
| `Tailscale-User-*` | Set by `tailscale serve` in production | Identity (§6.1). A request without an allowed `Tailscale-User-Login` gets `403 identity-not-allowed` (DESIGN §5.13). Clients never send them. |

**Response headers** on every response: `X-Notes-Build: <buildSha>`. Every `/api/**` JSON response carries `Cache-Control: no-store`; the raw-file endpoints (§9.1, §13.2, §14.3) and `/api/events` set their own.

- **Every `GET` is side-effect free.**
- `POST /api/links/resolve` is a read-only `POST`, but it still needs `X-Client-Id`.
- `GET` requests, including `<img src>` and `EventSource`, need no custom headers.
- The health endpoints (§6.3) are exempt from the Host and identity checks.
- **The web clipper** (ROADMAP item 19, DESIGN §6.27.1) changes none of these rules. Its bookmarklet and browser extension never call the API: they pass the clip to the app's `/clip` page with `postMessage`, and that page saves it with ordinary same-origin requests (`POST /api/attachments`, then `POST /api/files` with `onConflict: "rename"`). Its iOS Shortcut posts the `CreateFileRequest` its script returns to `POST /api/files` with `X-Client-Id: ios-shortcut-clipper` and no `Origin`, like the capture Shortcut (§8.5).

---

## 3. Errors

Every error response is RFC 9457 `application/problem+json` with an extra `code` property:

```json
{
  "type": "urn:notesapp:problem:invalid-name",
  "title": "Invalid name",
  "status": 400,
  "detail": "Names cannot contain # ^ [ ] | or %%",
  "instance": "/api/files",
  "code": "invalid-name",
  "path": "Ideas/Plan #2.md"
}
```

- `type` is always `urn:notesapp:problem:<code>`.
- `title` is fixed per code (the table below).
- `detail` is human-readable and may change. **Clients branch on `code`, never on `detail`.**

| code | HTTP | title | When | Extra properties |
|---|---|---|---|---|
| `bad-request` | 400 | Bad request | Malformed JSON, missing or invalid parameters or fields, limits out of range | `errors: FieldError[]` (may be empty) |
| `invalid-path` | 400 | Invalid path | The path breaks the safety rules (§1.3) | `path` |
| `invalid-name` | 400 | Invalid name | A new name breaks the new-name rules (§1.3) | `path` |
| `move-into-self` | 400 | Cannot move a folder into itself | A folder moved into itself or a descendant | `from`, `to` |
| `client-id-required` | 403 | Client id required | A mutating request without a valid `X-Client-Id` | |
| `cross-origin` | 403 | Cross-origin request rejected | The `Origin` or `Sec-Fetch-Site` check failed | |
| `identity-not-allowed` | 403 | Identity not allowed | No `Tailscale-User-Login` (a tagged device) or a login not in the allowlist | |
| `reserved-path` | 403 | Reserved path | A hidden or internal path (`.git`, `.notesapp`, `.trash`, any dot-segment) | `path` |
| `not-found` | 404 | Not found | No such file, folder, commit, trash entry or route | `path` (when applicable) |
| `method-not-allowed` | 405 | Method not allowed | | |
| `already-exists` | 409 | Already exists | The target path exists | `path`, `existingPath` |
| `case-collision` | 409 | Name differs only by case | A sibling with the same name ignoring case exists | `path`, `existingPath` |
| `type-mismatch` | 409 | Wrong entry type | A file was expected but a folder exists (or the reverse), a parent segment is a file, or a note was required | `path`, `expected: "file" \| "folder" \| "note"` |
| `version-conflict` | 409 | Version conflict | `baseVersion` does not match the server (§4) | `path`, `currentVersion`, `currentContent`, `currentMtime`, `movedTo` |
| `settings-read-only` | 409 | Settings are read-only | The settings file was written by a newer version, or fails validation (DESIGN §5.12) | `reason` |
| `task-conflict` | 409 | Task changed on the server | A task or list field in a `PATCH` was changed on the server since the client read it (its `base`, §20.4) | `task` (or `list`), `fields` |
| `malformed-file` | 409 | File cannot be read | A task operation needs a `.tasks` file that cannot be used: not valid JSON, not a task file, written by a newer version, or a copy that repeats another list's id. It is never rewritten (§20.1). | `path`, `reason` |
| `too-large` | 413 | Too large | Text over its size limit, a JSON body over 16 MiB, or an upload over 100 MiB | `limit` (bytes) |
| `not-text` | 415 | Not a text file | The text API was used on a non-text kind | `path`, `kind` |
| `unsupported-media-type` | 415 | Unsupported media type | A JSON endpoint received a non-JSON body | |
| `unknown-host` | 421 | Unknown host | The `Host` header is not in the server's allowlist | |
| `io-error` | 500 | Storage error | A filesystem error | `incidentId` |
| `permission-denied` | 500 | Permission denied | The server process may not write there (for example a folder created as root over SSH) | `path`, `incidentId` |
| `internal-error` | 500 | Internal error | A bug | `incidentId` |
| `busy` | 503 | Busy, retry | A lock timed out (5 s) | Header `Retry-After: 1` |
| `history-unavailable` | 503 | History unavailable | Git is disabled, the repo is unusable (detached `HEAD`, merge in progress, git-lfs), the startup import is still running, or a commit that must happen before an overwrite failed (§4) | `reason`: `"disabled"`, `"unusable: <detail>"`, `"importing"` or `"commit-failed"` |
| `insufficient-storage` | 507 | Insufficient storage | An upload would leave less than 1 GiB free | `limit` (bytes that must stay free) |
| `not-audio` | 415 | Not an audio or video file | A transcription of a file that is not `audio` or `video` (§23.2) | `path` |
| `transcription-off` | 409 | Transcription is off | No transcription service is configured (§23) | |
| `transcription-failed` | 503 | Transcription failed | The transcription service failed, could not be reached, took longer than its timeout, or was busy with other recordings for that long (§23.2). Never 502, which clients take for the proxy during a deploy | |
| `ai-unavailable` | 409 | Ask and summaries are unavailable | §24: switched off in Settings, or the server has no usable Anthropic API key | `reason`: `"off"` or `"not-configured"` |
| `ai-excluded` | 403 | Excluded from Ask and summaries | §24: the note, folder or selection named is under `settings.ai.excludedPaths` or `settings.files.excludedPaths` | `path` |
| `ai-budget-exceeded` | 429 | Monthly AI budget reached | §24: this month's estimated spend reached `settings.ai.monthlyBudgetUsd` | `limit` (the budget, USD), `spent` (USD) |

```ts
export interface FieldError { field: string; message: string }   // e.g. {"field":"settings.files.newNoteFolder","message":"invalid path"}
```

**How clients treat failures** (normative for the frontend, DESIGN §6.9):

| Class | Responses | Client behaviour |
|---|---|---|
| Transient | A network error; `502`; `504`; a `503` that is not problem+json; `503 busy`; any response whose `Content-Type` is neither `application/json` nor `application/problem+json` (during a deploy, `tailscale serve` answers an empty `502` for 10–30 s) | Keep the data, go offline, retry with backoff, honour `Retry-After` |
| Server storage | `io-error`, `internal-error`, `permission-denied`, `insufficient-storage` | Keep the data and the draft, retry with the same backoff, show a storage error |
| Terminal | Every other problem code | Handled by the flow that made the request; not retried automatically |

---

## 4. Version and conflict protocol

These rules are normative for every text-kind file (`note`, `text`) and for settings.

1. **Read** returns `content` and `version` (`GET /api/files`).
2. **Save** sends `{content, baseVersion}`, where `baseVersion` is the version the edit started from (`PUT /api/files`). `baseVersion: null` means "create this file; it must not exist".
3. The server evaluates, **in this order**, against the bytes currently on disk (not its index):
   1. **The file does not exist.**
      - `baseVersion` null: the file is created (with any missing parents) and the response is `201`.
      - `baseVersion` set: `409 version-conflict` with `currentVersion`, `currentContent` and `currentMtime` all `null`, meaning it was deleted or moved elsewhere. If the server knows the path was **moved** during its current run, `movedTo` carries the new path; otherwise `movedTo` is `null`.
   2. **The new content's bytes equal the bytes on disk:** `200` with the current version, **whatever `baseVersion` says**. Nothing is written and no event is sent. This makes every save idempotent: a retry of a save whose response was lost succeeds instead of reporting a conflict with its own text.
   3. **`baseVersion` differs from the disk** (including `null` for an existing file): `409 version-conflict`. Before answering, the server commits its current copy to git, including an external edit it has not indexed yet (DESIGN §5.4). The response body carries the server copy:
      ```json
      {
        "type": "urn:notesapp:problem:version-conflict",
        "title": "Version conflict",
        "status": 409,
        "detail": "File changed on the server",
        "instance": "/api/files",
        "code": "version-conflict",
        "path": "Projects/Plan.md",
        "currentVersion": "5d2f9c0e7b1a4c3d2e1f0a9b8c7d6e5f4a3b2c1d",
        "currentContent": "# Plan\n\nEdited on the iPhone.\n",
        "currentMtime": "2026-10-16T14:04:10.311Z",
        "movedTo": null
      }
      ```
   4. **`flushHistory: true`:** before writing, the server commits its current copy (and any pending history) to git. If git is enabled and that commit fails, the response is `503 history-unavailable` (`reason: "commit-failed"`) and nothing is written.
   5. Otherwise the server writes. The response carries the new `version`. Other clients receive `file.changed`.
4. **Resolving a conflict** (client's choice):

   | Choice | Request |
   |---|---|
   | Keep mine | `PUT {content: mine, baseVersion: currentVersion, flushHistory: true}` |
   | Take theirs | Adopt `currentContent` and `currentVersion` locally |
   | Merge | `PUT {content: merged, baseVersion: currentVersion, flushHistory: true}` |
   | Recreate a deleted file | `PUT /api/files?path=… {content: mine, baseVersion: null, flushHistory: true}` |
   | Follow a moved file (`movedTo` set) | `PUT /api/files?path=<movedTo> {content: mine, baseVersion: <the same baseVersion>}`. A pure move keeps the version; if the move also rewrote links in this note, this gets an ordinary 409. |

   `flushHistory` matters because a conflict detected through SSE (step 5 below) never produces a 409, so without the flag the other device's version could be overwritten before it was ever committed.
5. A `file.changed` SSE event whose `file.version` differs from your `baseVersion` means the same thing as a 409. Fetch the new content and either apply it (no local edits) or enter conflict (local edits). If the fetched content equals your text, adopt its version; there is no conflict. While one of your saves is in flight, defer the comparison until it settles. See DESIGN §6.10.
6. **Equal content is never a conflict.** A client that receives a 409 whose `currentContent` equals its own text adopts `currentVersion` and treats the save as done.

Settings follow the same protocol with `PUT /api/settings {settings, baseVersion}` (without `flushHistory` or `null` bases). Their `currentContent` is the settings JSON as a string.

---

## 5. Settings

### `GET /api/settings`

`200 SettingsResponse`:

```json
{
  "version": "a1f3c5e7b9d0a2c4e6f8b0d2f4a6c8e0b2d4f6a8",
  "settings": {
    "schemaVersion": 1,
    "files": {
      "newNoteLocation": "root",
      "newNoteFolder": "",
      "newLinkFormat": "shortest",
      "useWikilinks": true,
      "attachmentLocation": "folder",
      "attachmentFolder": "Attachments",
      "attachmentSubfolder": "attachments",
      "autoUpdateLinks": true,
      "excludedPaths": []
    },
    "dailyNotes": { "format": "YYYY-MM-DD", "folder": "Daily", "template": "", "openOnStartup": false },
    "templates": { "folder": "Templates", "dateFormat": "YYYY-MM-DD", "timeFormat": "HH:mm" },
    "editor": { "defaultMode": "edit", "readableLineLength": true, "strictLineBreaks": false },
    "ai": { "enabled": false, "provider": "claude-code", "model": "claude-sonnet-5-5", "excludedPaths": ["Private"],
            "maxContextChars": 60000, "monthlyBudgetUsd": 5.0 }
  },
  "readOnly": false
}
```

- `readOnly` is `true` when the file on disk was written by a newer version of the app or fails validation. The server then serves what it could read plus defaults, and refuses writes (DESIGN §5.12).
- Fields in the file that this version does not know are **preserved** on write.
- Per-device preferences (theme, spellcheck, autocorrect, remote images) are not vault settings; the client keeps them in `localStorage`.
- A vault's first start creates the settings from the defaults plus what its `.obsidian/` folder says, when it has one (ROADMAP item 24, DESIGN §5.23). The compatibility report (§11.5) shows the mapping and proposes it again later.

### `PUT /api/settings`

Request `SettingsUpdateRequest`: `{"settings": { ...full Settings... }, "baseVersion": "<version from GET>"}`.

| Status | Body |
|---|---|
| `200` | `SettingsResponse` with the new version. Other clients get `settings.changed`. |
| `400 bad-request` | `errors[]` |
| `409 version-conflict` | `currentContent` is the settings JSON string |
| `409 settings-read-only` | `reason` |

**Validation.** All groups and fields are required.

| Field | Rule |
|---|---|
| `schemaVersion` | Must be `1` |
| `newNoteFolder`, `attachmentFolder`, `dailyNotes.folder`, `templates.folder` | `""` or a valid folder path (safety rules, no dot-segments) |
| `attachmentSubfolder` | A single valid name segment |
| `dailyNotes.template` | `""` or a valid file path (it need not exist) |
| `format`, `dateFormat`, `timeFormat` | 1 to 100 characters |
| `excludedPaths` | At most 100 valid paths (folder or file prefixes, matched case-insensitively) |
| Enums | Exactly the strings in §17 |
| `ai` (ROADMAP item 18) | **Optional**, unlike the other groups: it came after schema version 1, so a file or a request without it, or without one of its fields, is valid. A request without `ai` keeps the current values (an old page cannot switch it off by accident); a file without it gets the defaults. A field that is present must be valid: `enabled` a boolean; `provider` `claude-code` or `api`; `model` one of `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`; `excludedPaths` as `files.excludedPaths`; `maxContextChars` an integer from 4,000 to 400,000; `monthlyBudgetUsd` a number above 0 and at most 10,000. |

**Semantics.**

| Setting | Meaning |
|---|---|
| `newNoteLocation` | Where links-to-create and new notes go: `root` gives `""`, `current` gives the source note's folder, `folder` gives `newNoteFolder`. |
| `newLinkFormat` | Link text generation (§15.3): `shortest`, `relative` or `absolute`. |
| `useWikilinks` | `true` generates `[[...]]`; `false` generates `[text](path.md)`. |
| `attachmentLocation` | `root` gives `""`, `folder` gives `attachmentFolder`, `current` gives the source note's folder, `subfolder` gives the source note's folder plus `/` plus `attachmentSubfolder`. |
| `autoUpdateLinks` | The default for `MoveRequest.updateLinks`. |
| `excludedPaths` | Excluded from search results (§12.1) and from unlinked mentions (§11.2). |
| `dailyNotes.*`, `templates.*` | See §15.2 and §15.4. |
| `editor.*` | UI preferences that apply on all devices. `strictLineBreaks: false` (the default, as in Obsidian) renders a single newline as a line break in reading view. |
| `ai.*` | Ask your vault and summaries (§24). `enabled` is off by default: until it is on, nothing is ever sent to Anthropic. `provider`: `claude-code` (default), the server's Claude Code CLI with the user's Claude subscription, or `api`, the Anthropic API billed per token. `excludedPaths` (default `["Private"]`) and `files.excludedPaths` are never read for a request. `maxContextChars` caps the note text of one request, earlier turns included; `monthlyBudgetUsd` refuses requests once the month's estimated spend reaches it. |

---

## 6. Identity, status and health

### 6.1 `GET /api/me`

`200 MeResponse`:

```json
{ "login": "rjgehan@github", "name": "R. J. Gehan", "profilePicUrl": "https://avatars.githubusercontent.com/u/123?v=4", "source": "tailscale" }
```

- Values come from `Tailscale-User-Login`, `Tailscale-User-Name` (RFC 2047-decoded) and `Tailscale-User-Profile-Pic`.
- In production a request without an allowed login never gets here (`403 identity-not-allowed`). In the dev profile, a missing login gives `{"login": "owner@notes", "name": "Owner", "profilePicUrl": null, "source": "default"}`, with values from configuration.
- An empty profile picture header becomes `null`.

### 6.2 `GET /api/status`

`200 StatusResponse`:

```json
{
  "appVersion": "0.0.1-SNAPSHOT",
  "buildSha": "4e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f",
  "bootId": "mgbx3k2a",
  "startedAt": "2026-10-16T13:58:01.004Z",
  "eventId": "mgbx3k2a.1045",
  "vault": { "notes": 812, "files": 1034, "folders": 57, "bytes": 48211934,
             "skipped": [ { "name": "Old/Re\\port.md", "reason": "unsafe-name" } ],
             "unwritableDirs": [] },
  "index": { "builtInMs": 1830, "lastRescanAt": "2026-10-16T14:03:01.552Z" },
  "git": { "enabled": true, "state": "ready", "reason": null, "head": "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
           "pendingPaths": 2, "nextCommitAt": "2026-10-16T14:05:30.000Z",
           "lastCommitAt": "2026-10-16T14:01:12.000Z", "lastError": null, "failingSince": null,
           "largeFiles": { "limitBytes": 26214400, "files": 3, "bytes": 412090368 } },
  "watcher": { "mode": "inotify" },
  "disk": { "freeBytes": 182736451584, "repoBytes": 91234567 },
  "settings": { "readOnly": false, "reason": null },
  "mirror": { "state": "ready", "reason": null, "remote": "https://github.com/rjgehan/notes-vault.git",
              "branch": "main", "pushing": false, "pushedCommit": "8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c",
              "lastPushAt": "2026-10-16T13:52:40.118Z", "nextPushAt": "2026-10-16T14:11:12.000Z",
              "lastError": null, "failingSince": null }
}
```

`eventId` is read **before** the snapshot is taken (§16.2).

| Field | Values |
|---|---|
| `vault.skipped` | Files on disk that are not indexed: `unsafe-name` (the name contains `\` or a control character) or `nfc-shadowed` (another on-disk name normalizes to the same NFC path). `name` is the on-disk path, decoded leniently. |
| `vault.unwritableDirs` | Folders the server process cannot write to (found by the rescan); saves there fail with `permission-denied`. |
| `watcher.mode` | `inotify`, `polling` (watcher failed; rescans only) or `disabled` |
| `git.state` | `ready`; `importing` (the startup commit is running after readiness); `failing` (commits fail and are being retried; `lastError` and `failingSince` are set); `disabled` (`enabled` is false) |
| `git.reason` | Non-null when `enabled` is false, for example `"disabled by configuration"`, `"HEAD is detached"` or `"git-lfs is not supported"` |
| `git.largeFiles` | The large-file policy (DESIGN §5.8): files larger than `limitBytes` (`notes.git.large-file-threshold`, 25 MiB by default) stay in the vault but out of git history. `files` and `bytes` count the files the app lists (§7); hidden files over the threshold are kept out of history too but not counted. `limitBytes` is `null` when the policy is off (threshold 0); otherwise it is at least the largest text size limit (the server refuses to start with a lower threshold). |
| `disk.repoBytes` | Size of `.git` (the history), measured by the last rescan; `null` before the first one |
| `settings` | `readOnly` and its `reason` (§5) |
| `mirror` | The push mirror of the history (§6.4, DESIGN §5.8), a `MirrorStatus` |
| `mirror.state` | `disabled` (`reason` says why: `"not configured"`, `"history is disabled"`, or a configuration error such as a URL that is not `https://`; a configuration error is a problem the clients warn about, since such a mirror never pushes); `ready` (new commits are pushed about 10 minutes after the last one); `failing` (pushes fail and are retried with backoff; `lastError` and `failingSince` are set); `diverged` (the mirror has commits the vault's history lacks; nothing is pushed until §6.4 is called again, and NotesApp never force-pushes) |
| `mirror.remote` | The mirror's URL. It never contains credentials: a URL with any is refused (`disabled`). |
| `mirror.pushedCommit`, `mirror.lastPushAt` | The last commit the mirror is known to have and when it was pushed, during this server run; `null` until the first push |
| `mirror.nextPushAt` | When the next push is due (after a failure: the next retry); `null` when the mirror is up to date, disabled or diverged |
| `mirror.lastError` | A short error text; never contains the token |
| `buildSha` | `"dev"` outside the Docker image |

A `status.changed` event (§16.4) is sent whenever `git.state`, `watcher.mode`, `settings.readOnly` or `mirror.state` changes, when free space on the vault's filesystem crosses 1 GiB, and when a push requested with §6.4 ends.

### 6.3 Health

These endpoints need no `X-Client-Id`, and they are exempt from the Host and identity checks. They are not under `/api`.

| Endpoint | Response |
|---|---|
| `GET /actuator/health` | `200 {"status":"UP"}` or `503 {"status":"DOWN"}` (including when free space on the vault's filesystem is below 1 GiB). Spring Boot also lists the probe groups, as in `{"groups":["liveness","readiness"],"status":"UP"}`; clients read only `status`. |
| `GET /livez` | Liveness: `200 {"status":"UP"}` |
| `GET /readyz` | Readiness: `200 {"status":"UP"}`, or `503 {"status":"OUT_OF_SERVICE"}` during shutdown |

**During startup the port is closed**: the app indexes the vault before Tomcat listens, so a request through `tailscale serve` gets serve's own `502` with an empty body, not a `503`. The same happens for the 10–30 s of every deploy. Clients treat it as transient (§3).

### 6.4 `POST /api/mirror/push`

No body. Pushes the history to the mirror now instead of waiting for the delay, also while backing off after failures and after the mirror has diverged (once it has been fixed). The push runs in the background: the response is `202 MirrorStatus` (§6.2) with `pushing: true`, and a `status.changed` event (reason `mirror`) follows when it ends; `GET /api/status` then shows the outcome.

| Errors |
|---|
| `400 bad-request` when the mirror is off (`detail` says why) |

### 6.5 `GET /api/status/details`

What the status page (`/x/status`, ROADMAP item 38) shows beyond §6.2. Some of it costs more to gather (the commit count walks the history; it is cached per `HEAD`), so the status bar never asks for it. `200 StatusDetails`:

```json
{
  "runtime": { "javaVersion": "25.0.4.1+1-LTS", "javaVendor": "Eclipse Adoptium", "aotCache": "in-use",
               "heapUsedBytes": 83886080, "heapMaxBytes": 805306368, "processors": 4 },
  "events": { "clients": 3 },
  "git": { "commits": 4312, "commitsThisRun": 12, "failedCommitsThisRun": 0,
           "largeFiles": [ { "path": "Media/Talk.mp4", "bytes": 314572800 } ], "largeFilesTruncated": false },
  "disk": { "totalBytes": 499963174912 },
  "backup": { "state": "ok", "reason": null, "lastRun": "2026-10-17T08:00:41.000Z",
              "lastSuccess": "2026-10-17T08:00:41.000Z", "snapshot": "4f1c2a9b", "offsite": "ok", "failures": null },
  "alerts": { "state": "on", "reason": null, "server": "https://ntfy.sh", "sent": 2, "dropped": 0,
              "lastSentAt": "2026-10-17T10:12:03.551Z", "lastError": null, "lastErrorAt": null,
              "recent": [ { "marker": "GIT_MIRROR_FAILED", "count": 2, "lastAt": "2026-10-17T10:12:03.204Z" } ] }
}
```

| Field | Values |
|---|---|
| `runtime.aotCache` | The JVM's AOT cache (DESIGN §7.1): `in-use`; `not-used` (the JVM was given the image's cache but could not use it, for example a cache made by another JVM build); `off` (no cache given: outside the image, or a JVM older than 25); `unknown` (the JVM does not say) |
| `events.clients` | Open live-sync connections (§16): one per browser tab or app window, the asking one included |
| `git.commits` | Commits reachable from `HEAD`; `null` when history is off. `commitsThisRun` and `failedCommitsThisRun` (failed commit attempts, retries included) count from the server's start. |
| `git.largeFiles` | The files kept out of history (§14.1, DESIGN §5.8), largest first, at most 100; `largeFilesTruncated` when there are more. Their count and total are in `/api/status` (`git.largeFiles`). |
| `disk.totalBytes` | The size of the vault's filesystem; `null` when it cannot be read. Free space is `disk.freeBytes` in §6.2. |
| `backup` | The nightly backups (ROADMAP item 1), from the last run's `status.json`, mounted read-only into the app (DESIGN §7.10). `state`: `ok`; `failed` (the last run failed; `failures` lists the failed steps); `stale` (the last success is older than 36 hours, or there has been none); `unknown` (no status file: backups are not set up or not mounted; `reason` says so, and the other fields are `null`). `offsite` is `ok`, `off` (no off-site repository) or `failed`. |
| `alerts` | App-error alerts (DESIGN §5.18.1). `state`: `on` (markers are pushed to ntfy at `server`); `off` (`reason`: `"not configured"` when there is no `ntfy.json`, or `"switched off in ntfy.json"`); `error` (`ntfy.json` exists but cannot be used; `reason` says why). `server` never contains the topic or the token. `sent`, `dropped` (held back by the rate limit), `lastSentAt`, `lastError` and `lastErrorAt` cover this server run. |
| `alerts.recent` | The stable log markers (DESIGN §5.18) logged since the server started, whether or not alerts are on, most recent first |

No `status.changed` event is sent for these fields: the page refreshes them every 30 seconds, and whenever it refreshes `/api/status`.

### 6.6 `POST /api/alerts/test`

No body. Sends a test alert to the alerts topic now, so the status page can show at once whether ntfy accepts it (DESIGN §5.18.1). It counts toward the hourly limit of alerts. `200 AlertTestResult`:

```json
{ "sent": false, "error": "IOException: ntfy answered HTTP 403" }
```

`error` is a short text, `null` when `sent` is true; it never contains the topic or the token. `alerts.lastSentAt` or `alerts.lastError` in §6.5 change accordingly.

| Errors |
|---|
| `400 bad-request` when app alerts are off (`detail` says why: no `ntfy.json`, switched off in it, or what is wrong with it) |

---

## 7. Tree (also the note list for the quick switcher and autocomplete)

### `GET /api/tree`

`200 TreeResponse`. This is every visible folder and file. Hidden and dot entries are never included. `folders` is sorted by path case-insensitively; `files` is sorted by path.

```json
{
  "eventId": "mgbx3k2a.1042",
  "folders": [
    { "path": "Attachments", "name": "Attachments" },
    { "path": "Daily", "name": "Daily" },
    { "path": "Projects", "name": "Projects" },
    { "path": "Projects/Alpha", "name": "Alpha" }
  ],
  "files": [
    { "path": "Attachments/Pasted image 20261016140322.png", "name": "Pasted image 20261016140322.png",
      "basename": "Pasted image 20261016140322", "extension": "png", "kind": "image",
      "size": 183422, "mtime": "2026-10-16T14:03:23.004Z", "version": null, "aliases": [] },
    { "path": "Projects/Plan.md", "name": "Plan.md", "basename": "Plan", "extension": "md", "kind": "note",
      "size": 98, "mtime": "2026-10-16T14:03:22.120Z",
      "version": "9f0c2c7d1e9a4f0b6e5d3c2b1a0f9e8d7c6b5a49", "aliases": ["Roadmap"] },
    { "path": "Welcome.md", "name": "Welcome.md", "basename": "Welcome", "extension": "md", "kind": "note",
      "size": 1834, "mtime": "2026-10-16T13:58:02.511Z",
      "version": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad", "aliases": [] }
  ]
}
```

**`FileEntry` fields:**

| Field | Meaning |
|---|---|
| `name` | The last path segment |
| `basename` | `name` without its final extension (`Budget.sheet` gives `Budget`; `archive.tar.gz` gives `archive.tar`). A name with no `.`, or one starting with `.`, is its own basename. |
| `extension` | Lower-case, without the dot; `""` if none |
| `kind` | As defined in DESIGN §4.2 |
| `version` | Non-null only for `note` and `text` files within their size limit |
| `aliases` | Frontmatter aliases for notes; `[]` for everything else |

**Usage notes.**

- `eventId` is the SSE position read **just before** the snapshot was taken. Pass it as `lastEventId` when opening `/api/events` so no change is missed (§16.5). An event replayed after it may already be reflected in the snapshot; applying it again changes nothing.
- `size` and `mtime` also build content-addressed raw URLs: `v=<size>-<mtimeEpochMillis>` (§9.1).
- There is **no separate note-list endpoint**. The quick switcher and `[[` autocomplete use `files` (with `aliases`) from this response, kept current by SSE events that carry full `FileEntry` objects.

---

## 8. Text files

These endpoints work on files of kind `note` or `text`. Other kinds return `415 not-text`.

### 8.1 `GET /api/files?path={path}`

`200 TextFile`:

```json
{
  "path": "Projects/Plan.md",
  "kind": "note",
  "content": "---\naliases: [Roadmap]\ntags: [project]\n---\n# Plan\n\nSee [[Welcome]] and #project/alpha.\n",
  "version": "9f0c2c7d1e9a4f0b6e5d3c2b1a0f9e8d7c6b5a49",
  "size": 98,
  "mtime": "2026-10-16T14:03:22.120Z",
  "lossy": false
}
```

- A leading UTF-8 BOM is not included in `content`; `version` still hashes the disk bytes, and the server re-adds the BOM when the file is saved.
- Line endings are returned as they are on disk. All offsets the API reports for this file refer to this exact `content` (§1.4).
- `lossy: true` means invalid UTF-8 was replaced with U+FFFD. Clients must treat such a file as read-only.

| Errors |
|---|
| `400 invalid-path`, `403 reserved-path`, `404 not-found` |
| `409 type-mismatch` (`expected: "file"`) when the path is a folder |
| `413 too-large` over the file's size limit (use §9.1 instead) |
| `415 not-text` |

### 8.2 `POST /api/files`: create

Request `CreateFileRequest`:

```json
{ "path": "Projects/Untitled.md", "content": "", "onConflict": "rename" }
```

| Field | Default | Meaning |
|---|---|---|
| `content` | `""` | |
| `onConflict` | `"fail"` | `"fail"` returns 409 if the path, or a case variant of it, exists. `"rename"` picks the first free name by inserting ` 1`, ` 2`, ... up to ` 999` before the extension (`Untitled.md`, then `Untitled 1.md`, ...). |

- The path is a **new** name (§1.3).
- Creation never replaces an existing file, even under a concurrent create (DESIGN §5.4, no-clobber create).
- Missing parent folders are created; implicit parents resolve case-insensitively to existing folders. The created folders are listed outermost first in `createdFolders`, and each one also produces a `folder.created` event.
- The extension must be a text kind; otherwise `415 not-text`.
- Send an `Idempotency-Key` (§2), so a retry after a lost response does not create a second note.

`201 WriteResult`, with header `Location: /api/files?path=Projects%2FUntitled%201.md`:

```json
{
  "file": { "path": "Projects/Untitled 1.md", "name": "Untitled 1.md", "basename": "Untitled 1", "extension": "md",
            "kind": "note", "size": 0, "mtime": "2026-10-16T14:10:00.004Z",
            "version": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "aliases": [] },
  "created": true,
  "createdFolders": []
}
```

| Errors |
|---|
| `400 invalid-path` / `invalid-name`, `403 reserved-path` |
| `409 already-exists` / `case-collision` (with `existingPath`) |
| `409 type-mismatch` (a parent segment is a file) |
| `413 too-large`, `415 not-text` |

Events to other clients: `folder.created` (for each created folder), then `file.created`.

### 8.3 `PUT /api/files?path={path}`: save

Request `SaveFileRequest`:

```json
{ "content": "# Plan\n\nUpdated text.\n", "baseVersion": "9f0c2c7d1e9a4f0b6e5d3c2b1a0f9e8d7c6b5a49", "flushHistory": false }
```

| Field | Meaning |
|---|---|
| `content` | The full new text. The server encodes it as UTF-8 and re-adds a BOM if the file currently has one. |
| `baseVersion` | The version the edit started from, or `null` to create a file that does not exist. A missing field is treated as `null`, which is safe: for an existing file it can only produce a 409. The rules and their order are in §4. |
| `flushHistory` | Optional, default `false`. When `true`, the server commits its current copy to git before overwriting it, and answers `503 history-unavailable` instead of writing if that commit fails. Clients set it for Keep mine, Save merged and Recreate. |

`200 WriteResult` (`created: false`, `createdFolders: []`). `file.version` is the new version, or the current version when the content was already on disk (an idempotent retry). `201 WriteResult` (`created: true`) when `baseVersion` was `null` and the file was created; its missing parents are in `createdFolders`. Creating through `PUT` does not apply the new-name rules (§1.3).

| Errors |
|---|
| `400`, `403` |
| `409 version-conflict` (§4), with `movedTo` when the path was moved |
| `409 type-mismatch` |
| `413 too-large`, `415 not-text` |
| `503 history-unavailable` (`reason: "commit-failed"`) with `flushHistory: true` |

Events to other clients: `file.changed` (or `folder.created` and `file.created` for a create), plus a later `history.committed` once the batch commits.

### 8.4 `DELETE /api/files?path={path}`: move to trash

`200 TrashEntry` (§13):

```json
{ "id": "01JA7Q3M9K2Z", "originalPath": "Projects/Old plan.md", "type": "file",
  "deletedAt": "2026-10-16T14:12:40.120Z", "deletedBy": "rjgehan@github", "size": 2311, "fileCount": 1 }
```

- This works for **any** file kind, and for existing names that break the new-name rules.
- Folders must use `DELETE /api/folders`; a folder path here returns `409 type-mismatch` (`expected: "file"`).
- Links to the deleted file become unresolved.
- The file's last content is committed to git before it moves to the trash, including an external edit the server has not indexed yet.

| Errors |
|---|
| `400`, `403`, `404 not-found`, `409 type-mismatch` |

Events, in this order: `file.deleted {trashed: true, trashId}`, `trash.changed`, `history.committed` (only if a commit was made).

### 8.5 `POST /api/capture`: quick capture

*(ROADMAP item 7, added 2026-10-21.)* Appends one entry to `Inbox.md` at the vault root or to today's daily note, creating the note when it does not exist. Used by the app's capture box and share target (DESIGN §6.27) and by an iOS Shortcut.

Request `CaptureRequest`:

```json
{ "text": "Call the plumber", "target": "inbox", "url": null, "title": null, "date": "2026-10-16", "time": "14:03", "tz": "America/New_York" }
```

| Field | Default | Meaning |
|---|---|---|
| `text` | | The thought. May span lines. |
| `target` | `"inbox"` | `"inbox"` (`Inbox.md`) or `"daily"` (today's daily note, path from `settings.dailyNotes` as in §15.2). |
| `url`, `title` | | A shared link and its label. An `http`/`https` URL becomes `[title](url)` (or `<url>` without a title) after the text, unless the text already contains it; anything else is appended as plain text. At most 4,096 and 1,000 characters. |
| `date`, `time` | | **"Today" is decided on the device** (DESIGN risk 20): its local date (`YYYY-MM-DD`) and time (`HH:mm`). |
| `tz` | | The device's IANA time zone, for whatever `date` and `time` leave out. Without either, the server's own zone (`TZ`, UTC by default) is the fallback. |

At least one of `text` and `url` is required.

**The entry** is one list item, `- <stamp> <text>`, with any further lines indented two spaces under it. The stamp is `templates.dateFormat` + space + `templates.timeFormat` in the inbox (`2026-10-16 14:03`) and `templates.timeFormat` alone in a daily note (`14:03`).

- The entry starts on a new line and ends with one. An existing file keeps its bytes exactly (BOM, invalid UTF-8); the entry follows its line endings (CRLF when every line break in it is CRLF).
- An existing note is found ignoring case (`daily/2026-10-16.MD` is appended to, not shadowed).
- A new daily note starts with its rendered template (`dailyNotes.template`, placeholders as in §15.4, with `title` the note's name and "now" the capture's date and time); a missing template means an empty start. Its missing parent folders are created.
- Nothing is replaced, so a capture never conflicts. Other clients get `file.changed` (or `folder.created` and `file.created`); an open note with unsaved edits there enters the ordinary conflict flow (§4 step 5).
- Send an `Idempotency-Key` (§2): a retried capture whose response was lost is not appended twice.
- Mutations need `X-Client-Id` (§2). A Shortcut sends a fixed id of its own, for example `ios-shortcut-capture`; it sends no `Origin`, so the Origin checks pass.

`201 CaptureResult` when the capture created the note, `200` when it appended to it:

```json
{
  "file": { "path": "Inbox.md", "name": "Inbox.md", "basename": "Inbox", "extension": "md", "kind": "note",
            "size": 74, "mtime": "2026-10-16T18:03:00.120Z", "version": "4f…", "aliases": [] },
  "created": false,
  "createdFolders": [],
  "target": "inbox",
  "attachment": null
}
```

| Errors |
|---|
| `400 bad-request` (no text or URL; `date`, `time` or `tz` invalid; `target` unknown; with `errors[]`) |
| `400 invalid-path` / `invalid-name` (the daily-note format produces an invalid name) |
| `409 already-exists` / `type-mismatch` (a folder at the note's path) |
| `413 too-large` (the note would exceed its size limit), `415 not-text` |

### 8.6 `POST /api/capture/file?name={fileName}[&text=][&target=][&date=][&time=][&tz=]`: capture a file

The body is the raw bytes (like §9.3). The file is stored as an attachment of the target note (folder from `settings.files.attachmentLocation`, name sanitized and de-duplicated as in §9.3), then one entry is appended with `text` as the caption and the attachment's embed on the next line:

```
- 16:20 Whiteboard
  ![[IMG 0001.jpg]]
```

The query parameters mean what the §8.5 fields mean. The response is a `CaptureResult` whose `attachment` is the stored file. Send an `Idempotency-Key`. Errors: those of §8.5 and §9.3 (`413`, `507`). Events: `folder.created` as needed, `file.created` for the attachment, then the note's event.

---

## 9. Raw files and uploads

### 9.1 `GET /api/files/raw?path={path}[&v={size}-{mtimeMillis}][&download=true]`

This returns the raw bytes of any visible file. It supports `Range` (206) and conditional requests (304). It is used for `<img>`, `<audio>` and `<video>` sources, by the PDF viewer (PDF.js reads a PDF in `Range` requests of 64 KiB, DESIGN §6.8.3) and for downloads. Symlinks are never served (`404`).

- `v` makes the URL content-addressed. Clients build it from the tree entry's `size` and `mtime` (epoch milliseconds). When it matches the file, the response is cacheable forever; otherwise it is served like a request without `v`.
- `download=true` forces `Content-Disposition: attachment`.

**Response headers:**

| Header | Value |
|---|---|
| `Content-Type` | Detected from the extension. `text/*` gets `; charset=utf-8`. `.md` is sent as `text/plain; charset=utf-8`. **HTML, XHTML, XML and JavaScript are sent as `application/octet-stream`.** |
| `Content-Disposition` | `inline; filename*=UTF-8''<pct-encoded name>` for the inline allowlist: `image/png`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg+xml`, `application/pdf`, `audio/*`, `video/*`, `text/plain`. Everything else gets `attachment; filename*=…`. `download=true` forces `attachment`. |
| `Content-Security-Policy` | `sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'`, except PDF, which gets `default-src 'none'; frame-ancestors 'self'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `private, max-age=31536000, immutable` when `v` matches the file; otherwise `no-cache` |
| `ETag` | `W/"<size>-<mtimeEpochMillis>"` |
| `Last-Modified` | The file's mtime |
| `Accept-Ranges` | `bytes` |

**Statuses:** `200`, `206 Partial Content`, `304 Not Modified`, `416 Range Not Satisfiable`. Errors are problem+json: `400`, `403`, `404`, `409 type-mismatch` (folder).

The frontend builds raw URLs with `fileUrl(entry) = '/api/files/raw?path=' + encodeURIComponent(entry.path) + '&v=' + entry.size + '-' + Date.parse(entry.mtime)`.

### 9.2 `PUT /api/files/raw?path={path}[&onConflict=fail|rename|overwrite]`

This uploads bytes to an exact path. It is used when dropping OS files onto an explorer folder, and by future view types that write binary files.

- The body is the raw bytes. The server streams it to a temp file before taking any lock.
- `onConflict` (default `fail`):
  - `fail`: an existing file (or a case variant) returns `409 already-exists` / `case-collision`.
  - `rename`: the server inserts ` 1`, ` 2`, ... before the extension and returns the final path in `file.path`.
  - `overwrite`: an existing **non-text** file is replaced, after its current content is committed to git (`503 history-unavailable` and no write if that commit fails); a case variant still returns 409. Overwriting a `note` or `text` file is refused with `400 bad-request`; use `PUT /api/files`, which has the conflict protocol. A file over the large-file threshold (§6.2 `git.largeFiles`) is not in history, so a copy of the replaced file goes to the trash instead (events: `file.changed`, then `trash.changed`).
- A new path is a **new** name (§1.3). Creation never replaces an existing file, even under a concurrent create.
- A text-kind path is indexed like a save.
- Send an `Idempotency-Key` (§2).

| Status | Body |
|---|---|
| `201` (new) | `WriteResult` |
| `200` (overwritten) | `WriteResult` |

| Errors |
|---|
| `400 invalid-path` / `invalid-name` / `bad-request` (text overwrite), `403` |
| `409 already-exists` / `case-collision` / `type-mismatch` |
| `413 too-large` |
| `503 history-unavailable` (overwrite only) |
| `507 insufficient-storage` |

Events: `folder.created` as needed, then `file.created` or `file.changed`.

### 9.3 `POST /api/attachments?name={fileName}[&source={notePath}]`

This is for pasting or dropping an attachment into a note. The server chooses the folder and the final name.

| Parameter | Meaning |
|---|---|
| `name` (**required**) | The desired file name, for example `Pasted image 20261016140322.png`. The client names pasted images with **local** time, as `Pasted image YYYYMMDDHHmmss.<ext>`. The server **sanitizes** it instead of rejecting it, in this order: keep only the part after the last `/` or `\`; NFC-normalize; replace control characters and every character forbidden by the safety or new-name rules (`: * ? " < > \| # ^ [ ]`, and each `%%`) with `-`; collapse whitespace; strip leading dots and spaces and trailing dots and spaces; prefix `_` to a Windows reserved basename; append `.file` to a name the server would ignore; truncate the basename so the name fits 240 UTF-8 bytes; use `attachment` for an empty basename. Vectors: `a/b.png` → `b.png`, `../x.png` → `x.png`, `.env` → `env`, `con.png` → `_con.png`, `x.tmp` → `x.tmp.file`, `notes .` → `notes`, `a:b?.png` → `a-b-.png`, `.png` → `attachment.png`. |
| `source` (optional) | The note the attachment is for. Used by the `current` and `subfolder` locations and by link-text generation. If omitted, the folder is computed as if the source were at the vault root. |
| Body | The raw bytes |

**Folder:** from `settings.files.attachmentLocation` (§5). It is created if missing; an existing folder that differs only by case is reused.

**Name:** de-duplicated case-insensitively by inserting ` 1`, ` 2`, ... before the extension, never replacing an existing file.

Send an `Idempotency-Key` (§2), so a retried upload does not create `image 1.png`.

`201 AttachmentResult`:

```json
{
  "file": { "path": "Attachments/Pasted image 20261016140322.png", "name": "Pasted image 20261016140322.png",
            "basename": "Pasted image 20261016140322", "extension": "png", "kind": "image",
            "size": 183422, "mtime": "2026-10-16T14:03:23.004Z", "version": null, "aliases": [] },
  "created": true,
  "createdFolders": ["Attachments"],
  "linkText": "Pasted image 20261016140322.png",
  "markdown": "![[Pasted image 20261016140322.png]]"
}
```

- `linkText` is the **unencoded** link text: `linkText(file.path, source, settings.newLinkFormat, "wiki")` from §15.3. It is for display and for building other links.
- `markdown` is the full embed to insert, already in the configured style. **Clients always insert `markdown` as is.**
  - `useWikilinks` true: `![[<linkText>]]`;
  - `useWikilinks` false: `![](<linkText(file.path, source, settings.newLinkFormat, "markdown")>)`. Markdown-style link text is already percent-encoded by §15.3, so it is not encoded again: for example `![](Pasted%20image%2020261016140322.png)`.

| Errors |
|---|
| `400 bad-request` (missing `name`), `400 invalid-path` (`source`), `403` |
| `413 too-large` |
| `507 insufficient-storage` |

Events: `folder.created` as needed, then `file.created`.

---

## 10. Folders and move or rename

### 10.1 `POST /api/folders`

Request `CreateFolderRequest`: `{"path": "Projects/Beta"}`. Missing parents are created as well.

`201 FolderResult`:

```json
{ "folder": { "path": "Projects/Beta", "name": "Beta" }, "createdFolders": ["Projects/Beta"] }
```

`createdFolders` lists every folder this call created, outermost first, including `folder` itself.

| Errors |
|---|
| `400 invalid-path` / `invalid-name`, `403` |
| `409 already-exists` / `case-collision` / `type-mismatch` |

Events: `folder.created` for each created folder.

### 10.2 `DELETE /api/folders?path={path}`

Moves the folder and everything in it to the trash as **one** trash entry.

`200 TrashEntry`, with `type: "folder"` and `fileCount` set to the number of files. The folder becomes one top-level trash entry (§13).

| Errors |
|---|
| `400`, `403`, `404` |
| `409 type-mismatch` (`expected: "folder"`) |

Events, in this order: `folder.deleted {trashed: true, trashId}`, `trash.changed`, `history.committed`. No separate `file.deleted` events are sent for the descendants; clients remove everything under the path. Deleting an **empty** folder makes no commit, so no `history.committed` is sent.

### 10.3 `POST /api/move`: move or rename a file or folder

Request `MoveRequest`:

```json
{ "from": "Projects/Plan.md", "to": "Projects/Roadmap.md", "updateLinks": true, "dryRun": false }
```

| Field | Default | Meaning |
|---|---|---|
| `updateLinks` | `settings.files.autoUpdateLinks` | Rewrite links that point at the moved entry (and protect other links); DESIGN §5.6 |
| `dryRun` | `false` | Compute and return the plan without changing anything. The Move dialog uses it for its "N notes will be updated" preview. |

- A rename is a move within the same folder. The client keeps the extension unless the user explicitly changes it.
- `from` is an existing path (any existing name works, §1.3); `to` is a **new** name. Implicit parents of `to` resolve case-insensitively.
- A case-only rename (`plan.md` to `Plan.md`) is allowed.
- **Clients must flush all unsaved edits before calling** (DESIGN §6.9), because other notes may be rewritten.
- The server makes **two** commits: a pure rename (so per-note history follows the file), then, if any note was rewritten, the link updates.

`200 MoveResult`:

```json
{
  "dryRun": false,
  "type": "file",
  "from": "Projects/Plan.md",
  "to": "Projects/Roadmap.md",
  "moved": [ { "from": "Projects/Plan.md", "to": "Projects/Roadmap.md" } ],
  "createdFolders": [],
  "linkUpdates": [
    { "path": "Welcome.md", "links": 2, "version": "0b9e8d7c6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c" },
    { "path": "Daily/2026-10-15.md", "links": 1, "version": "7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b" }
  ],
  "failed": [],
  "commitId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"
}
```

| Field | Meaning |
|---|---|
| `moved` | Every moved **file** (for folders, all descendants), as old and new paths |
| `createdFolders` | Missing parents of `to` that the move created, outermost first. The caller adds them itself, because its own `folder.created` events are not echoed. `[]` in a dry run. |
| `linkUpdates` | Notes whose text was (or, in a dry run, would be) rewritten. Paths are post-move. `version` is the new version, or `null` when `dryRun`. **The calling client applies these itself**, because its own `file.changed` events are not echoed: refresh the open sessions and update the tree versions. |
| `failed` | Notes whose links could not be updated, as `{path, reason}`; the move itself still happened. `reason` is `not-utf8` (the note is not valid UTF-8 and is never rewritten), `not-rewritable` (a frontmatter link whose source text does not match its parsed value, such as an escaped quoted string, or a link in an indexed document that the server cannot write back, §1.8: any link of an `.excalidraw` drawing or a `.sheet` spreadsheet, a link only an `.excalidraw.md` drawing's JSON holds, or a link in a `.tasks` list that is not valid or was written by a newer version, §20.9), `span-mismatch` (the note changed in a way that invalidated the plan) or `io-error`. |
| `commitId` | The **last** commit made (the link-update commit when there is one, otherwise the rename commit). `null` when `dryRun`, when git is disabled, when nothing was committed (an empty folder), or when the commit failed and is being retried |

| Errors |
|---|
| `400 invalid-path` / `invalid-name` / `move-into-self`, `403` |
| `404 not-found` (`from`) |
| `409 already-exists` / `case-collision` / `type-mismatch` (a parent of `to` is a file) |

Events to other clients, in this order: `folder.created` for new target parents, `entry.moved`, `file.changed` for each rewritten note, then one `history.committed` per commit made. For a folder move, the source folder's disappearance is implied by `entry.moved` with `type: "folder"`.

---

## 11. Notes and links

### 11.1 `GET /api/notes/meta?path={notePath}`

`200 NoteMeta`. This is parsed metadata for a note. It is used for `[[Note#` heading completion and may be used for outgoing-link displays.

```json
{
  "path": "Projects/Plan.md",
  "version": "9f0c2c7d1e9a4f0b6e5d3c2b1a0f9e8d7c6b5a49",
  "frontmatter": { "aliases": ["Roadmap"], "tags": ["project"], "due": "2026-11-01" },
  "frontmatterError": null,
  "aliases": ["Roadmap"],
  "tags": ["project", "project/alpha"],
  "headings": [ { "level": 1, "text": "Plan", "line": 4 } ],
  "blockIds": [],
  "links": [
    { "raw": "[[Welcome]]", "target": "Welcome", "subpath": null, "display": null, "embed": false,
      "style": "wiki", "line": 6, "from": 52, "to": 63, "inFrontmatter": false, "resolved": "Welcome.md" }
  ]
}
```

| Field | Meaning |
|---|---|
| `frontmatter` | The YAML 1.2 core-schema data as JSON. Dates stay strings. `null` when there is none or it is invalid; `frontmatterError` then holds the parser message. |
| `tags` | Distinct tags (inline and frontmatter) in the casing first seen, in order of first appearance, without `#` |
| `links[].target` | Decoded and trimmed, with `#subpath` and `\|display` removed. `""` for same-note links. |
| `links[].resolved` | Per §15.1, or `null` |

| Errors |
|---|
| `400`, `403`, `404` |
| `409 type-mismatch` (`expected: "note"`) for non-`.md` files, canvases included |

### 11.2 `GET /api/notes/backlinks?path={path}[&unlinked=false]`

`200 BacklinksResponse`. `path` may be any file; images have backlinks through embeds.

```json
{
  "path": "Projects/Plan.md",
  "linked": [
    { "source": "Welcome.md", "sourceVersion": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
      "mentions": [
        { "line": 12, "from": 410, "to": 418, "matched": "[[Plan]]",
          "context": "Start with [[Plan]] and then review.", "contextRange": { "from": 11, "to": 19 } }
      ] }
  ],
  "unlinked": null
}
```

| Item | Meaning |
|---|---|
| `linked` | Notes with a link or embed (including frontmatter `"[[...]]"`) resolving to `path`, and indexed documents (§1.8) linking to it, sorted by source mtime, newest first. `matched` is the raw link text; for a canvas's file node it is the embed that stands for it in the indexed text (`![Plan.md](/Projects/Plan.md)`), which is also the `context`. |
| `unlinked` | `null` unless `unlinked=true`. Then it lists plain-text, whole-word, case-insensitive occurrences of the note's basename or aliases (3 or more characters) outside code, links, frontmatter and URLs, in notes (never documents, §1.8) not matching `excludedPaths`. `matched` is the text found. At most 200 groups. It is `[]` for non-notes. |
| `context` | The source line, clipped to at most 240 characters around the match. A leading or trailing `…` marks clipping. `contextRange` is relative to `context`. |
| `from`, `to` | Absolute offsets in the source file at `sourceVersion` (used by §15.5) |
| Sources that are not notes | An indexed document (§1.8) is a source like a note. A `.tasks` list links to a note through `[[Note]]` in a task title or notes, or through a task's `links` (§20.9); an `.excalidraw` drawing through `[[Note]]` in a text element, an element's link, and the images it stores as attachments (DESIGN §6.8.1); a `.canvas` through a link in a card, group name or edge label, and a file node, which is an embed of its file (DESIGN §6.8.2). Such a group's `source` is the document, `context` is the task's or the element's text or link, or the card's text (for example `Call [[Plumber]] about the leak`), and `line`, `from` and `to` refer to that indexed text, not to the file's JSON. An `.excalidraw.md` drawing is a note: links in its Markdown sections are ordinary mentions; a link only its JSON holds is a mention whose `line`, `from` and `to` lie past the end of the file. Unlinked mentions never come from a document, nor from a drawing's JSON. |

| Errors |
|---|
| `400`, `403`, `404` |

### 11.3 `POST /api/links/resolve`

This resolves link targets as written in a note, using the same algorithm the server uses for backlinks and rewrites. It is read-only. The v1 client resolves links itself over the tree with the same algorithm (§15.1, DESIGN §6.6), so it calls this endpoint only in development builds, as a parity check; it remains part of the contract for tools and future features.

Request `ResolveRequest`:

```json
{ "source": "Daily/2026-10-16.md", "targets": ["Plan", "Projects/New idea", "pic.png", "", "missing.pdf"] }
```

**Each `targets` item is the target part only.**

- Strip `#subpath` and `|display`.
- Replace `\|` with `|` before splitting.
- Send markdown-link destinations percent-decoded (keeping `+`).
- Send `""` for same-note links.
- Duplicates are allowed.

`200 ResolveResponse`. Keys are the targets exactly as sent.

```json
{
  "resolved": {
    "Plan": { "path": "Plan.md", "createPath": null },
    "Projects/New idea": { "path": null, "createPath": "Projects/New idea.md" },
    "pic.png": { "path": "Attachments/pic.png", "createPath": null },
    "": { "path": "Daily/2026-10-16.md", "createPath": null },
    "missing.pdf": { "path": null, "createPath": null }
  }
}
```

- `createPath` is non-null only when the target is unresolved, ends in `.md` or has no known-kind extension, and would make a valid new name (§15.1). A **known-kind extension** is a final `.xxx` that DESIGN §4.2 maps to a kind other than `other` (including the server's configured text extensions): `missing.pdf` and `Budget.csv` create nothing, while `v1.3`, `v1.2 notes` and `Report.final` create `<target>.md`.
- The client creates the note with `POST /api/files {path: createPath, content: "", onConflict: "fail"}` and treats `409 already-exists` as success.

| Errors |
|---|
| `400` (0 or more than 500 targets, invalid `source`), `403` |

`source` need not exist; it is used only for its folder.

### 11.4 `GET /api/graph[?since={version}]`

`200 GraphResponse`: the link graph behind the graph view (ROADMAP item 16, DESIGN §5.5.12, §6.28), in one compact response.

```json
{
  "version": "mgbx3k2a-418-0",
  "unchanged": false,
  "nodes": [
    { "path": "Attachments/pic.png", "type": "attachment", "tags": [] },
    { "path": "Plan.md", "type": "note", "tags": ["project", "project/alpha"] },
    { "path": "Welcome.md", "type": "note", "tags": [] },
    { "path": "Someday", "type": "unresolved", "tags": [] }
  ],
  "edges": [1, 0, 1, 1, 2, 2, 2, 1, 1, 2, 3, 1]
}
```

| Field | Meaning |
|---|---|
| `nodes` | Every visible file in path order, `type` `note` for notes and `attachment` for every other kind, then one `unresolved` node per unresolved link target. Unresolved targets are grouped case-insensitively without a final `.md`; `path` is the target as first written (`[[Someday]]`, `[[someday.md]]` → `Someday`). |
| `tags` | A note's distinct tags (inline and frontmatter) in display casing, without `#`, sorted case-insensitively. `[]` for other nodes. |
| `edges` | Flat triples `[source, target, count]` of indexes into `nodes`, one per (source, target) pair, sorted. `count` is the number of links and embeds from source to target. Same-note links are left out. In the example: Plan → pic.png once, Plan → Welcome twice, Welcome → Plan once, Welcome → Someday once. |
| `version` | Opaque. It changes when a node, an edge or a note's tags change, or when `excludedPaths` changes, and not on edits that keep a note's links and tags. |
| `unchanged` | `true` when `since` equals `version`: `nodes` and `edges` are then empty and the client keeps the graph it has. Always `false` without `since`. |

- Files matching `settings.files.excludedPaths` are left out, with their edges, as in Obsidian's graph.
- Tag nodes, orphans, folders and the local graph are computed by the client from this response (DESIGN §6.28).
- The client refreshes it with `since` after tree changes; it is never pushed over SSE.

| Errors |
|---|
| `403` |

### 11.5 `GET /api/compat`

`200 CompatReport`: the Obsidian compatibility report (ROADMAP item 24, DESIGN §5.23, §6.29). Computed on request; it never writes anything, `.obsidian/` included.

```json
{
  "generatedAt": "2026-10-21T16:55:30.120Z",
  "tookMs": 18,
  "obsidian": { "found": true, "configFiles": ["app.json", "daily-notes.json", "graph.json"], "problems": [] },
  "settings": [
    { "source": "daily-notes.json › folder", "obsidianValue": "\"Journal\"", "setting": "dailyNotes.folder",
      "current": "Daily", "proposed": "Journal", "status": "different", "note": null },
    { "source": "app.json › userIgnoreFilters", "obsidianValue": "[\"Archive/\",\"/^Private.*$/\"]",
      "setting": "files.excludedPaths", "current": "", "proposed": "Archive", "status": "different",
      "note": "Not used: /^Private.*$/ (NotesApp excludes folders and files by path, not by regular expression)" }
  ],
  "proposedSettings": { "schemaVersion": 1, "files": { "…": "…" }, "dailyNotes": { "folder": "Journal", "…": "…" }, "templates": { "…": "…" }, "editor": { "…": "…" } },
  "settingsVersion": "a1f3c5e7b9d0a2c4e6f8b0d2f4a6c8e0b2d4f6a8",
  "graph": { "colorGroups": [ { "query": "tag:#project", "color": { "a": 1, "rgb": 14701138 } } ], "showArrow": true },
  "plugins": [
    { "id": "dataview", "name": "Dataview", "kind": "community", "status": "planned",
      "note": "Queries show as code blocks; scripts and query blocks are planned.", "roadmapItem": 40 }
  ],
  "issues": [
    { "id": "missing-headings", "category": "links", "severity": "warning",
      "title": "Links to headings that do not exist",
      "detail": "The note exists, but not the heading: the link opens the note at the top.",
      "roadmapItem": null, "count": 1, "noteCount": 1,
      "occurrences": [ { "path": "Home.md", "line": 6, "text": "[[Plan#Missing heading]]" } ], "truncated": false }
  ],
  "totals": { "notes": 412, "files": 530, "errors": 0, "warnings": 9, "infos": 31 }
}
```

| Field | Meaning |
|---|---|
| `obsidian` | Whether the vault has a `.obsidian/` folder, the configuration files read from it, and the ones that could not be read (`"app.json is not valid JSON"`). |
| `settings` | One row per Obsidian setting NotesApp maps (DESIGN §5.23 table), in file order. `obsidianValue` is the value as JSON text; `current` and `proposed` are display strings. `status`: `same` (in effect), `different` (applying changes it), `unsupported` (`proposed` is null, `note` says why). Empty without `.obsidian/`. |
| `proposedSettings`, `settingsVersion` | The current settings with every `different` row applied, and the settings version they are based on. Clients apply them with `PUT /api/settings {settings: proposedSettings, baseVersion: settingsVersion}`; a `409` means the settings changed since, so the report is fetched again. `proposedSettings` is null without `.obsidian/`. |
| `graph` | The options of `.obsidian/graph.json` the graph view understands (`search`, `showTags`, `showAttachments`, `hideUnresolved`, `showOrphans`, `colorGroups`, `showArrow`, `textFadeMultiplier`, `nodeSizeMultiplier`, `lineSizeMultiplier`, `centerStrength`, `repelStrength`, `linkStrength`, `linkDistance`) as Obsidian wrote them; null when there are none. Group colors stay `{a, rgb}` objects. |
| `plugins` | The enabled core plugins (`core-plugins.json`), then the enabled community plugins (`community-plugins.json`, named from their `manifest.json`), each group ordered by `status` (`unsupported`, `unknown`, `planned`, `partial`, `supported`) and name. |
| `issues` | One entry per finding with at least one occurrence, in a fixed order (syntax, links, files). `id` is stable (`dataview`, `tasks-query`, `search-query`, `plugin-blocks`, `templater`, `block-references`, `obsidian-uris`, `html-removed`, `kanban`, `missing-files`, `missing-headings`, `missing-blocks`, `missing-notes`, `skipped`, `too-large`, `not-utf8`, `frontmatter`, `excalidraw`, `canvas`, `bases`). `count` counts every occurrence, `noteCount` the files they are in; `occurrences` lists at most 200 in path order, with a 0-based `line` (null for whole files) and the text found (at most 160 characters), and `truncated` says there are more. |
| `totals` | Notes and files in the vault, and occurrences by severity. |

| Errors |
|---|
| `403` |

---

## 12. Search and tags

### 12.1 `GET /api/search?q={query}[&limit=50][&sort=relevance][&prefix=true][&fuzzy=true]`

This is full-text search over notes, over the indexed documents of §1.8 (the tasks of `.tasks` lists, §20.9; the texts of `.excalidraw` drawings; the cells of `.sheet` spreadsheets, §12.3; the cards, group names, web addresses, edge labels and file nodes of `.canvas` boards) and over the text of PDF attachments (§12.5). A hit's `path` is then the document, and `matches` are lines of its indexed text, never of its JSON. Files whose path matches `settings.files.excludedPaths` (case-insensitive prefix) are never returned.

| Parameter | Meaning |
|---|---|
| `sort` | `relevance` (the default) or `mtime` (newest first) |
| `prefix` | With `true`, the last bare word of the query matches as a prefix when it is 2 or more characters long (search-as-you-type) |
| `fuzzy` | With `true` (the default), a word or phrase term that is not in the index also matches indexed words one edit away (4–7 characters) or two edits away (8 or more): insertions, deletions, substitutions and swaps of adjacent characters. Terms shorter than 4 characters, terms with digits, and negated terms are never corrected. The response lists what was used in `corrections`. |

`200 SearchResponse`:

```json
{
  "query": "\"weekly review\" tag:#work -draft",
  "total": 3,
  "tookMs": 4,
  "results": [
    { "path": "Work/Weekly review.md", "basename": "Weekly review", "kind": "note", "score": 12.84,
      "mtime": "2026-10-14T18:20:11.000Z",
      "titleRanges": [ { "from": 0, "to": 13 } ],
      "matches": [
        { "line": 7, "text": "…so the weekly review covers open loops and next actions", "ranges": [ { "from": 7, "to": 20 } ],
          "page": null }
      ],
      "moreMatches": 2 }
  ],
  "corrections": []
}
```

| Field | Meaning |
|---|---|
| `total` | All matching files; `results` holds at most `limit` of them |
| `kind` | `note`, or `pdf` for a PDF's extracted text (§12.5) |
| `matches` | Up to 3 matching body lines, each clipped to 200 characters (with `…` marking a clip). `ranges` are relative to `text` and cover word, phrase and regular-expression matches. `line` is the 0-based line number; the client opens a note hit with `/n/<path>?line=<line>&q=<query>` (DESIGN §6.4). For a PDF, `line` counts lines of the extracted text, and `page` is the 1-based page (the client opens `/n/<path>?page=<page>`); `page` is `null` for notes. |
| `titleRanges` | Ranges in `basename` |
| `score` | Higher is better; 0 for queries made only of filters and regular expressions |
| `corrections` | `[{term, replacements}]`: each query term (normalized) that typo tolerance replaced, and the indexed words that were searched in its place (at most 8, closest first). Empty when `fuzzy=false` or nothing was corrected. |

- An empty query, or one made only of negated clauses, returns `200` with `total: 0`.
- Errors: `400 bad-request` when `limit` is out of range or `sort` is unknown; and with `errors: [{field: "q", message}]` when the query is longer than 2,000 characters or has more than 64 clauses, a regular expression is invalid or longer than 500 characters, or the regular expressions and `line:`/`section:` clauses run out of their time budget (`notes.search.timeout`, 2 s, which stops catastrophic backtracking). `503 busy` when more than `notes.search.max-concurrent-expensive` (2) such queries run at once and none finishes within that budget.

**Query grammar.** This is normative.

```
query   = ws* [ or ] ws*
or      = and { ws+ "OR" ws+ and }                                ; OR (upper case only) binds looser than AND
and     = unary { ws* unary }                                     ; juxtaposition is AND
unary   = [ "-" ] primary                                         ; "-" followed by whitespace is a word
primary = group | scoped | clause
group   = "(" ws* [ or ] ws* ( ")" | end-of-query )
scoped  = ( "line:" | "section:" ) ( group | clause )
clause  = [ "tag:" | "path:" | "file:" ] ( regex | phrase | word ) ; keywords are case-insensitive
regex   = "/" 1*( "\" char | char - "/" ) "/"                     ; only before ws, ")" or the end; else a word
phrase  = '"' { char - '"' } ( '"' | end-of-query )              ; an unterminated phrase runs to the end
word    = 1*( char - ws - '"' )                                   ; inside a group, ")" also ends a word
```

Parsing never fails: a keyword with nothing after it is an ordinary word, an empty phrase or group is ignored, an unclosed group runs to the end of the query, a stray `)` is ignored, and a leading, trailing or doubled `OR` is dropped. A slash that does not close a regular expression before whitespace, `)` or the end keeps the clause a word, so `/usr/bin` is the phrase "usr bin"; write `\/` for a slash inside a regular expression.

| Clause | Matches |
|---|---|
| `word` | Notes containing the word in the title, aliases, headings, tags or body. Matching is case-, accent- and width-insensitive. A word that tokenizes into several tokens (`e-mail`) acts as a phrase. |
| `"a phrase"` | Consecutive tokens |
| `/regex/` | A Java regular expression found anywhere in the file's text (a note's whole content, frontmatter included; a PDF's extracted text). Case-insensitive (Unicode) unless it starts with `(?-i)`; `^` and `$` match at line breaks. At most 500 characters. |
| `tag:x` / `tag:#x` | Notes tagged `x` or any nested `x/…`. `tag:/regex/`: a tag (without `#`) matching it. |
| `path:x` | Case-insensitive substring of the full vault path. `path:/regex/`: a path matching it. |
| `file:x` | Case-insensitive substring of the file name. `file:/regex/`: a name matching it. |
| `a OR b` | Either side |
| `( … )` | Groups clauses |
| `line:(…)` | Every clause inside matches within one line of the body (frontmatter lines excluded). Filters inside keep their file-level meaning. |
| `section:(…)` | Every clause inside matches within one section: the text from one heading to the next (the part before the first heading is a section too). A PDF's sections are its pages. |
| `-clause` | Excludes matches. A group (or the whole query) made only of negated clauses matches nothing: negations only remove what the other clauses of the same group match. |

Clauses next to each other must all match (AND).

### 12.2 `GET /api/tags`

`200 TagsResponse`. Every tag plus every implied parent, sorted case-insensitively by `tag`.

```json
{ "tags": [
  { "tag": "project", "count": 3, "total": 5 },
  { "tag": "project/alpha", "count": 2, "total": 2 },
  { "tag": "work", "count": 9, "total": 9 }
] }
```

- `count` is the number of notes with exactly this tag. Indexed documents (§1.8) count as notes here: a `.tasks` list, an `.excalidraw` drawing or a `.canvas` whose indexed text holds the tag, and an `.excalidraw.md` drawing through its Markdown or the texts only its JSON holds (DESIGN §6.8.1).
- `total` is the number of distinct notes (documents included) with this tag or any descendant.
- A parent that only exists through nesting has `count: 0`.
- Display casing is the first one seen.

### 12.3 Spreadsheets in search, backlinks and tags

`.sheet` files (DESIGN §6.21) are indexed documents (§1.8), indexed through the `DocumentIndexer` extension point (DESIGN §6.8): what each cell shows (its text or number, or the cached result of its formula, as stored in the file), the sheet names and the chart titles become searchable text, one line per cell, and the links and tags in it count like a note's. Formulas, error results, number formats and the JSON around the values are not indexed.

- A `[[Note]]` (or Markdown link) in a cell's text or cached result makes the spreadsheet a backlink source of that note (§11.2); the mention's `context` is the cell's text. `#tags` in cells count in `GET /api/tags` and `tag:` search.
- `GET /api/search` can return a spreadsheet; its `matches` are lines of cell text, and their `line` numbers count lines of that text, not of the file.
- A spreadsheet is not a note: `GET /api/notes/meta` answers `409 type-mismatch`, it never appears in unlinked mentions, and it does not count in `/api/status` `vault.notes`.
- Renaming or moving a note, or renaming a heading (§22), does not rewrite links in spreadsheets; such a file is reported in `failed` with `not-rewritable`, and the cell can be edited by hand.
- A file that is not a readable spreadsheet (not JSON, another `type`, a newer format `version`) is listed and served, but not content-indexed.

Nothing else in the API changes for spreadsheets: they are text files read and saved through §8 with the version and conflict protocol of §4.

### 12.4 Saved searches: `GET /api/searches` and `PUT /api/searches`

Named queries, stored in the vault as `.notesapp/searches.json`, so they sync to every device and are committed with the vault's history (DESIGN §4.1).

`GET /api/searches` returns `200 SavedSearchesResponse`:

```json
{ "searches": [ { "id": "s-6f1c2a9e", "name": "Open loops", "query": "tag:#todo -done", "sort": "relevance" } ],
  "version": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad" }
```

`version` is the blob id of the file (§1.6), or `null` while it does not exist (no search was ever saved). A file that cannot be read as saved searches lists none; entries that are invalid are skipped (both are logged).

`PUT /api/searches` replaces the whole list. Request `SavedSearchesUpdateRequest`:

```json
{ "searches": [ { "id": "s-6f1c2a9e", "name": "Open loops", "query": "tag:#todo -done", "sort": "relevance" } ],
  "baseVersion": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad" }
```

| Field | Rule |
|---|---|
| `searches` | At most 100, in display order |
| `id` | 1 to 64 characters from `[A-Za-z0-9-]`, unique; chosen by the client |
| `name` | 1 to 120 characters, trimmed |
| `query` | 1 to 2,000 characters (§12.1); stored as given |
| `sort` | `relevance` or `mtime`; missing means `relevance` |
| `baseVersion` | The `version` the client last read, or `null` (or `""`) when the file does not exist yet |

`200 SavedSearchesResponse` with the new `version`. Saving a list equal to the stored one succeeds whatever `baseVersion` says.

| Errors |
|---|
| `400 bad-request` with `errors[]` naming each invalid field, for example `searches[2].name` |
| `409 version-conflict` (`path: ".notesapp/searches.json"`, `currentVersion`, `currentContent`): another device saved meanwhile. The client fetches the list again and re-applies its change (add, rename, delete). |

Event: `searches.changed` (§16.4). The file is added to the pending history batch like a save.

### 12.5 PDF text in search

The text of every PDF in the vault is extracted with Apache PDFBox in the background and searched like a note's body (DESIGN §5.5.10). A PDF hit has `kind: "pdf"`, its `basename` is the file name without `.pdf`, and each match carries the `page` it is on.

- Extraction never runs on a request: a new or changed PDF becomes searchable a moment after it is written (seconds for a large one). Until then it is not found by its text, and it is not found by `file:` or `path:` either.
- Limits (`notes.search.pdf.*`): files over 64 MB, pages after the 2,000th, text after 1,000,000 characters, and work after 60 s per file are skipped. A PDF that cannot be read (encrypted with a password, damaged, over a limit) is still found by its name.
- PDF text has no tags, links or headings: `tag:` never matches it, it is never a backlink source, and it does not count as a note in `/api/status`. Its sections (`section:`) are its pages.
- Task lists, drawings and spreadsheets are searchable through their own document indexers (§1.8), not as PDFs.

---

## 13. Trash

The trash lives in `<vault>/.trash/` and is **flat**: each trashed file or folder is one top-level entry named after the entry itself (with ` 1`, ` 2`, ... on collisions), and its original path is kept only in the server's metadata. Trash is never committed to git, but the content of every file trashed through the app was committed before it was deleted.

### 13.1 `GET /api/trash`

`200 TrashListResponse`, newest first:

```json
{ "entries": [
  { "id": "01JA7Q3M9K2Z", "originalPath": "Projects/Old plan.md", "type": "file",
    "deletedAt": "2026-10-16T14:12:40.120Z", "deletedBy": "rjgehan@github", "size": 2311, "fileCount": 1 },
  { "id": "x-4b1d9e0c7a2f5e83", "originalPath": "Scratch.md", "type": "file",
    "deletedAt": "2026-10-01T09:00:00.000Z", "deletedBy": "unknown", "size": 120, "fileCount": 1 }
] }
```

**Ids** are either 12 Crockford-base32 characters (`[0-9A-HJKMNP-TV-Z]{12}`), or `x-` followed by 16 hex characters for top-level items found in `.trash/` without app metadata (put there by Obsidian or by hand). For those items, `originalPath` is the item's name, `deletedBy` is `"unknown"` and `deletedAt` is the item's mtime. They were never seen by NotesApp and may not be in history, so clients warn before purging them.

Each top-level item in `.trash/` is listed exactly once.

### 13.2 `GET /api/trash/{id}/raw`

Returns the raw bytes of a trashed **file**, with the same headers and statuses as §9.1 (without `v`). It is used to preview a trashed note. Symlinks are never served (`404`).

| Errors |
|---|
| `404` |
| `409 type-mismatch` (folder entries) |

### 13.3 `POST /api/trash/{id}/restore`

Request `RestoreRequest`. The body may be empty, or `{}`, or:

```json
{ "to": "Projects/Old plan (restored).md", "onConflict": "fail" }
```

| Field | Default |
|---|---|
| `to` | The original path. Restoring to the original path never applies the new-name rules (the name existed); an explicit `to` is a **new** name (§1.3). Implicit parents resolve case-insensitively. |
| `onConflict` | `"fail"`. `"rename"` inserts ` 1`, ` 2`, ... |

`200 RestoreResult`:

```json
{ "type": "file", "path": "Projects/Old plan.md",
  "files": [ { "path": "Projects/Old plan.md", "name": "Old plan.md", "basename": "Old plan", "extension": "md",
               "kind": "note", "size": 2311, "mtime": "2026-10-16T14:12:39.000Z",
               "version": "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", "aliases": [] } ],
  "createdFolders": [],
  "commitId": "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3" }
```

`files` lists every restored file; for a folder that means all of them.

| Errors |
|---|
| `400 invalid-path` / `invalid-name` (`to`), `403` |
| `404` |
| `409 already-exists` / `case-collision` / `type-mismatch` |

Events:

1. `folder.created` for each re-created folder, including the restored folder and its subfolders.
2. `file.created` for each restored file. If more than 50 files are restored, a single `resync {reason: "bulk-change"}` replaces the per-file events.
3. `trash.changed`, then `history.committed`.

### 13.4 `DELETE /api/trash/{id}`

Permanently deletes one entry from `.trash/`. Symlinks inside it are removed, never followed. Returns `204 No Content`. Errors: `404`. Event: `trash.changed`.

### 13.5 `DELETE /api/trash`

Empties the trash, with the same symlink rule. Returns `200 PurgeResult`, for example `{"purged": 4}`. Event: `trash.changed`.

---

## 14. History

All history endpoints return `503 history-unavailable` when git is disabled, the repo is unusable, or the startup import is still running (`reason: "importing"`). Commit ids in requests must be **full 40-hex** ids; anything else returns `400 bad-request`. Paths are NFC, also for files whose names are NFD on disk.

### 14.1 `GET /api/history?path={path}[&limit=50][&offset=0]`

This is the history of one path, following renames (the equivalent of `git log --follow`). `path` does not need to exist now, so deleted files have history too.

`200 HistoryResponse`, newest first:

```json
{
  "path": "Projects/Roadmap.md",
  "pending": true,
  "hasMore": false,
  "entries": [
    { "commitId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2", "shortId": "c3d4e5f",
      "parentCommitId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "path": "Projects/Roadmap.md", "time": "2026-10-16T14:20:02.000Z",
      "authorName": "R. J. Gehan", "authorLogin": "rjgehan@github",
      "message": "Rename Projects/Plan.md → Projects/Roadmap.md",
      "change": "renamed", "renamedFrom": "Projects/Plan.md" },
    { "commitId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "shortId": "a1b2c3d",
      "parentCommitId": "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d",
      "path": "Projects/Plan.md", "time": "2026-10-16T14:05:31.000Z",
      "authorName": "R. J. Gehan", "authorLogin": "rjgehan@github",
      "message": "Update Projects/Plan.md", "change": "modified", "renamedFrom": null }
  ],
  "excluded": null
}
```

| Field | Meaning |
|---|---|
| `entries[].path` | The file's path **as of that commit**. Pass it as `path` to §14.2 and as `sourcePath` to §14.4. |
| `parentCommitId` | The commit's first parent, or `null` for a root commit. A `deleted` entry has no content at its own commit: read the last version with `commit=<parentCommitId>`. |
| `change` | `added`, `modified`, `renamed` or `deleted` |
| `pending` | `true` when the path has uncommitted changes in the batch; always `false` for an excluded file |
| `message` | The commit subject only |
| `excluded` | `HistoryExclusion` when new versions of the file are not kept in history, else `null`. The only reason is `large-file`: the file (`size` bytes) is larger than the large-file threshold (`limitBytes`, §6.2). Its earlier versions, from before it grew past the threshold, are still listed; the commit that stopped tracking it is a `deleted` entry with the subject `Stop versioning <path> (larger than 25 MB)`. |

A path with no history returns `entries: []`.

```json
{ "path": "Attachments/Holiday.mp4", "pending": false, "hasMore": false, "entries": [],
  "excluded": { "reason": "large-file", "size": 83886080, "limitBytes": 26214400 } }
```

### 14.2 `GET /api/history/content?path={pathAtCommit}&commit={commitId}`

`200 HistoryContent`:

```json
{ "commitId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "path": "Projects/Plan.md",
  "version": "9f0c2c7d1e9a4f0b6e5d3c2b1a0f9e8d7c6b5a49", "size": 98,
  "binary": false, "content": "# Plan\n\nOld text.\n", "lossy": false }
```

For non-text kinds, `binary` is `true` and `content` is `null`; use §14.3 instead.

| Errors |
|---|
| `400`, `404` (unknown commit, or the path is absent at that commit) |
| `413 too-large` |
| `503` |

### 14.3 `GET /api/history/raw?path={pathAtCommit}&commit={commitId}`

Returns the bytes at that commit, with the §9.1 headers except `Cache-Control: private, max-age=31536000, immutable` (the content is addressed by commit). Errors are as in §14.2.

### 14.4 `POST /api/history/restore`

Request `HistoryRestoreRequest`:

```json
{ "path": "Projects/Roadmap.md", "commit": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  "sourcePath": "Projects/Plan.md", "baseVersion": "0b9e8d7c6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c" }
```

| Field | Meaning |
|---|---|
| `path` | Where to write: the file's current path (or its last path, if it no longer exists). The new-name rules are not applied. |
| `sourcePath` | The path at `commit`; defaults to `path` |
| `baseVersion` | **Text kinds:** the client's current version of `path`, or `null` when the file does not exist now (it is then recreated). A mismatch is `409 version-conflict`; `null` while the file exists is `409 already-exists`. **Non-text kinds:** must be `null`; an existing file is overwritten, and `already-exists` never applies. |

**What the server does.** Before writing anything, it commits the current content of `path` and any pending history (so the edits made just before the restore are kept in history, not overwritten unseen). If that commit fails, the response is `503 history-unavailable` (`reason: "commit-failed"`) and nothing is written. A current file over the large-file threshold (§6.2) is not in history, so a copy of it goes to the trash instead. It then writes the historical bytes **verbatim** (BOM, line endings and invalid UTF-8 included; they are never decoded and re-encoded) and commits the restore.

`200 HistoryRestoreResult`:

```json
{ "file": { "path": "Projects/Roadmap.md", "name": "Roadmap.md", "basename": "Roadmap", "extension": "md",
            "kind": "note", "size": 18, "mtime": "2026-10-16T14:25:00.010Z",
            "version": "9f0c2c7d1e9a4f0b6e5d3c2b1a0f9e8d7c6b5a49", "aliases": [] },
  "created": false, "createdFolders": [],
  "commitId": "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4" }
```

The server commits immediately: `Restore <path> to version <shortId>`. `commitId` is that commit, or the current `HEAD` when the restored bytes equal the current content (nothing new is committed). It is `null` only when the restore's own commit failed after the bytes were written; the path then stays pending and the server keeps retrying, as for a move.

| Errors |
|---|
| `400`, `403`, `404` |
| `409 version-conflict` (text kinds) / `already-exists` (text kinds, `baseVersion: null` but the file exists) |
| `503 history-unavailable` |

Events: `file.changed` or `file.created` (with `folder.created` first for any re-created parents), then `trash.changed` when a large file was kept in the trash, then `history.committed`.

### 14.5 `POST /api/history/commit`

No body. This commits the pending batch now.

`200 CommitResult`: `{"commitId": "f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5"}`, or `{"commitId": null}` when nothing was pending. Errors: `503 history-unavailable` (including `reason: "commit-failed"` when the commit itself fails; the paths stay pending and the server keeps retrying).

### 14.6 `GET /api/history/log[?path=][&author=][&since=][&until=][&limit=50][&offset=0]`

The vault-wide timeline (ROADMAP item 28): every commit, newest first (by commit time), with the files it changed.

| Parameter | Meaning |
|---|---|
| `path` | Only commits that change this file, or anything under this folder (case-sensitive vault path); `files` then lists only those |
| `author` | Case-insensitive substring of the author's name or login |
| `since`, `until` | ISO-8601 instants; `since` is inclusive, `until` exclusive. Anything else is `400 bad-request`. |
| `limit`, `offset` | Paging, as in §14.1 (`limit` 1 to 200) |

`200 TimelineResponse`:

```json
{ "hasMore": false,
  "entries": [
    { "commitId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2", "shortId": "c3d4e5f",
      "parentCommitId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "time": "2026-10-16T14:20:02.000Z", "authorName": "R. J. Gehan", "authorLogin": "rjgehan@github",
      "message": "Rename Projects/Plan.md → Projects/Roadmap.md",
      "files": [ { "path": "Projects/Roadmap.md", "change": "renamed", "renamedFrom": "Projects/Plan.md" } ],
      "filesTotal": 1 } ] }
```

- `files` is the diff against the first parent (a root commit: against nothing), with renames detected as in §14.1, sorted by path, at most 100 of `filesTotal`. Hidden paths (`.notesapp/settings.json`, `.notesapp/searches.json`) are left out, so a commit that only saved settings has no files.
- To show a file at a commit, use §14.2 with `commit=<commitId>` (or `parentCommitId` for a `deleted` file) and the entry's `path`.

### 14.7 `GET /api/history/changes[?since=][&until=][&path=]`

What changed over a period ("what changed this week"): the net difference between the last commit before `since` (or nothing, when `since` is absent or older than history) and the last commit before `until` (or `HEAD`).

`200 ChangesResponse`:

```json
{ "since": "2026-10-12T00:00:00.000Z", "until": null,
  "fromCommitId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "toCommitId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
  "commits": 14, "authors": ["R. J. Gehan"],
  "files": [ { "path": "Ideas/Plan B.md", "change": "added", "renamedFrom": null },
             { "path": "Projects/Roadmap.md", "change": "renamed", "renamedFrom": "Projects/Plan.md" } ],
  "truncated": false }
```

- `files` compares the two trees, so a file created and deleted within the period is not listed, and one edited ten times is listed once. Renames are detected; hidden paths are left out; at most 1,000 files (`truncated`).
- `commits` and `authors` count the commits in the period. When there are none, `toCommitId` equals `fromCommitId` (or both are `null`) and `files` is empty.
- To diff one file over the period, read it at `fromCommitId` (path `renamedFrom ?? path`; absent for `added`) and at `toCommitId` (absent for `deleted`) with §14.2.
- `400 bad-request` when `since` is not before `until` or an instant is invalid.

### 14.8 `GET /api/history/deleted[?q=][&limit=50][&offset=0]`

Files that were deleted at some point and do not exist now, so they can be brought back from git even after the trash was emptied. Each path is listed once, with its latest deletion; newest first. A path whose latest change is not a deletion (it was re-created, or renamed away) is not listed, nor is a path that exists now.

| Parameter | Meaning |
|---|---|
| `q` | Case-insensitive substring of the path |
| `limit`, `offset` | Paging (`limit` 1 to 200) |

`200 DeletedFilesResponse`:

```json
{ "total": 1, "hasMore": false,
  "entries": [ { "path": "Projects/Old plan.md", "deletedAt": "2026-09-02T08:12:40.000Z",
                 "commitId": "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3", "shortId": "d4e5f6a",
                 "parentCommitId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
                 "authorName": "R. J. Gehan", "authorLogin": "rjgehan@github", "message": "Delete Projects/Old plan.md" } ] }
```

**Restore** with §14.4: `{"path": <path>, "commit": <parentCommitId>, "sourcePath": <path>, "baseVersion": null}`. The file and its folders are re-created, and the restore is committed; the path then leaves this list.

The list is computed from the whole history on first use and then updated from the commits made since, so the first request on a long history can take a few seconds.

---

## 15. Templates, daily notes and shared algorithms

The algorithms in this section run on **both** the server and the client. The vectors are normative test cases: the backend copies them into `LinkResolverTest`, `LinkTextGeneratorTest` and `MarkdownScannerTest`, and the frontend copies them into `features/links.test.ts` (§15.1, §15.3, run against the client's own `resolve()` and `createPath()`) and `features/syntax.test.ts` (§15.6).

**Fixture vault** used by §15.1 and §15.3. All settings are defaults unless stated.

```
Welcome.md
Plan.md
log.md
v1.2 notes.md
Projects/Plan.md
Projects/Alpha/Spec.md
Projects/Alpha/notes.md
Archive/Spec.md
Archive/2025/Old.md
Attachments/pic.png
Daily/2026-10-16.md
Ideas/Plan B.md
```

### 15.1 Link resolution

The algorithm is in DESIGN §5.5.6. Its outline:

1. A blank target is the same note.
2. A leading `/` forces an absolute lookup; `./` or `../` forces a relative one.
3. Candidates are `[t + ".md", t]`, or `[t]` when `t` already ends with `.md`.
4. Try the vault root, then the source note's folder, then a case-insensitive suffix match anywhere. Ties prefer the same folder as the source, then the fewest segments, then the lowest path.

| # | source | target | → path | createPath |
|---|---|---|---|---|
| 1 | `Daily/2026-10-16.md` | `Plan` | `Plan.md` (the root wins over `Projects/Plan.md`) | null |
| 2 | `Projects/Alpha/Spec.md` | `Plan` | `Plan.md` | null |
| 3 | `Projects/Alpha/notes.md` | `Spec` | `Projects/Alpha/Spec.md` (relative) | null |
| 4 | `Daily/2026-10-16.md` | `Spec` | `Archive/Spec.md` (suffix; fewest segments) | null |
| 5 | `Archive/2025/Old.md` | `Spec` | `Archive/Spec.md` | null |
| 6 | `Daily/2026-10-16.md` | `Alpha/Spec` | `Projects/Alpha/Spec.md` (suffix `/alpha/spec.md`) | null |
| 7 | `Projects/Alpha/Spec.md` | `../Plan` | `Projects/Plan.md` (forced relative) | null |
| 8 | `Projects/Alpha/Spec.md` | `./notes` | `Projects/Alpha/notes.md` | null |
| 9 | `Projects/Alpha/Spec.md` | `/Plan` | `Plan.md` (forced absolute) | null |
| 10 | `Welcome.md` | `LOG` | `log.md` (case-insensitive) | null |
| 11 | `Welcome.md` | `v1.2 notes` | `v1.2 notes.md` | null |
| 12 | `Welcome.md` | `pic.png` | `Attachments/pic.png` | null |
| 13 | `Welcome.md` | `Plan.md` | `Plan.md` | null |
| 14 | `Welcome.md` | `` (empty) | `Welcome.md` | null |
| 15 | `Welcome.md` | `Plan B` | `Ideas/Plan B.md` | null |
| 16 | `Welcome.md` | `Missing` | null | `Missing.md` |
| 17 | `Daily/2026-10-16.md` | `Projects/New idea` | null | `Projects/New idea.md` |
| 18 | `Projects/Alpha/Spec.md` | `./Draft` | null | `Projects/Alpha/Draft.md` |
| 19 | `Welcome.md` | `missing.pdf` | null | null |
| 20 | `Welcome.md` | `/Spec` | null (forced absolute; no suffix step) | `Spec.md` |
| 21 | `Daily/2026-10-16.md` | `Missing` with `newNoteLocation: "current"` | null | `Daily/Missing.md` |
| 22 | `Daily/2026-10-16.md` | `Missing` with `newNoteLocation: "folder"`, `newNoteFolder: "Inbox"` | null | `Inbox/Missing.md` |
| 23 | `Welcome.md` | `Bad[name` | null | null (invalid new name) |
| 24 | `Welcome.md` | `v1.3` | null | `v1.3.md` (`3` is not a known-kind extension, §11.3) |
| 25 | `Welcome.md` | `Budget.csv` | null | null (a known-kind extension) |

### 15.2 Daily note procedure (client)

`dayjs` is set up with the plugins `advancedFormat`, `customParseFormat`, `weekOfYear`, `isoWeek`, `weekYear` and `localizedFormat` (DESIGN §6.12).

```ts
async function openTodaysDailyNote() {
  const s = settings.dailyNotes;
  const now = dayjs();                                           // browser local time zone
  const name = now.format(s.format);                             // "2026-10-16"; may contain "/" → subfolders
  const path = joinPath(s.folder, name + '.md');                 // joinPath("", x) === x
  const hit = tree.byLowerPath.get(path.toLowerCase());
  if (hit) return navigate(hit.path);
  let content = '';
  if (s.template) {
    try { content = renderTemplate((await readFile(s.template)).content, { title: lastSegment(name), now }); }
    catch (e) { if (isProblem(e, 'not-found')) toast('Daily note template not found'); else throw e; }
  }
  try {
    const r = await createFile({ path, content, onConflict: 'fail' });
    navigate(r.file.path);
  } catch (e) {
    if (isProblem(e, 'already-exists') || isProblem(e, 'case-collision')) navigate(e.problem.existingPath ?? path);
    else if (isProblem(e, 'invalid-path') || isProblem(e, 'invalid-name')) toast('Daily note format produces an invalid file name');
    else throw e;
  }
}
```

**Previous and next.** Take the notes under `s.folder` (any depth) whose path, relative to the folder and without `.md`, parses with `dayjs(rel, s.format, true).isValid()`. Sort them by date and navigate to the nearest one before or after the current note.

| Settings | Today = 2026-10-16 |
|---|---|
| `format: "YYYY-MM-DD"`, `folder: "Daily"` | `Daily/2026-10-16.md` |
| `format: "YYYY/MM-MMMM/YYYY-MM-DD dddd"`, `folder: "Journal"` | `Journal/2026/10-October/2026-10-16 Friday.md` |
| `format: "YYYY-[W]WW"`, `folder: ""` | `2026-W42.md` |

### 15.3 Link text generation (client and server)

The algorithm is in DESIGN §5.5.7. Its outline:

- Wiki style drops `.md`; markdown style keeps it and percent-encodes the path.
- **shortest** uses the bare file name when no other file in the vault shares it (case-insensitive), and the full path otherwise.
- **relative** always starts with `./` or `../`.
- **absolute** is the full vault path.
- A round-trip guard falls back to the absolute form whenever `resolve(text, source)` would not return the target.

**`encodeMdPath(s)`** percent-encodes exactly these characters, as UTF-8 bytes: space, `(`, `)`, `<`, `>`, `[`, `]`, `#`, `^`, `|`, `%`, and C0 controls. Everything else, including non-ASCII, is unchanged.

| # | target P | source S | format | style | → link text |
|---|---|---|---|---|---|
| 1 | `Projects/Alpha/notes.md` | `Welcome.md` | shortest | wiki | `notes` |
| 2 | `Projects/Plan.md` | `Welcome.md` | shortest | wiki | `Projects/Plan` (the name `Plan.md` is not unique) |
| 3 | `Plan.md` | `Daily/2026-10-16.md` | shortest | wiki | `Plan` (the full path of a root file) |
| 4 | `Archive/Spec.md` | `Welcome.md` | shortest | wiki | `Archive/Spec` |
| 5 | `Projects/Alpha/Spec.md` | `Projects/Alpha/notes.md` | relative | wiki | `./Spec` |
| 6 | `Plan.md` | `Projects/Alpha/Spec.md` | relative | wiki | `../../Plan` |
| 7 | `Attachments/pic.png` | `Welcome.md` | shortest | wiki | `pic.png` |
| 8 | `Ideas/Plan B.md` | `Welcome.md` | shortest | markdown | `Plan%20B.md` |
| 9 | `Projects/Plan.md` | `Welcome.md` | absolute | markdown | `Projects/Plan.md` |
| 10 | `v1.2 notes.md` | `Welcome.md` | shortest | wiki | `v1.2 notes` |
| 11 | `Daily/2026-10-16.md` | `Welcome.md` | shortest | wiki | `2026-10-16` |
| 12 | `Ideas/Plan B.md` | `Projects/Plan.md` | relative | markdown | `../Ideas/Plan%20B.md` |

`encodeMdPath` vectors: `Notes (draft)/a b%.md` gives `Notes%20%28draft%29/a%20b%25.md`, and `Café.md` gives `Café.md`.

**Assembling a full link:**

| Kind | Form |
|---|---|
| wiki | `[[<text>]]` or `[[<text>\|<display>]]` |
| wiki embed | `![[<text>]]` |
| markdown | `[<display>](<text>)`, where `display` defaults to the target's basename without `.md` |
| markdown image | `![](<text>)` |

### 15.4 Templates

#### `GET /api/templates`

`200 TemplatesResponse`. Lists the `.md` files under `settings.templates.folder`, recursively, sorted by path. If the folder is missing, `templates` is `[]`.

```json
{ "folder": "Templates",
  "templates": [ { "path": "Templates/Daily note.md", "name": "Daily note" },
                 { "path": "Templates/Meeting.md", "name": "Meeting" } ] }
```

**Applying a template** happens on the client. Fetch it with `GET /api/files`, then render it.

**Placeholder grammar.** This is normative.

```
regex: /\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi
{{title}}        → basename (no .md) of the note being created or edited
{{date}}         → now.format(settings.templates.dateFormat)      (default "YYYY-MM-DD")
{{time}}         → now.format(settings.templates.timeFormat)      (default "HH:mm")
{{date:FMT}}     → now.format(FMT)        {{time:FMT}} → now.format(FMT)
any other {{…}}  → left unchanged
```

Vectors, with now = Fri 2026-10-16 14:03:09 local and title `Plan`:

| Input | Output |
|---|---|
| `# {{title}}` | `# Plan` |
| `{{date}}` | `2026-10-16` |
| `{{ time }}` | `14:03` |
| `{{date:dddd, MMMM Do YYYY}}` | `Friday, October 16th 2026` |
| `{{date:YYYY-[W]WW}}` | `2026-W42` |
| `{{DATE:YYYY}}` | `2026` |
| `{{weather}}` | `{{weather}}` |

**Frontmatter merge** applies when the template has frontmatter and is inserted into a note. It uses the `yaml` Document API so formatting is preserved.

- A template key that is missing from the note is appended.
- When both values are lists, the result is the union: note items first, then template items not already present. For `tags`, `aliases` and `cssclasses` the comparison is case-insensitive.
- Otherwise the note's value wins.
- The template body (without its frontmatter) is inserted at the editor's selection, which is kept after the editor loses focus; in reading mode, at the last edit-mode selection, or at the end if the note was not edited in this page load (DESIGN §6.12).

Example:

```
note:      ---\ntags: [daily]\nmood: ok\n---\nBody
template:  ---\ntags: [journal, Daily]\nmood: great\ncreated: "{{date}}"\n---\n## Log
result:    ---\ntags: [daily, journal]\nmood: ok\ncreated: "2026-10-16"\n---\nBody + "## Log" at cursor
```

### 15.5 Converting an unlinked mention into a link (client)

1. Call `GET /api/files?path=<source>`, or use the open `DocumentSession` if there is one.
2. If `version != mention.sourceVersion`, or `content.slice(from, to) != matched`, refetch the backlinks and stop. When working on an open session whose file uses CRLF, first map `from` and `to` to document offsets (§1.4).
3. `text = linkText(targetPath, source, settings.newLinkFormat, useWikilinks ? 'wiki' : 'markdown')`.
4. Build the replacement:
   - wiki: `[[text]]` if `text === matched`, otherwise `[[text|matched]]`;
   - markdown: `[matched](text)`.
5. Splice it into `[from, to)` and save with `PUT /api/files {content, baseVersion: version}`.

### 15.6 Inline syntax: tags and wikilink bodies (client and server)

The server's `MarkdownScanner`, the editor's Lezer extension and the reading view's markdown-it rules must agree. These rules and vectors are normative for all three.

**Tags.** A `#` that is at the start of the text or preceded by whitespace, followed by one or more characters that are not whitespace and not ASCII punctuation other than `-`, `_` and `/`. Matched outside code, comments, frontmatter and link ranges (a wikilink, or a markdown link including its `[text]`). A tag that is all digits is not a tag; a trailing `/` is dropped. JavaScript (with the `u` flag):

```
/(?<!\S)#([^\s!-,.:-@\[-^`{-~]+)/gu
```

| Input | Tags |
|---|---|
| `#project` | `project` |
| `#Project/Alpha` | `Project/Alpha` |
| `#a/b/` | `a/b` |
| `#1984` | none |
| `#y1984` | `y1984` |
| `a#b` | none |
| `#🚀 launch` | `🚀` |
| `#don’t` (U+2019) | `don’t` |
| `#don't` (ASCII `'`) | `don` |
| `#tag.` | `tag` |
| `# Heading #tag` | `tag` (the heading marker is not a tag) |
| `[see #x](https://e.com)` | none |
| `` `#code` `` | none |

**Wikilink bodies.** Pattern `(!?)\[\[([^\[\]\n]*?)\]\]`. The body splits at the first `|` that is not escaped, where `\|` (the table escape) also counts as the separator; the left part splits at the first `#`; the target is trimmed.

Vectors (a code block, because the inputs contain `|`; each input is literal text, so `\|` is a backslash followed by a pipe):

```
input                   target      subpath    display   note
[[Note]]                "Note"      null       null
[[ Note ]]              "Note"      null       null      target trimmed
[[Note\|Alias]]         "Note"      null       "Alias"   table escape; the backslash is not part of the target
[[Note#H1#H2\|x]]       "Note"      "H1#H2"    "x"
[[#Heading]]            ""          "Heading"  null      same note
[[]]                    ""          null       null      same note
[[Note#^abc]]           "Note"      "^abc"     null
[[a|b|c]]               "a"         null       "b|c"     only the first separator splits
![[pic.png|300]]        "pic.png"   null       "300"     embed
```

---

## 16. Server-Sent Events

### 16.1 Endpoint

```
GET /api/events?clientId={clientId}[&lastEventId={eventId}]
Accept: text/event-stream
```

- `clientId` is **required** and uses the same format as `X-Client-Id`; the page's id is used. A missing or invalid value returns `400 bad-request`.
- `lastEventId` is used only when the `Last-Event-ID` request header is absent. Browsers send that header automatically when an `EventSource` reconnects; clients pass the query parameter when they create a new `EventSource`.
- **Response headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `X-Notes-Build`.
- The server ends the stream after 30 minutes. `EventSource` then reconnects on its own and nothing is lost, because of replay.
- During a deploy or a restart, the request gets serve's `502`. `EventSource` treats a non-200 response as fatal (`readyState` becomes `CLOSED` and it does not retry), so the client recreates it (§16.5 step 7).

### 16.2 Frames

```
retry: 3000
event: hello
id: mgbx3k2a.1042
data: {"bootId":"mgbx3k2a","eventId":"mgbx3k2a.1045","resync":false,"replayed":3,"buildSha":"4e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f","serverTime":"2026-10-16T14:05:00.002Z"}

id: mgbx3k2a.1043
event: file.changed
data: {"file":{"path":"Projects/Plan.md","name":"Plan.md","basename":"Plan","extension":"md","kind":"note","size":131,"mtime":"2026-10-16T14:04:10.311Z","version":"5d2f9c0e7b1a4c3d2e1f0a9b8c7d6e5f4a3b2c1d","aliases":["Roadmap"]},"origin":"c-9a8b7c6d5e4f"}

event: ping
data: {"serverTime":"2026-10-16T14:05:20.004Z"}

: keepalive

```

- **Event ids** look like `"<bootId>.<seq>"`. `bootId` (lowercase base 36) changes on every server start, and `seq` increases strictly within one boot. Clients that compare ids parse both parts.
- **Heartbeat:** every 20 s the server sends a **named `ping` event with no `id:` line**, followed by a comment line for proxies. Comment lines never reach script (the `EventSource` parser discards them), which is why the heartbeat is an event. Because it has no `id:`, it does not change the browser's last event id. `ping` is never stored for replay. Clients consider the stream stale after 45 s without any event, `ping` included.
- **Ordering** (normative for the server):
  - Events for one connection arrive in id order, and ids are assigned in the order changes happen: the server assigns the id, stores the event and queues it to every connection in one atomic step, before it releases the lock that protects the change. Two saves of the same file are therefore never delivered as v3 before v2.
  - A content event is published only after the change is on disk and in the index.
  - Within one operation: content events (`folder.created`, `file.*`, `entry.moved`, `folder.deleted`), then `trash.changed`, then one `history.committed` per commit made.
  - Snapshot endpoints (`GET /api/tree`, `GET /api/status`) read their `eventId` **before** taking the snapshot.

### 16.3 `hello` and replay

`hello` is always the first event of a connection.

| `resync` | Meaning | `hello` `id:` | `replayed` |
|---|---|---|---|
| `false` | The requested last id belongs to this boot and is still in the 1024-event replay buffer. The buffered events after it follow immediately. | The client's last id, unchanged | The number of replayed events that follow (after echo suppression) |
| `true` | There was no last id, or it came from another boot, or it is too old. The client must refetch the tree, its open documents and the visible panels (§16.5). | The current head (`eventId`), so `EventSource` never retries an unreplayable id | `0` |

`hello.data` is `{bootId, eventId (current head), resync, replayed, buildSha, serverTime}`. `buildSha` is the running server build; a page that loaded a different build reloads (DESIGN §6.18).

### 16.4 Event catalogue

`origin` is the `X-Client-Id` of the request that caused the change, or `null` for external changes (watcher or rescan) and startup. Only content events have an `origin` field.

**Echo suppression:** events marked "no" in the table are **not delivered** to the connection whose `clientId` equals `origin`. That client already has the result from its own HTTP response.

| `event:` | `data` type | To origin? | Meaning |
|---|---|---|---|
| `hello` | `HelloEvent` | n/a | See §16.3 |
| `ping` | `PingEvent` | n/a | Heartbeat, every 20 s; no `id:`, never replayed. Clients only use it to know the stream is alive. |
| `file.created` | `FileEvent` | no | A file appeared: created, uploaded, restored, or added externally (an external move also appears as `file.deleted` plus `file.created`) |
| `file.changed` | `FileEvent` | no | A file's content or metadata changed. `file.version` is the new version, and the entry is complete, including `aliases`. |
| `file.deleted` | `FileDeletedEvent` | no | A file disappeared. `trashed` is false for external deletes. `trashId` is the trash entry's id when `trashed` is true, so a client can offer Restore; otherwise `null`. |
| `folder.created` | `FolderEvent` | no | A folder appeared |
| `folder.deleted` | `FolderDeletedEvent` | no | A folder and **everything under it** disappeared. `trashId` as for `file.deleted`. |
| `entry.moved` | `MovedEvent` | no | A file or folder moved through the app. For `type: "folder"`, re-key every descendant by prefix replacement. |
| `trash.changed` | `TrashChangedEvent` (`{}`) | yes | The trash list changed |
| `history.committed` | `HistoryCommittedEvent` | yes | A commit was made. `paths` has at most 100 entries, and `truncated` is true when there were more. Not sent when an operation had nothing to commit. |
| `settings.changed` | `SettingsChangedEvent` | no | The settings were saved |
| `searches.changed` | `SavedSearchesChangedEvent` | no | The saved searches were saved (§12.4); refetch them |
| `bookmarks.changed` | `BookmarksChangedEvent` | no | The bookmarks were saved (§21). After a move or a trash restore the server re-keys them itself and sends this with `origin: null`, so it reaches every client, the mover's included. Refetch `GET /api/bookmarks`. |
| `status.changed` | `StatusChangedEvent` | yes | Something shown by `GET /api/status` changed state (`git.state`, `watcher.mode`, `settings.readOnly`, `mirror.state`, or free space crossing 1 GiB), or a push requested with §6.4 ended; refetch it |
| `flashcards.changed` | `FlashcardsChangedEvent` | no | Flashcard review records or settings changed (§34.7). Not in `VAULT_EVENT_NAMES`: the flashcards feature registers it with `registerEventHandler`. |
| `resync` | `ResyncEvent` | yes | The server could not describe the change precisely (watcher overflow, a bulk change of more than 50 entries, or a rescan error). Refetch everything (§16.5). |
| `task.created`, `task.changed` | `TaskEvent` | no | A task was created or changed through the task API (§20.8) |
| `task.deleted` | `TaskDeletedEvent` | no | A task was deleted through the task API |
| `list.changed` | `ListChangedEvent` | no | A task list was created, changed or deleted (`list: null`), or many of its tasks changed at once (the archive rollover, `origin: null`) |

The task events are not in `VAULT_EVENT_NAMES`: the tasks feature registers them with `registerEventHandler` (DESIGN §6.8), and their names are in `TASK_EVENT_NAMES` (§17).

Examples of `data` payloads:

```json
{"path":"Projects/Old plan.md","trashed":true,"trashId":"01JA7Q3M9K2Z","origin":"c-9a8b7c6d5e4f"}
{"path":"Projects/Beta","origin":null}
{"from":"Projects/Plan.md","to":"Projects/Roadmap.md","type":"file","origin":"c-9a8b7c6d5e4f"}
{"commitId":"c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2","message":"Update Projects/Plan.md","authorName":"R. J. Gehan","time":"2026-10-16T14:05:31.000Z","paths":["Projects/Plan.md"],"truncated":false}
{"version":"a1f3c5e7b9d0a2c4e6f8b0d2f4a6c8e0b2d4f6a8","origin":"c-1f2e3d4c5b6a"}
{"reason":"git"}
{"reason":"watcher-overflow"}
{"serverTime":"2026-10-16T14:05:20.004Z"}
```

### 16.5 Client algorithm

This is normative.

1. `GET /api/tree` and remember `tree.eventId`.
2. `es = new EventSource('/api/events?clientId=' + id + '&lastEventId=' + encodeURIComponent(tree.eventId))`. Add a listener for every name in `VAULT_EVENT_NAMES` and for every name registered by an extension (DESIGN §6.8).
3. On every event, including `hello` and `ping`, record the time (for the watchdog), and set `last = msg.lastEventId` when it is non-empty.
4. On `hello`:
   - Compare `buildSha` with the page's own build (DESIGN §6.18).
   - If `resync` is false, set `caughtUp` after `replayed` more events **that carry an id** have been applied (at once when it is 0); a `ping` never counts. Retry queued saves only after `caughtUp`, so a replayed `entry.moved` or `file.changed` is applied first.
   - If `resync` is true, run the **resync procedure**.
5. **Resync procedure** (on `hello {resync:true}` and on `resync`): set `buffering`; refetch the tree and invalidate all other server state; while the tree request is in flight, **buffer** incoming events instead of applying them. When the tree arrives, discard buffered events of the same `bootId` whose `seq` is at most the `seq` of `tree.eventId`, apply the rest in order, clear `buffering`, set `caughtUp`, and revalidate every open document. Without the buffer, an event applied to the old cache would be overwritten by a snapshot that predates it.
6. Apply the other events as specified in DESIGN §6.3. Applying an event must be idempotent, so the same `FileEntry` applied twice changes nothing.
7. **Reconnect.**
   - In `onerror`, check `es.readyState` at once: if it is `CLOSED`, close it and create a new `EventSource` with `lastEventId=last`, with backoff (1, 2, 5, 10, then every 30 s). If it is `CONNECTING`, the browser retries by itself (`retry: 3000`).
   - Watchdog: if no event (`ping` included) arrived for more than 45 s, recreate the stream the same way.
   - Also recreate it when the page becomes visible after being hidden, and on `pageshow` with `persisted: true` (back/forward cache).

---

## 17. TypeScript definitions (`frontend/src/api/types.ts`, verbatim)

```ts
// Generated from docs/API.md §17. Do not change without amending API.md.

export type VaultPath = string;   // vault-relative, '/'-separated, NFC; '' = root (folder contexts only)
export type Version = string;     // 40 lowercase hex: git blob id of the file bytes
export type IsoInstant = string;  // "2026-10-16T14:03:22.120Z"
export type EventId = string;     // "<bootId>.<seq>"

export type FileKind = 'note' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'other';
export type EntryType = 'file' | 'folder';
export type OnConflict = 'fail' | 'rename';
export type LinkStyle = 'wiki' | 'markdown';
export type ChangeType = 'added' | 'modified' | 'renamed' | 'deleted';

export interface TextRange { from: number; to: number }

// ---------- errors (§3) ----------
export type ErrorCode =
  | 'bad-request' | 'invalid-path' | 'invalid-name' | 'move-into-self'
  | 'client-id-required' | 'cross-origin' | 'identity-not-allowed' | 'reserved-path'
  | 'not-found' | 'method-not-allowed'
  | 'already-exists' | 'case-collision' | 'type-mismatch' | 'version-conflict' | 'settings-read-only'
  | 'task-conflict' | 'malformed-file'
  | 'too-large' | 'not-text' | 'unsupported-media-type' | 'unknown-host'
  | 'io-error' | 'permission-denied' | 'internal-error'
  | 'busy' | 'history-unavailable' | 'insufficient-storage'
  | 'not-audio' | 'transcription-off' | 'transcription-failed'
  | 'ai-unavailable' | 'ai-excluded' | 'ai-budget-exceeded';

export interface FieldError { field: string; message: string }

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  path?: VaultPath;
  existingPath?: VaultPath;
  expected?: 'file' | 'folder' | 'note';
  kind?: FileKind;
  limit?: number;
  spent?: number;                 // ai-budget-exceeded: this month's estimated spend in USD
  from?: VaultPath;
  to?: VaultPath;
  reason?: string;
  incidentId?: string;
  errors?: FieldError[];
}

export interface VersionConflictProblem extends Problem {
  code: 'version-conflict';
  path: VaultPath;
  currentVersion: Version | null;
  currentContent: string | null;
  currentMtime: IsoInstant | null;
  movedTo: VaultPath | null;      // set when the file is gone because it was moved during this server run
}

export interface TaskConflictProblem extends Problem {
  code: 'task-conflict';
  task?: Task;                    // the task as it is on the server (PATCH /api/tasks/{id})
  list?: TaskList;                // the list as it is on the server (PATCH /api/tasks/lists/{id})
  fields: string[];               // the requested fields that were changed on the server since the client read them
}

// ---------- identity / status (§6) ----------
export interface MeResponse {
  login: string;
  name: string;
  profilePicUrl: string | null;
  source: 'tailscale' | 'default';
}

export interface SkippedEntry { name: string; reason: 'unsafe-name' | 'nfc-shadowed' }
export interface StatusResponse {
  appVersion: string;
  buildSha: string;
  bootId: string;
  startedAt: IsoInstant;
  eventId: EventId;
  vault: { notes: number; files: number; folders: number; bytes: number;
           skipped: SkippedEntry[]; unwritableDirs: VaultPath[] };
  index: { builtInMs: number; lastRescanAt: IsoInstant | null };
  git: { enabled: boolean; state: 'ready' | 'importing' | 'failing' | 'disabled'; reason: string | null;
         head: string | null; pendingPaths: number; nextCommitAt: IsoInstant | null;
         lastCommitAt: IsoInstant | null; lastError: string | null; failingSince: IsoInstant | null;
         largeFiles: { limitBytes: number | null; files: number; bytes: number } };   // kept out of history (§14.1)
  watcher: { mode: 'inotify' | 'polling' | 'disabled' };
  disk: { freeBytes: number; repoBytes: number | null };
  settings: { readOnly: boolean; reason: string | null };
  mirror: MirrorStatus;
}

export interface MirrorStatus {
  state: 'disabled' | 'ready' | 'failing' | 'diverged';
  reason: string | null;          // why it is disabled: "not configured", "history is disabled" or a configuration error
  remote: string | null;          // the mirror's URL; never contains credentials
  branch: string | null;          // the branch pushed, e.g. "main"
  pushing: boolean;
  pushedCommit: string | null;    // the last commit the mirror is known to have (this server run)
  lastPushAt: IsoInstant | null;  // the last successful push (this server run)
  nextPushAt: IsoInstant | null;  // null when up to date, disabled or diverged
  lastError: string | null;
  failingSince: IsoInstant | null;
}

// ---------- status page (§6.5) ----------
export interface StatusDetails {
  runtime: { javaVersion: string; javaVendor: string; aotCache: 'in-use' | 'not-used' | 'off' | 'unknown';
             heapUsedBytes: number; heapMaxBytes: number; processors: number };
  events: { clients: number };    // open live-sync (SSE) connections: browser tabs and app windows
  git: { commits: number | null;  // in the history; null when history is off
         commitsThisRun: number; failedCommitsThisRun: number;
         largeFiles: Array<{ path: VaultPath; bytes: number }>;   // kept out of history, largest first, at most 100
         largeFilesTruncated: boolean };
  disk: { totalBytes: number | null };
  backup: BackupStatus;
  alerts: AlertsStatus;
}

export interface BackupStatus {
  state: 'unknown' | 'ok' | 'failed' | 'stale';
  reason: string | null;          // why it is unknown
  lastRun: IsoInstant | null;
  lastSuccess: IsoInstant | null;
  snapshot: string | null;        // the restic snapshot id of the last run
  offsite: string | null;         // 'ok', 'off' or 'failed'
  failures: string | null;        // the failed steps of the last run
}

export interface AlertsStatus {
  state: 'off' | 'on' | 'error';
  reason: string | null;          // why it is off, or what is wrong with ntfy.json
  server: string | null;          // the ntfy server; never the topic or the token
  sent: number;                   // this server run
  dropped: number;                // held back by the rate limit, this server run
  lastSentAt: IsoInstant | null;
  lastError: string | null;
  lastErrorAt: IsoInstant | null;
  recent: Array<{ marker: string; count: number; lastAt: IsoInstant }>;   // logged since the server started
}

export interface AlertTestResult { sent: boolean; error: string | null }   // POST /api/alerts/test (§6.6)

// ---------- settings (§5) ----------
export interface FilesSettings {
  newNoteLocation: 'root' | 'current' | 'folder';
  newNoteFolder: VaultPath;
  newLinkFormat: 'shortest' | 'relative' | 'absolute';
  useWikilinks: boolean;
  attachmentLocation: 'root' | 'folder' | 'current' | 'subfolder';
  attachmentFolder: VaultPath;
  attachmentSubfolder: string;
  autoUpdateLinks: boolean;
  excludedPaths: VaultPath[];
}
export interface DailyNotesSettings { format: string; folder: VaultPath; template: VaultPath; openOnStartup: boolean }
export interface TemplatesSettings { folder: VaultPath; dateFormat: string; timeFormat: string }
export interface EditorSettings { defaultMode: 'edit' | 'read'; readableLineLength: boolean; strictLineBreaks: boolean }
/** Ask your vault and summaries (§24). Optional in a request: a body without it keeps the current values. */
export interface AiSettings {
  enabled: boolean;               // off by default: nothing is sent to Anthropic until this is on
  provider: AiProvider;           // 'claude-code' (default): the CLI with your Claude subscription; 'api': billed per token
  model: AiModelId;               // 'claude-sonnet-5-5' (default), 'claude-opus-5-5' or 'claude-haiku-5-5'
  excludedPaths: VaultPath[];     // never sent; files.excludedPaths are never sent either. Default ['Private']
  maxContextChars: number;        // note text one request may carry, 4,000 to 400,000; default 60,000
  monthlyBudgetUsd: number;       // requests are refused once this month's estimated spend reaches it; default 5
}
export interface Settings {
  schemaVersion: 1;
  files: FilesSettings;
  dailyNotes: DailyNotesSettings;
  templates: TemplatesSettings;
  editor: EditorSettings;
  ai: AiSettings;
}
export interface SettingsResponse { settings: Settings; version: Version; readOnly: boolean }
export interface SettingsUpdateRequest { settings: Settings; baseVersion: Version }

// ---------- tree (§7) ----------
export interface FileEntry {
  path: VaultPath;
  name: string;
  basename: string;
  extension: string;
  kind: FileKind;
  size: number;
  mtime: IsoInstant;
  version: Version | null;
  aliases: string[];
}
export interface FolderEntry { path: VaultPath; name: string }
export interface TreeResponse { eventId: EventId; folders: FolderEntry[]; files: FileEntry[] }

// ---------- text files (§8) ----------
export interface TextFile {
  path: VaultPath;
  kind: 'note' | 'text';
  content: string;
  version: Version;
  size: number;
  mtime: IsoInstant;
  lossy: boolean;
}
export interface CreateFileRequest { path: VaultPath; content?: string; onConflict?: OnConflict }
export interface SaveFileRequest { content: string; baseVersion: Version | null; flushHistory?: boolean }
export interface WriteResult { file: FileEntry; created: boolean; createdFolders: VaultPath[] }

// ---------- attachments (§9.3) ----------
export interface AttachmentResult {
  file: FileEntry;
  created: boolean;
  createdFolders: VaultPath[];
  linkText: string;
  markdown: string;
}

// ---------- quick capture (§8.5, §8.6) ----------
export type CaptureTarget = 'inbox' | 'daily';
export interface CaptureRequest {
  text?: string | null;
  target?: CaptureTarget;         // default 'inbox'
  url?: string | null;            // a shared link (http/https becomes a Markdown link)
  title?: string | null;          // the link's label
  date?: string;                  // YYYY-MM-DD, the device's day
  time?: string;                  // HH:mm, the device's time
  tz?: string;                    // IANA zone, used for what date/time leave out
}
export interface CaptureResult {
  file: FileEntry;                // the note the entry was appended to
  created: boolean;               // the capture created the note (201)
  createdFolders: VaultPath[];
  target: CaptureTarget;
  attachment: FileEntry | null;   // POST /api/capture/file only
}

// ---------- folders / move (§10) ----------
export interface CreateFolderRequest { path: VaultPath }
export interface FolderResult { folder: FolderEntry; createdFolders: VaultPath[] }
export interface MoveRequest { from: VaultPath; to: VaultPath; updateLinks?: boolean; dryRun?: boolean }
export interface MovedFile { from: VaultPath; to: VaultPath }
export interface LinkUpdate { path: VaultPath; links: number; version: Version | null }
export type FailedReason = 'not-utf8' | 'not-rewritable' | 'span-mismatch' | 'io-error';
export interface FailedUpdate { path: VaultPath; reason: FailedReason }
export interface MoveResult {
  dryRun: boolean;
  type: EntryType;
  from: VaultPath;
  to: VaultPath;
  moved: MovedFile[];
  createdFolders: VaultPath[];
  linkUpdates: LinkUpdate[];
  failed: FailedUpdate[];
  commitId: string | null;        // the last commit made; null for a dry run, disabled git, nothing to commit, or a failed commit
}

// ---------- notes / links (§11) ----------
export interface HeadingInfo { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; line: number }
export interface OutgoingLink {
  raw: string;
  target: string;
  subpath: string | null;
  display: string | null;
  embed: boolean;
  style: LinkStyle;
  line: number;
  from: number;
  to: number;
  inFrontmatter: boolean;
  resolved: VaultPath | null;
}
export interface NoteMeta {
  path: VaultPath;
  version: Version;
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  aliases: string[];
  tags: string[];
  headings: HeadingInfo[];
  blockIds: string[];
  links: OutgoingLink[];
}
export interface Mention {
  line: number;
  from: number;
  to: number;
  matched: string;
  context: string;
  contextRange: TextRange;
}
export interface BacklinkGroup { source: VaultPath; sourceVersion: Version; mentions: Mention[] }
export interface BacklinksResponse { path: VaultPath; linked: BacklinkGroup[]; unlinked: BacklinkGroup[] | null }
export interface ResolveRequest { source: VaultPath; targets: string[] }
export interface ResolvedLink { path: VaultPath | null; createPath: VaultPath | null }
export interface ResolveResponse { resolved: Record<string, ResolvedLink> }
export interface HeadingRenameRequest { path: VaultPath; from: string; to: string; dryRun?: boolean }   // §22
export interface HeadingRenameResult {
  dryRun: boolean;
  path: VaultPath;
  from: string;
  to: string;
  linkUpdates: LinkUpdate[];      // notes whose links were (or, in a dry run, would be) updated; version null in a dry run
  failed: FailedUpdate[];
  bookmarks: number;              // heading bookmarks of the note that were (or would be) updated
  commitId: string | null;
}

// ---------- graph (§11.4) ----------
export type GraphNodeType = 'note' | 'attachment' | 'unresolved';
export interface GraphNode {
  path: VaultPath;   // the file; for 'unresolved', the link target as first written, without '.md'
  type: GraphNodeType;
  tags: string[];    // notes only: display casing, without '#', sorted case-insensitively
}
export interface GraphResponse {
  version: string;     // opaque; changes when a node, an edge or a note's tags change
  unchanged: boolean;  // `since` equals `version`: nodes and edges are empty, keep the graph you have
  nodes: GraphNode[];
  edges: number[];     // flat triples [source, target, count, ...]: node indexes, links from source to target
}

// ---------- compatibility report (§11.5) ----------
export interface ObsidianInfo { found: boolean; configFiles: string[]; problems: string[] }
export interface CompatSetting {
  source: string;               // 'app.json › attachmentFolderPath'
  obsidianValue: string;        // the value as JSON text
  setting: string | null;       // 'files.attachmentLocation'; null when NotesApp has none
  current: string | null;
  proposed: string | null;
  status: 'same' | 'different' | 'unsupported';
  note: string | null;
}
export interface CompatPlugin {
  id: string;
  name: string;
  kind: 'core' | 'community';
  status: 'supported' | 'partial' | 'planned' | 'unsupported' | 'unknown';
  note: string;
  roadmapItem: number | null;
}
export interface CompatOccurrence { path: VaultPath; line: number | null; text: string }
export interface CompatIssue {
  id: string;                   // 'dataview', 'missing-notes', …
  category: 'syntax' | 'links' | 'files';
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  roadmapItem: number | null;
  count: number;
  noteCount: number;
  occurrences: CompatOccurrence[];   // at most 200, in path order
  truncated: boolean;
}
export interface CompatTotals { notes: number; files: number; errors: number; warnings: number; infos: number }
export interface CompatReport {
  generatedAt: IsoInstant;
  tookMs: number;
  obsidian: ObsidianInfo;
  settings: CompatSetting[];
  proposedSettings: Settings | null;   // PUT /api/settings with baseVersion: settingsVersion to apply
  settingsVersion: Version;
  graph: Record<string, unknown> | null;   // .obsidian/graph.json, only the keys the graph view uses
  plugins: CompatPlugin[];
  issues: CompatIssue[];
  totals: CompatTotals;
}

// ---------- search / tags (§12) ----------
export interface SearchMatch {
  line: number;
  text: string;
  ranges: TextRange[];
  page: number | null;            // 1-based page of a PDF match; null otherwise
}
export interface SearchHit {
  path: VaultPath;
  basename: string;
  kind: FileKind;                 // 'note', or 'pdf' for a PDF's extracted text
  score: number;
  mtime: IsoInstant;
  titleRanges: TextRange[];
  matches: SearchMatch[];
  moreMatches: number;
}
export interface SearchCorrection { term: string; replacements: string[] }   // typo tolerance (§12.1)
export interface SearchResponse {
  query: string;
  total: number;
  tookMs: number;
  results: SearchHit[];
  corrections: SearchCorrection[];
}
export type SearchSort = 'relevance' | 'mtime';
export interface SavedSearch { id: string; name: string; query: string; sort: SearchSort }
export interface SavedSearchesResponse { searches: SavedSearch[]; version: Version | null }
export interface SavedSearchesUpdateRequest { searches: SavedSearch[]; baseVersion: Version | null }
export interface TagCount { tag: string; count: number; total: number }
export interface TagsResponse { tags: TagCount[] }

// ---------- trash (§13) ----------
export interface TrashEntry {
  id: string;
  originalPath: VaultPath;
  type: EntryType;
  deletedAt: IsoInstant;
  deletedBy: string;
  size: number;
  fileCount: number;
}
export interface TrashListResponse { entries: TrashEntry[] }
export interface RestoreRequest { to?: VaultPath; onConflict?: OnConflict }
export interface RestoreResult {
  type: EntryType;
  path: VaultPath;
  files: FileEntry[];
  createdFolders: VaultPath[];
  commitId: string | null;
}
export interface PurgeResult { purged: number }

// ---------- history (§14) ----------
export interface HistoryEntry {
  commitId: string;
  shortId: string;
  parentCommitId: string | null;  // read a 'deleted' entry's content from here
  path: VaultPath;
  time: IsoInstant;
  authorName: string;
  authorLogin: string;
  message: string;
  change: ChangeType;
  renamedFrom: VaultPath | null;
}
export interface HistoryResponse {
  path: VaultPath;
  pending: boolean;
  hasMore: boolean;
  entries: HistoryEntry[];
  excluded: HistoryExclusion | null;  // set when new versions of the file are not kept in history
}
export interface HistoryExclusion { reason: 'large-file'; size: number; limitBytes: number }
export interface HistoryContent {
  commitId: string;
  path: VaultPath;
  version: Version;
  size: number;
  binary: boolean;
  content: string | null;
  lossy: boolean;
}
export interface HistoryRestoreRequest { path: VaultPath; commit: string; sourcePath?: VaultPath; baseVersion: Version | null }
export interface HistoryRestoreResult { file: FileEntry; created: boolean; createdFolders: VaultPath[]; commitId: string | null }
export interface CommitResult { commitId: string | null }

// ---------- vault-wide history (§14.6–14.8) ----------
export interface TimelineFile { path: VaultPath; change: ChangeType; renamedFrom: VaultPath | null }
export interface TimelineEntry {
  commitId: string;
  shortId: string;
  parentCommitId: string | null;
  time: IsoInstant;
  authorName: string;
  authorLogin: string;
  message: string;
  files: TimelineFile[];          // at most 100; hidden paths (.notesapp/…) left out
  filesTotal: number;
}
export interface TimelineResponse { entries: TimelineEntry[]; hasMore: boolean }
export interface ChangesResponse {
  since: IsoInstant | null;
  until: IsoInstant | null;
  fromCommitId: string | null;    // the last commit before since; null = the beginning
  toCommitId: string | null;      // the last commit before until; null = no commits
  commits: number;
  authors: string[];
  files: TimelineFile[];          // net change from fromCommitId to toCommitId, at most 1000
  truncated: boolean;
}
export interface DeletedFile {
  path: VaultPath;
  deletedAt: IsoInstant;
  commitId: string;
  shortId: string;
  parentCommitId: string;         // its last content; restore with POST /api/history/restore
  authorName: string;
  authorLogin: string;
  message: string;
}
export interface DeletedFilesResponse { entries: DeletedFile[]; total: number; hasMore: boolean }

// ---------- templates (§15.4) ----------
export interface TemplateEntry { path: VaultPath; name: string }
export interface TemplatesResponse { folder: VaultPath; templates: TemplateEntry[] }

// ---------- bookmarks (§21) ----------
/**
 * One bookmark, in Obsidian's bookmarks.json format: `type` is 'file' (a note or any file; with `subpath`
 * '#Heading' or '#^blockid' for part of a note), 'folder', 'search' or 'group'. Other types Obsidian writes
 * ('url', 'graph') pass through unchanged. Fields that do not apply are absent rather than null, and fields this
 * build does not know are kept.
 */
export interface BookmarkItem {
  type: string;
  ctime?: number;                 // when it was bookmarked, epoch milliseconds
  title?: string;                 // a display name; groups show theirs
  path?: VaultPath;               // file and folder
  subpath?: string;               // file: '#Heading' or '#^blockid'
  query?: string;                 // search
  items?: BookmarkItem[];         // group
  [field: string]: unknown;
}
export interface BookmarksResponse { version: Version; items: BookmarkItem[] }
export interface BookmarksUpdateRequest { items: BookmarkItem[]; baseVersion: Version }

// ---------- voice notes (§23) ----------
export interface TranscriptionStatus {
  enabled: boolean;
  service: string | null;   // "whisper-asr at http://notesapp-whisper:9000"; never credentials
  language: string | null;  // the configured language; null = detected per recording
  maxBytes: number;         // larger recordings are not sent
}
export interface TranscriptionResult {
  path: VaultPath;
  text: string;             // "" when no speech was recognized
  language: string | null;
  millis: number;           // the service's time; 0 for a transcript the server had kept
}

// ---------- Ask your vault and summaries (§24) ----------
export type AiModelId = string;
export type AiProvider = 'claude-code' | 'api';
export type AiAction = 'ask' | 'summarize' | 'suggest';
export type AiScope = 'note' | 'folder' | 'notes' | 'selection';
/** What a turn asked: a question, or the fields of a summary request. */
export interface AiPrompt {
  action: AiAction;
  question?: string | null;       // ask
  scope?: AiScope | null;         // summarize, suggest
  path?: VaultPath | null;
  paths?: VaultPath[] | null;
  text?: string | null;
  label?: string | null;
}
/** An earlier turn of the conversation, as this device keeps it. */
export interface AiTurn { prompt: AiPrompt; answer: string; sources: VaultPath[] }
export interface AiAskRequest {
  question: string;               // 1 to 4,000 characters
  activePath?: VaultPath | null;  // the open note: sent first when it is not excluded
  history?: AiTurn[];             // oldest first, at most 50; the last 12 are used
}
export interface AiSummarizeRequest {
  action?: 'summarize' | 'suggest';   // suggest: links, tags and tasks for a note
  scope: AiScope;
  path?: VaultPath | null;        // the note, the folder, or the note a selection comes from
  paths?: VaultPath[];            // scope 'notes', at most 100
  text?: string | null;           // scope 'selection', at most 200,000 characters
  label?: string | null;          // what 'notes' are, e.g. "this week's daily notes"
  history?: AiTurn[];
}
export interface AiModelInfo { id: AiModelId; label: string; inputUsdPerMTok: number; outputUsdPerMTok: number }
export interface AiStatus {
  state: 'off' | 'not-configured' | 'over-budget' | 'ready';
  reason: string | null;
  provider: AiProvider;
  model: AiModelId;
  models: AiModelInfo[];
  keyFile: string;                // the provider's credential file (claude-token or anthropic-key), never its content
  keyPresent: boolean;
  cliInstalled: boolean;          // the Claude Code CLI is on the server
  month: string;                  // "2026-10", in the server's time zone
  monthCostUsd: number;           // estimated
  monthRequests: number;
  monthlyBudgetUsd: number;
  maxContextChars: number;
  fake: boolean;                  // a development server that answers without Anthropic
}
export interface AiSource { path: VaultPath; chars: number; truncated: boolean }
/** Events of the answer stream (`text/event-stream` on POST /api/ai/ask and /api/ai/summarize). */
export interface AiStartEvent { model: AiModelId; sources: AiSource[]; omitted: number; excluded: number }
export interface AiDeltaEvent { text: string }
export interface AiRestartEvent { model: AiModelId }   // a fallback model answers from the start
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
export interface AiDoneEvent {
  model: AiModelId;
  stopReason: string;             // 'end_turn', 'max_tokens', 'refusal', ...
  refusalCategory: string | null;
  fellBack: boolean;
  usage: AiUsage;
  costUsd: number;                // estimated, this request
  monthCostUsd: number;           // estimated, this month so far
}
export interface AiErrorEvent {
  code: 'auth' | 'rate-limited' | 'overloaded' | 'bad-request' | 'unavailable' | 'busy' | 'internal-error';
  message: string;
}
export interface AiStreamEventMap {
  start: AiStartEvent;
  delta: AiDeltaEvent;
  restart: AiRestartEvent;
  done: AiDoneEvent;
  error: AiErrorEvent;
}

// ---------- SSE (§16) ----------
export interface HelloEvent {
  bootId: string;
  eventId: EventId;               // current head
  resync: boolean;
  replayed: number;               // replayed events that follow this hello; 0 when resync is true
  buildSha: string;               // running server build; compare with the page's own build
  serverTime: IsoInstant;
}
export interface PingEvent { serverTime: IsoInstant }   // heartbeat; sent without an id, never replayed
export interface FileEvent { file: FileEntry; origin: string | null }
export interface FileDeletedEvent { path: VaultPath; trashed: boolean; trashId: string | null; origin: string | null }
export interface FolderEvent { path: VaultPath; origin: string | null }
export interface FolderDeletedEvent { path: VaultPath; trashed: boolean; trashId: string | null; origin: string | null }
export interface MovedEvent { from: VaultPath; to: VaultPath; type: EntryType; origin: string | null }
export type TrashChangedEvent = Record<string, never>;
export interface HistoryCommittedEvent {
  commitId: string;
  message: string;
  authorName: string;
  time: IsoInstant;
  paths: VaultPath[];
  truncated: boolean;
}
export interface SettingsChangedEvent { version: Version; origin: string | null }
export interface BookmarksChangedEvent { version: Version; origin: string | null }   // origin null: re-keyed by the server after a move or restore
export interface StatusChangedEvent { reason: 'git' | 'watcher' | 'settings' | 'disk' | 'mirror' }
export interface ResyncEvent { reason: 'watcher-overflow' | 'bulk-change' | 'rescan-error' }
export interface SavedSearchesChangedEvent { version: Version; origin: string | null }

export interface VaultEventMap {
  'hello': HelloEvent;
  'ping': PingEvent;
  'file.created': FileEvent;
  'file.changed': FileEvent;
  'file.deleted': FileDeletedEvent;
  'folder.created': FolderEvent;
  'folder.deleted': FolderDeletedEvent;
  'entry.moved': MovedEvent;
  'trash.changed': TrashChangedEvent;
  'history.committed': HistoryCommittedEvent;
  'settings.changed': SettingsChangedEvent;
  'bookmarks.changed': BookmarksChangedEvent;
  'status.changed': StatusChangedEvent;
  'resync': ResyncEvent;
  'searches.changed': SavedSearchesChangedEvent;
}
export type VaultEventName = keyof VaultEventMap;
export const VAULT_EVENT_NAMES: readonly VaultEventName[] = [
  'hello', 'ping', 'file.created', 'file.changed', 'file.deleted', 'folder.created', 'folder.deleted',
  'entry.moved', 'trash.changed', 'history.committed', 'settings.changed', 'bookmarks.changed', 'status.changed',
  'resync', 'searches.changed',
];
// Extensions add their own event names at runtime with registerEventHandler (DESIGN §6.8).

// ---------- tasks (§20) ----------
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type TaskPriority = 0 | 1 | 2 | 3;              // none / low / medium / high
export type TaskView = 'today' | 'upcoming' | 'list' | 'completed' | 'search';
export type LocalDate = string;                       // 'YYYY-MM-DD' in the user's own time zone
export type LocalDateTime = string;                   // 'YYYY-MM-DDTHH:mm' in the user's own time zone
export type TaskDate = LocalDate | LocalDateTime;
export type OrderKey = string;                        // fractional index (§20.1)

export interface TaskRecurrence { rrule: string; from: 'due' | 'completion' }   // RFC 5545 RRULE subset (§20.6)
export interface TaskReminder { at: LocalDateTime }
export interface TaskSection { id: string; name: string; order: OrderKey }
export interface TaskList {
  id: string;
  name: string;
  color: string | null;           // '#rrggbb' or a color name such as 'green'
  icon: string | null;            // a lucide icon name such as 'shopping-cart'
  order: OrderKey;
  archived: boolean;              // left out of Today, Upcoming and the all-lists view
  sections: TaskSection[];        // in order
  path: VaultPath;                // the list's .tasks file
  writable: boolean;              // false: written by a newer NotesApp, so this version only reads it
}
export interface Task {
  id: string;
  listId: string;
  sectionId: string | null;
  parentId: string | null;        // subtasks, at most 3 levels
  title: string;                  // one line; [[Note]] links and #tags allowed inline
  notes: string | null;           // Markdown
  status: TaskStatus;
  priority: TaskPriority;
  due: TaskDate | null;
  start: TaskDate | null;         // the "do on" date; drives Today
  recurrence: TaskRecurrence | null;
  reminders: TaskReminder[];      // stored and validated; delivered by ROADMAP item 9
  tags: string[];                 // without '#'
  links: VaultPath[];             // related notes
  order: OrderKey;
  createdAt: IsoInstant | null;   // null only for a task added by hand without it
  updatedAt: IsoInstant | null;
  completedAt: IsoInstant | null;
  archived: boolean;              // closed and rolled into an archive file (Tasks/Archive/...)
}
export interface TaskFileProblem { path: VaultPath; taskId: string | null; reason: string }
export interface TasksResponse {
  view: TaskView;
  lists: TaskList[];              // every usable list, in order, archived ones included
  tasks: Task[];
  total: number;                  // matching tasks; tasks holds at most `limit` for completed and search
  problems: TaskFileProblem[];
}
export interface TaskListsResponse { lists: TaskList[]; problems: TaskFileProblem[] }

export interface TaskFields {     // what a client sets; null clears an optional field
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due?: TaskDate | null;
  start?: TaskDate | null;
  recurrence?: TaskRecurrence | null;
  reminders?: TaskReminder[];
  tags?: string[];
  links?: VaultPath[];
  listId?: string;
  sectionId?: string | null;
  parentId?: string | null;
}
export interface CreateTaskRequest extends TaskFields { title: string; after?: string | null }
export interface UpdateTaskRequest { changes: TaskFields; base?: TaskFields }
export interface CompleteTaskRequest {
  tz?: string;                    // the client's IANA time zone, or
  date?: LocalDate;               // the client's date: the completion day for recurrence
  base?: { due?: TaskDate | null; start?: TaskDate | null };
}
export interface ReorderTasksRequest {
  listId: string;
  sectionId: string | null;       // top-level tasks only
  parentId: string | null;
  ids: string[];
  after: string | null;           // null: first
}
export interface TaskWriteResult {
  task: Task | null;              // the addressed task after the change; null for reorder and delete
  changed: Task[];                // other tasks the change touched
  deleted: string[];              // ids removed: the task and its subtasks
  rolledForward: boolean;         // complete: a recurring task moved to its next occurrence
  files: FileEntry[];             // list files written; apply them like file.changed / file.created
  createdFolders: VaultPath[];
  lists: TaskList[];              // lists the change created (the Inbox, on first use); apply them like list.changed
}

export interface TaskListFields { name?: string; color?: string | null; icon?: string | null; archived?: boolean }
export interface CreateTaskListRequest { name: string; color?: string | null; icon?: string | null }
export interface UpdateTaskListRequest { changes: TaskListFields; base?: TaskListFields }
export interface ReorderRequest { ids: string[]; after: string | null }
export interface SectionRequest { name: string }
export interface TaskListWriteResult {
  lists: TaskList[];              // the created, changed or reordered lists, after the change
  files: FileEntry[];             // list files written or created
  createdFolders: VaultPath[];
  moved: MovedFile | null;        // a rename that renamed the list's file
  trash: TrashEntry | null;       // a delete: the trash entry of the list's file
}

export interface TaskEvent { task: Task; origin: string | null }
export interface TaskDeletedEvent { id: string; listId: string; origin: string | null }
export interface ListChangedEvent { listId: string; list: TaskList | null; origin: string | null }
export interface TaskEventMap {
  'task.created': TaskEvent;
  'task.changed': TaskEvent;
  'task.deleted': TaskDeletedEvent;
  'list.changed': ListChangedEvent;
}
export type TaskEventName = keyof TaskEventMap;
export const TASK_EVENT_NAMES: readonly TaskEventName[] = ['task.created', 'task.changed', 'task.deleted', 'list.changed'];
// ---------- Flashcards (API.md §34, ROADMAP item 34) ----------
export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy' | 'reset';
export type FlashcardPhase = 'new' | 'learning' | 'review' | 'relearning';
export interface FlashcardConfig {
  tags: string[];               // without '#'; nested tags count too
  foldersAsDecks: boolean;      // decks are folders, and every note with cards counts
  newPerDay: number;
  reviewsPerDay: number;
  retention: number;            // FSRS desired retention, 0.7 to 0.99
  maximumInterval: number;      // days
  learningSteps: string[];      // '1m', '10m', '1d'
  relearningSteps: string[];
  fuzz: boolean;
  dayStartsAt: number;          // local hour when a new study day starts
}
export interface FlashcardCardState {
  due: IsoInstant;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  phase: FlashcardPhase;
  lastReview: IsoInstant | null;
  n: number;                    // the number of reviews this state was computed from
}
export interface FlashcardCard {
  note: VaultPath | null;
  front: string | null;
  state: FlashcardCardState | null;
  reviews: string[];            // "<instant> <rating>[ <ms>]", oldest first
}
export interface FlashcardsResponse { config: FlashcardConfig; cards: Record<string, FlashcardCard>; version: Version | null }
export interface FlashcardReview {
  card: string;
  at: IsoInstant;
  rating: FlashcardRating;
  ms?: number;
  note?: VaultPath;
  front?: string;
  state?: FlashcardCardState;
  from?: string;                // the card's previous id, when its text was edited
}
export interface FlashcardReviewRequest { reviews: FlashcardReview[] }
export interface FlashcardUndoRequest { card: string; at: IsoInstant; state?: FlashcardCardState }
export interface FlashcardPruneRequest { cards: string[] }
export interface FlashcardConfigUpdateRequest { config: Partial<{ [K in keyof FlashcardConfig]: FlashcardConfig[K] | null }> }
export interface FlashcardWriteResult { cards: Record<string, FlashcardCard | null>; version: Version }
export interface FlashcardNote { path: VaultPath; version: Version; content: string }
export interface FlashcardNotesResponse { config: FlashcardConfig; notes: FlashcardNote[] }
export interface FlashcardsChangedEvent {
  cards: Record<string, FlashcardCard | null> | null;   // null: too many changed, refetch
  config: FlashcardConfig | null;
  version: Version;
  origin: string | null;
}

// ---------- Habits (API.md §35, ROADMAP item 35) ----------
export interface HabitNote { path: VaultPath; version: Version; properties: Record<string, unknown> }   // the frontmatter
export interface DailyNoteValues { path: VaultPath; values: Record<string, boolean | number | string> }
export interface HabitsResponse {
  folder: VaultPath;            // where new habits go: 'Habits'
  tag: string;                  // 'habit': notes with #habit anywhere are habits too
  habits: HabitNote[];
  dailyFolder: VaultPath;       // the daily-notes folder, as it is in the vault
  daily: DailyNoteValues[];     // daily notes with simple frontmatter values
}
```

---

## 18. Endpoint index

| Method | Path | Request | Success | § |
|---|---|---|---|---|
| GET | `/api/me` | | 200 `MeResponse` | 6.1 |
| GET | `/api/status` | | 200 `StatusResponse` | 6.2 |
| GET | `/api/status/details` | | 200 `StatusDetails` | 6.5 |
| POST | `/api/alerts/test` | | 200 `AlertTestResult` | 6.6 |
| POST | `/api/mirror/push` | | 202 `MirrorStatus` | 6.4 |
| GET | `/api/settings` | | 200 `SettingsResponse` | 5 |
| PUT | `/api/settings` | `SettingsUpdateRequest` | 200 `SettingsResponse` | 5 |
| GET | `/api/tree` | | 200 `TreeResponse` | 7 |
| GET | `/api/files?path=` | | 200 `TextFile` | 8.1 |
| POST | `/api/files` | `CreateFileRequest` | 201 `WriteResult` | 8.2 |
| PUT | `/api/files?path=` | `SaveFileRequest` | 200 `WriteResult` (201 when `baseVersion` was null) | 8.3 |
| DELETE | `/api/files?path=` | | 200 `TrashEntry` | 8.4 |
| POST | `/api/capture` | `CaptureRequest` | 201/200 `CaptureResult` | 8.5 |
| POST | `/api/capture/file?name=&text=&target=&date=&time=&tz=` | raw bytes | 201/200 `CaptureResult` | 8.6 |
| GET | `/api/files/raw?path=&v=&download=` | | 200/206/304 bytes | 9.1 |
| PUT | `/api/files/raw?path=&onConflict=` | raw bytes | 201/200 `WriteResult` | 9.2 |
| POST | `/api/attachments?name=&source=` | raw bytes | 201 `AttachmentResult` | 9.3 |
| POST | `/api/folders` | `CreateFolderRequest` | 201 `FolderResult` | 10.1 |
| DELETE | `/api/folders?path=` | | 200 `TrashEntry` | 10.2 |
| POST | `/api/move` | `MoveRequest` | 200 `MoveResult` | 10.3 |
| GET | `/api/notes/meta?path=` | | 200 `NoteMeta` | 11.1 |
| GET | `/api/notes/backlinks?path=&unlinked=` | | 200 `BacklinksResponse` | 11.2 |
| POST | `/api/links/resolve` | `ResolveRequest` | 200 `ResolveResponse` | 11.3 |
| GET | `/api/graph?since=` | | 200 `GraphResponse` | 11.4 |
| GET | `/api/compat` | | 200 `CompatReport` | 11.5 |
| GET | `/api/search?q=&limit=&sort=&prefix=` | | 200 `SearchResponse` | 12.1 |
| GET | `/api/tags` | | 200 `TagsResponse` | 12.2 |
| GET | `/api/searches` | | 200 `SavedSearchesResponse` | 12.3 |
| PUT | `/api/searches` | `SavedSearchesUpdateRequest` | 200 `SavedSearchesResponse` | 12.3 |
| GET | `/api/trash` | | 200 `TrashListResponse` | 13.1 |
| GET | `/api/trash/{id}/raw` | | 200/206/304 bytes | 13.2 |
| POST | `/api/trash/{id}/restore` | `RestoreRequest` (optional) | 200 `RestoreResult` | 13.3 |
| DELETE | `/api/trash/{id}` | | 204 | 13.4 |
| DELETE | `/api/trash` | | 200 `PurgeResult` | 13.5 |
| GET | `/api/history?path=&limit=&offset=` | | 200 `HistoryResponse` | 14.1 |
| GET | `/api/history/content?path=&commit=` | | 200 `HistoryContent` | 14.2 |
| GET | `/api/history/raw?path=&commit=` | | 200 bytes | 14.3 |
| POST | `/api/history/restore` | `HistoryRestoreRequest` | 200 `HistoryRestoreResult` | 14.4 |
| POST | `/api/history/commit` | | 200 `CommitResult` | 14.5 |
| GET | `/api/history/log?path=&author=&since=&until=&limit=&offset=` | | 200 `TimelineResponse` | 14.6 |
| GET | `/api/history/changes?since=&until=&path=` | | 200 `ChangesResponse` | 14.7 |
| GET | `/api/history/deleted?q=&limit=&offset=` | | 200 `DeletedFilesResponse` | 14.8 |
| GET | `/api/templates` | | 200 `TemplatesResponse` | 15.4 |
| GET | `/api/tasks?view=&list=&tag=&priority=&status=&q=&date=&tz=&days=&limit=&before=` | | 200 `TasksResponse` | 20.2 |
| GET | `/api/tasks/{id}` | | 200 `Task` | 20.3 |
| POST | `/api/tasks` | `CreateTaskRequest` | 201 `TaskWriteResult` | 20.4 |
| PATCH | `/api/tasks/{id}` | `UpdateTaskRequest` | 200 `TaskWriteResult` | 20.4 |
| POST | `/api/tasks/{id}/complete` | `CompleteTaskRequest` (optional) | 200 `TaskWriteResult` | 20.4 |
| POST | `/api/tasks/{id}/uncomplete` | | 200 `TaskWriteResult` | 20.4 |
| POST | `/api/tasks/reorder` | `ReorderTasksRequest` | 200 `TaskWriteResult` | 20.4 |
| DELETE | `/api/tasks/{id}` | | 200 `TaskWriteResult` | 20.4 |
| GET | `/api/tasks/lists` | | 200 `TaskListsResponse` | 20.5 |
| POST | `/api/tasks/lists` | `CreateTaskListRequest` | 201 `TaskListWriteResult` | 20.5 |
| PATCH | `/api/tasks/lists/{id}` | `UpdateTaskListRequest` | 200 `TaskListWriteResult` | 20.5 |
| DELETE | `/api/tasks/lists/{id}` | | 200 `TaskListWriteResult` | 20.5 |
| POST | `/api/tasks/lists/reorder` | `ReorderRequest` | 200 `TaskListWriteResult` | 20.5 |
| POST | `/api/tasks/lists/{id}/sections` | `SectionRequest` | 201 `TaskListWriteResult` | 20.5 |
| PATCH | `/api/tasks/lists/{id}/sections/{sectionId}` | `SectionRequest` | 200 `TaskListWriteResult` | 20.5 |
| DELETE | `/api/tasks/lists/{id}/sections/{sectionId}` | | 200 `TaskListWriteResult` | 20.5 |
| POST | `/api/tasks/lists/{id}/sections/reorder` | `ReorderRequest` | 200 `TaskListWriteResult` | 20.5 |
| GET | `/api/bookmarks` | | 200 `BookmarksResponse` | 21.1 |
| PUT | `/api/bookmarks` | `BookmarksUpdateRequest` | 200 `BookmarksResponse` | 21.2 |
| POST | `/api/notes/rename-heading` | `HeadingRenameRequest` | 200 `HeadingRenameResult` | 22 |
| GET | `/api/transcription` | | 200 `TranscriptionStatus` | 23.1 |
| POST | `/api/transcriptions` | `TranscribeRequest` | 200 `TranscriptionResult` | 23.2 |
| GET | `/api/flashcards` | | 200 `FlashcardsResponse` | 34.3 |
| GET | `/api/flashcards/notes` | | 200 `FlashcardNotesResponse` | 34.2 |
| POST | `/api/flashcards/reviews` | `FlashcardReviewRequest` | 200 `FlashcardWriteResult` | 34.4 |
| POST | `/api/flashcards/undo` | `FlashcardUndoRequest` | 200 `FlashcardWriteResult` | 34.5 |
| POST | `/api/flashcards/prune` | `FlashcardPruneRequest` | 200 `FlashcardWriteResult` | 34.5 |
| PUT | `/api/flashcards/config` | `FlashcardConfigUpdateRequest` | 200 `FlashcardConfig` | 34.6 |
| GET | `/api/habits` | | 200 `HabitsResponse` | 35.1 |
| GET | `/api/events?clientId=&lastEventId=` | | `text/event-stream` | 16 |
| GET | `/api/ai/status` | | 200 `AiStatus` | 24.4 |
| POST | `/api/ai/ask` | `AiAskRequest` | 200 `text/event-stream` | 24.2 |
| POST | `/api/ai/summarize` | `AiSummarizeRequest` | 200 `text/event-stream` | 24.3 |
| GET | `/actuator/health`, `/livez`, `/readyz` | | 200 / 503 | 6.3 |

**SPA routes** are served `index.html` by the server: `/`, `/n/**`, `/search`, `/trash`, `/settings`, `/settings/**`, `/x/**` (pages registered by extensions), `/capture` (quick capture, DESIGN §6.27) and `/clip` (the web clipper's hand-over page, DESIGN §6.27.1). Static bundles are served from `/assets/**`; root files such as `/theme-boot.js` and `/favicon.svg` are served with `no-cache`.

**Web clipper** (DESIGN §6.27.1): `/clip` is the only response sent with `Cross-Origin-Opener-Policy: unsafe-none` (every other one has `same-origin`), so the bookmarklet's window can post to it. `/clipper/clipper.js`, `/clipper/shortcut.js` and `/clipper/bookmarklet.js` are the clipper build's scripts (`no-cache`); a server built without the clipper answers them `404`.

**Installable app** (DESIGN §6.26): `/sw.js` (the service worker) is served with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`; `/manifest.webmanifest` as `application/manifest+json` with `no-cache`. `POST /capture/share` is the manifest's share target, answered by the service worker; one that reaches the server (no worker) gets `303 See Other` to `/capture?share=lost` and nothing is stored.

---

## 19. Java record names

`com.rjgehan.notes.api.dto` holds records with the same name and the same component names as the TypeScript interfaces. Nested object types become nested records.

| TypeScript | Java record | Notes |
|---|---|---|
| `TextRange` | `TextRange(int from, int to)` | |
| `FieldError` | `FieldError(String field, String message)` | Placed in `api.error` |
| `MeResponse` | `MeResponse` | |
| `StatusResponse`, `SkippedEntry` | `StatusResponse` with nested `VaultStats`, `IndexStats`, `GitStatus` (with nested `LargeFilesStats`), `WatcherStatus`, `DiskStatus`, `SettingsStatus`; `SkippedEntry(String name, SkipReason reason)` | Enums `GitState` and `SkipReason` serialize as their lower-case strings |
| `MirrorStatus` | Same | Enum `MirrorState` serializes as its lower-case string |
| `StatusDetails`, `BackupStatus`, `AlertsStatus`, `AlertTestResult` | `StatusDetails` with nested `RuntimeStatus`, `EventsStatus`, `GitDetails` (with nested `LargeFile`), `DiskDetails`; `BackupStatus`; `AlertsStatus` with nested `MarkerCount`; `AlertTestResult` | Enums `AotCacheState` (`in-use`, `not-used`, `off`, `unknown`), `BackupState` and `AlertsState` serialize as their lower-case strings |
| `Settings`, `FilesSettings`, `DailyNotesSettings`, `TemplatesSettings`, `EditorSettings` | Same names in `com.rjgehan.notes.settings` | Enums: `NewNoteLocation`, `LinkFormat`, `AttachmentLocation`, `EditorMode` |
| `SettingsResponse`, `SettingsUpdateRequest` | Same | |
| `FileEntry`, `FolderEntry`, `TreeResponse` | Same | |
| `TextFile`, `CreateFileRequest`, `SaveFileRequest`, `WriteResult`, `AttachmentResult` | Same | `SaveFileRequest.baseVersion` is a `@Nullable String` (missing and `null` both mean "create"). `flushHistory` is `@Nullable Boolean` (default false). |
| `CaptureRequest`, `CaptureResult`, `CaptureTarget` | Same | Every `CaptureRequest` component is `@Nullable`; `CaptureTarget` is an enum (`inbox`, `daily`); `CaptureResult.attachment` is a `@Nullable FileEntry`. |
| `CreateFolderRequest`, `FolderResult`, `MoveRequest`, `MovedFile`, `LinkUpdate`, `FailedUpdate`, `MoveResult` | Same | `MoveRequest.updateLinks` and `dryRun` are `@Nullable Boolean`. `FailedUpdate.reason` is the enum `FailedReason` |
| `HeadingInfo`, `OutgoingLink`, `NoteMeta`, `Mention`, `BacklinkGroup`, `BacklinksResponse`, `ResolveRequest`, `ResolvedLink`, `ResolveResponse` | Same | `NoteMeta.frontmatter` is `@Nullable Map<String, Object>` |
| `SearchMatch`, `SearchHit`, `SearchCorrection`, `SearchResponse`, `TagCount`, `TagsResponse` | Same | `SearchMatch.page` is a `@Nullable Integer`; `SearchHit.kind` is `FileKind` |
| `SavedSearch`, `SavedSearchesResponse`, `SavedSearchesUpdateRequest` | Same | `SavedSearch.sort` is a `String` (`relevance` or `mtime`); `SavedSearchesUpdateRequest.searches` is a `@Nullable JsonNode`, so every invalid field is reported by name |
| `GraphNode`, `GraphResponse` | Same | `GraphNode.type` is the enum `GraphNodeType` (`note`, `attachment`, `unresolved`); `GraphResponse.edges` is an `int[]` |
| `CompatReport`, `ObsidianInfo`, `CompatSetting`, `CompatPlugin`, `CompatIssue`, `CompatOccurrence`, `CompatTotals` | Same | Nested enums `CompatSetting.Status`, `CompatPlugin.Kind`, `CompatPlugin.Support`, `CompatIssue.Category`, `CompatIssue.Severity` serialize as the lower-case strings in §17. `CompatReport.proposedSettings` is a `@Nullable Settings`, `graph` a `@Nullable ObjectNode` |
| `TrashEntry`, `TrashListResponse`, `RestoreRequest`, `RestoreResult`, `PurgeResult` | Same | |
| `HistoryEntry`, `HistoryResponse`, `HistoryExclusion`, `HistoryContent`, `HistoryRestoreRequest`, `HistoryRestoreResult`, `CommitResult` | Same | `HistoryExclusion.reason` is the nested enum `Reason` (`large-file`) |
| `TimelineFile`, `TimelineEntry`, `TimelineResponse`, `ChangesResponse`, `DeletedFile`, `DeletedFilesResponse` | Same | `TimelineFile.change` is `ChangeType` |
| `TemplateEntry`, `TemplatesResponse` | Same | |
| `BookmarksResponse`, `BookmarksUpdateRequest` | Same | `BookmarkItem` is not a record: items stay JSON objects (`ObjectNode`; `JsonNode` in the request), so fields from Obsidian or a newer build survive; `BookmarkCodec` checks the fields it knows (§21.2) |
| `HeadingRenameRequest`, `HeadingRenameResult` | Same | Every request field is `@Nullable` so a missing one is reported in `errors[]`; `dryRun` defaults to false |
| `TranscriptionStatus`, `TranscriptionResult` | Same; the request is `TranscribeRequest(String path)` | |
| `HelloEvent`, `PingEvent`, `FileEvent`, `FileDeletedEvent`, `FolderEvent`, `FolderDeletedEvent`, `MovedEvent`, `TrashChangedEvent`, `HistoryCommittedEvent`, `SettingsChangedEvent`, `BookmarksChangedEvent`, `StatusChangedEvent`, `ResyncEvent`, `SavedSearchesChangedEvent` | Same names in `com.rjgehan.notes.events`, all implementing `sealed interface VaultEvent { @JsonIgnore String eventName(); @JsonIgnore default @Nullable String echoOrigin() { return null; } }` | `eventName()` returns the §16.4 string. Content events (`file.*`, `folder.*`, `entry.moved`, `settings.changed`) have a real `origin` record component, which is serialized, and override `echoOrigin()` to return it. Non-content events have no `origin` component, so they never serialize `"origin": null` into an event the TypeScript types declare without one. Neither interface method is serialized. `HelloEvent` and `PingEvent` are written by `EventHub` directly and never stored in the replay ring. |
| `Problem` / `VersionConflictProblem` / `TaskConflictProblem` | Not records: Spring `ProblemDetail` with properties added by `NotesException` / `VersionConflictException` | |
| `Task`, `TaskList`, `TaskSection`, `TaskRecurrence`, `TaskReminder`, `TaskFileProblem`, `TasksResponse`, `TaskListsResponse`, `TaskWriteResult`, `TaskListWriteResult`, `CompleteTaskRequest`, `ReorderTasksRequest`, `ReorderRequest`, `CreateTaskListRequest`, `SectionRequest` | Same | Enums `TaskStatus`, `TaskView` and `RecurrenceFrom` (for `TaskRecurrence.from`); `Task.priority` is an `int`. `CompleteTaskRequest.base` is a `JsonNode`. |
| `CreateTaskRequest`, `UpdateTaskRequest`, `UpdateTaskListRequest`, `TaskFields`, `TaskListFields` | `POST /api/tasks` takes a `JsonNode`; both `PATCH`es take the record `UpdateTaskRequest(JsonNode changes, JsonNode base)` | Kept as JSON trees, because an omitted field (unchanged) and `null` (cleared) differ |
| `TaskEvent`, `TaskDeletedEvent`, `ListChangedEvent` | Same names in `com.rjgehan.notes.events` | Content events: `origin` is serialized and drives echo suppression. `TaskEvent` covers `task.created` and `task.changed`. |
| `FlashcardConfig`, `FlashcardCardState`, `FlashcardCard`, `FlashcardsResponse`, `FlashcardReview`, `FlashcardReviewRequest`, `FlashcardUndoRequest`, `FlashcardPruneRequest`, `FlashcardConfigUpdateRequest`, `FlashcardWriteResult`, `FlashcardNote`, `FlashcardNotesResponse` | Same (§34) | `FlashcardCardState.phase` is the enum `FlashcardPhase`; `FlashcardConfigUpdateRequest.config` is a `JsonNode`, validated field by field; `FlashcardReview` and `FlashcardUndoRequest` take `at` as a string, parsed as an ISO-8601 instant |
| `HabitNote`, `DailyNoteValues`, `HabitsResponse` | Same (§35) | `HabitNote.properties` is a `Map<String, @Nullable Object>` (the frontmatter as parsed, §5.5.3 of DESIGN); `DailyNoteValues.values` holds `Boolean`, `Number` and `String` values only |
| `FlashcardsChangedEvent` | Same name in `com.rjgehan.notes.events` | An extension event (§34.7): it echoes `origin` like a content event, and `cards` maps removed records to `null` |
| `AiSettings` | Same name in `com.rjgehan.notes.settings` | `model` is a `String` checked against `AiSettings.MODELS` |
| `AiAskRequest`, `AiSummarizeRequest`, `AiTurn`, `AiPrompt`, `AiStatus`, `AiModelInfo`, `AiSource`, `AiStartEvent`, `AiDeltaEvent`, `AiRestartEvent`, `AiUsage`, `AiDoneEvent`, `AiErrorEvent` | Same | Every request component is `@Nullable` (the service validates and applies defaults). `AiStatus.state` is the enum `AiState` (`off`, `not-configured`, `over-budget`, `ready`). The stream events are written by `AiController` through an `SseEmitter`, not through `EventHub`. |

**Enums.** `FileKind`, `EntryType`, `OnConflict`, `LinkStyle` and `ChangeType` (in `api.dto`) serialize as the exact lower-case strings in §17, through `@JsonProperty` on each constant. Settings enums do the same with their string values.

**Nullability.** Every TypeScript `T | null` is a `@Nullable` component that is always serialized, including when null. An optional request field (`?`) is a `@Nullable` component; the server applies the documented default.

---

## 20. Tasks (ROADMAP item 4)

Structured tasks live in the vault as `.tasks` JSON files, one task list per file (DESIGN §5.20 has the format and the design). The server owns task operations: a client changes single fields of single tasks, and the server applies the change to the current file under the file's lock, so two devices that edit different tasks of one list never conflict. The files stay ordinary vault files: they appear in the tree, have history, go to the trash, and can be read and saved through §8 like any text file (the task API picks up such edits like any external edit).

Every mutating endpoint needs `X-Client-Id` and accepts an `Idempotency-Key` (§2).

### 20.1 Model

The types are in §17 (`Task`, `TaskList`, ...). Field rules:

| Field | Rule |
|---|---|
| `id` | A ULID made by the server (26 Crockford base-32 characters, time-ordered). Ids written by hand may be any 1 to 64 letters, digits, `-` or `_`. |
| `title` | 1 to 500 characters on one line, trimmed. `[[Note]]` links and `#tags` may be written inline. |
| `notes` | Markdown, at most 100,000 characters; blank becomes `null`. |
| `status` | `open`, `done` or `cancelled`. Done and cancelled tasks are *closed* and carry `completedAt`. |
| `priority` | `0` none, `1` low, `2` medium, `3` high. |
| `due`, `start` | `YYYY-MM-DD` (all day) or `YYYY-MM-DDTHH:mm`, both in the user's own time zone. `start` is the "do on" date. |
| `recurrence` | `{rrule, from}`: an RRULE (§20.6) and `due` (the default) or `completion`. |
| `reminders` | At most 20 `{at: YYYY-MM-DDTHH:mm}`, duplicates removed. Stored and validated; delivery comes with ROADMAP item 9. |
| `tags` | At most 50, without `#` (a leading `#` is dropped), each a valid tag (§15.6); duplicates ignoring case are removed. Views filter on these and on `#tags` written in the title. |
| `links` | At most 50 vault paths of related notes (they need not exist). |
| `parentId` | Another task of the same list. Subtasks are at most 3 levels deep, without cycles. |
| `sectionId` | A section of the same list (top-level tasks; a subtask sits under its parent). |
| `order` | A fractional-index key: keys compare as plain strings, and a key can always be made between two others, so moving one task changes only that task. The algorithm is that of the `fractional-indexing` package (the first key is `a0`, then `a1`, ...; between `a0` and `a1` comes `a0V`). Equal keys sort by `id`. |
| `archived` | `true` for a closed task that the nightly rollover moved into an archive file, `Tasks/Archive/<List> <YYYY>.tasks`, 90 days after it was completed. Archived tasks still appear in `completed` and `search`. |
| `createdAt`, `updatedAt`, `completedAt` | Set by the server; `null` only for tasks added by hand without them. |

**Lists.** A list is a file. `path` is the file, `order` its place among lists, and `archived` hides the list from Today, Upcoming and the all-lists view. `writable: false` means the file was written by a newer version of NotesApp: it is shown, but every change to it is refused with `409 malformed-file`.

**Problems.** The server never rewrites a file to repair it. Responses that list tasks carry `problems`: a whole file that cannot be used (`taskId: null`: not valid JSON, not a task file, larger than the text limit, written by a newer version, or a copy that repeats the list id of a file earlier in path order, whose tasks are then not shown) or a single task (an invalid `status`, `priority`, date or id is skipped; a smaller defect, such as a bad reminder, is reported while the rest of the task is shown). A task id that appears in two files is shown from the first file in path order. Every field the server does not know, and every task it cannot read, survives each write.

### 20.2 `GET /api/tasks`

| Parameter | Meaning |
|---|---|
| `view` | `today`, `upcoming`, `list` (default), `completed` or `search` |
| `list` | Only this list (`404 not-found` when there is no such list) |
| `tag` | Only tasks with this tag or a nested one (`home` matches `home/garden`), from `tags` or the title; a leading `#` is ignored; case-insensitive |
| `priority` | A comma-separated set, such as `2,3` |
| `status` | `all`, or a comma-separated set of `open`, `done`, `cancelled`. Default: `done,cancelled` for `completed`, every status for `search`, `open` otherwise. |
| `q` | The search words (`search`, required): every word must start a word of the title, the notes or a tag; case-, accent- and width-insensitive |
| `date` | The client's date, `YYYY-MM-DD` |
| `tz` | The client's IANA time zone, such as `Europe/Paris`, used for "today" when `date` is absent. `today` and `upcoming` need `date` or `tz`. |
| `days` | How many days `upcoming` covers, today included: 1 to 366, default 14 |
| `limit` | At most this many tasks for `completed` and `search`: 1 to 1000, default 200 |
| `before` | `completed` only: tasks completed before this instant (for paging, pass the last `completedAt` received; subtasks completed with their parent share its instant, so a page can end among them: the web client passes one millisecond after the last time and merges the tasks it sees twice) |

| View | Tasks | Order |
|---|---|---|
| `today` | Open tasks of lists that are not archived, whose `due` or `start` date is today or earlier (overdue included) | By `due` (else `start`; an all-day date before the times of its day), then priority (high first), list order, `order` |
| `upcoming` | Open tasks of lists that are not archived, whose `due` (else `start`) date is between today and today plus `days` minus one | As `today` |
| `list` | The tasks of `list` (archived or not), or of every list that is not archived; never archive files | By list order, then `order`; the client builds sections and subtasks from `sectionId` and `parentId` |
| `completed` | Closed tasks, archived ones included | `completedAt`, newest first |
| `search` | Matching tasks of every list and archive | Open first, then `updatedAt`, newest first |

`200 TasksResponse`; `total` counts every matching task, and `tasks` holds at most `limit` of them for `completed` and `search`.

```json
{
  "view": "today",
  "lists": [ { "id": "01JC4M2ZKD8R6V3W5Y7A9B1C0D", "name": "Home", "color": "#2f9e44", "icon": "house",
               "order": "a0", "archived": false, "sections": [], "path": "Tasks/Home.tasks", "writable": true } ],
  "tasks": [
    { "id": "01JC4M3A0QY1T9X2W4E6R8T0U2", "listId": "01JC4M2ZKD8R6V3W5Y7A9B1C0D", "sectionId": null,
      "parentId": null, "title": "Pay rent [[Apartment]]", "notes": null, "status": "open", "priority": 2,
      "due": "2026-10-16", "start": null, "recurrence": { "rrule": "FREQ=MONTHLY", "from": "due" },
      "reminders": [ { "at": "2026-10-16T09:00" } ], "tags": [ "bills" ], "links": [], "order": "a0",
      "createdAt": "2026-10-01T08:12:40.120Z", "updatedAt": "2026-10-01T08:12:40.120Z", "completedAt": null,
      "archived": false }
  ],
  "total": 1,
  "problems": []
}
```

| Errors |
|---|
| `400 bad-request` (an unknown view, a bad parameter, `today`/`upcoming` without `date` or `tz`, `search` without `q`), `404 not-found` (`list`) |

### 20.3 `GET /api/tasks/{id}`

`200 Task`, or `404 not-found`.

### 20.4 Changing tasks

Every change answers `TaskWriteResult`: the task after the change (`task`), other tasks it touched (`changed`: subtasks completed or moved with it, siblings renumbered), removed ids (`deleted`), the list files written (`files`, with `createdFolders`), and the lists the change created (`lists`: the Inbox, the first time a task goes there). The calling client applies `files` to its tree as it would `file.changed`, and `lists` as it would `list.changed`, because its own events are not echoed. A request that changes nothing (repeating a change already made) answers the current task with `files: []` and publishes nothing.

**`POST /api/tasks`** creates a task. The body is a `CreateTaskRequest`: the `TaskFields` to set (`title` is required) and `after`. Without `listId`, the task goes to its parent's list, or to the Inbox, `Tasks/Inbox.tasks`, which is created (first in the list order) the first time it is needed. Without `after` the task goes last among its siblings (same parent and, for a top-level task, same section); with `after: null` first; otherwise right after that sibling. `201 TaskWriteResult`.

**`PATCH /api/tasks/{id}`** sets the fields in `changes` (`null` clears an optional field). Versioning is **per field**: `base` holds the values the client last saw for the fields it changes. A field whose server value differs both from `base` and from the requested value was changed by someone else since: the answer is `409 task-conflict` with the server's `task` and the conflicting `fields`, and nothing is written. Fields that are already as requested are left alone, so two devices that change different fields of one task both succeed, and a retried `PATCH` is a no-op. Without `base` the change always applies.

```json
{ "changes": { "title": "Pay the rent", "due": null }, "base": { "title": "Pay rent", "due": "2026-11-01" } }
```

- `listId` moves the task, with its subtasks, to the end of the other list's top level (or under `parentId`, when given). The moved tasks lose their sections, which belong to the old list, unless `sectionId` names one of the new list.
- A new `parentId` (or `null`) puts the task last among its new siblings.
- `status` sets the status and `completedAt` without the effects of `complete`: `done` closes even a recurring task for good, and subtasks are not touched.
- An archived task keeps its `status`, `listId`, `parentId` and `sectionId` (`400 bad-request`; reopen it with `uncomplete` first).

**`POST /api/tasks/{id}/complete`** checks a task off. The optional body `CompleteTaskRequest` gives the client's `tz` or `date` (the completion day, for recurrence; UTC when both are absent) and the `base` `due` and `start` it saw.

- A **recurring** task rolls forward to its next occurrence (§20.6) and stays open: `due` (or `start`, when it has no `due`) becomes the next occurrence, the other date and every reminder move by the same number of days, `COUNT` decreases, and closed subtasks reopen for the next round. `rolledForward` is `true`.
- Otherwise, or after the last occurrence, the task becomes `done` with `completedAt`, and so do its open subtasks.
- Completing a closed task changes nothing. When `base` names a `due` or `start` that the task no longer has, that occurrence was already completed (a retry whose response was lost, or another device), and nothing changes either, so a recurring task is never rolled forward twice.

**`POST /api/tasks/{id}/uncomplete`** reopens a closed task: `status: "open"`, `completedAt` cleared; subtasks keep their status. An archived task moves back into its list with its archived subtasks (`404 not-found` when the list no longer exists).

**`POST /api/tasks/reorder`** places `ids` (tasks of `listId`, in this order) right after `after` (`null`: first) under `parentId` (`null`: top level) and, at the top level, in `sectionId`. This is also how a task moves to another section or parent (a Kanban move). Only the moved tasks get new order keys, unless the neighbours' keys are unusable (a hand edit), when the whole sibling sequence is renumbered and returned in `changed`. A drop where the tasks already are changes nothing. `after` must be a sibling in that place and not one of `ids` (`400`).

**`DELETE /api/tasks/{id}`** deletes the task and its subtasks; `deleted` lists their ids. Deleting a task that no longer exists is `404 not-found`, which a retrying client treats as done. The list file keeps its history, so a deleted task can be recovered from §14.

| Errors (all changes) |
|---|
| `400 bad-request` with `errors[]` (field names such as `changes.due` or `task.title`), `403 client-id-required` / `cross-origin` |
| `404 not-found` (the task, its list, or a section) |
| `409 task-conflict` (`PATCH`), `409 malformed-file` (`path`, `reason`: the list file cannot be used) |
| `413 too-large` (the list file would exceed its text limit), `503 busy` (locks, or the task kept moving between files) |

### 20.5 Lists and sections

| Endpoint | Meaning |
|---|---|
| `GET /api/tasks/lists` | `200 TaskListsResponse`: every usable list in order, and the problems |
| `POST /api/tasks/lists` | `{name, color?, icon?}`: a new list, last in the order, in `Tasks/<Name>.tasks`. The file name is the name made into a valid new name (`Q4: Plans/Ideas` gives `Q4- Plans-Ideas.tasks`), with ` 1`, ` 2`, ... when it is taken. `201 TaskListWriteResult`. |
| `PATCH /api/tasks/lists/{id}` | `UpdateTaskListRequest`: `name`, `color`, `icon` and `archived`, with the same per-field `base` check as tasks (`409 task-conflict` carries `list`). A new name also renames the file in its folder (through §10.3, so links to it follow); `moved` gives the old and new paths. The links rewritten in other notes are not listed, and their `file.changed` events are not sent to the calling client: it fetches the tree again (§7) before its open notes save. |
| `DELETE /api/tasks/lists/{id}` | Moves the list's file to the trash (§13), from where it can be restored with its tasks; `trash` is the entry. Its archive files stay. |
| `POST /api/tasks/lists/reorder` | `ReorderRequest {ids, after}`: like task reordering, over the lists |
| `POST /api/tasks/lists/{id}/sections` | `{name}`: a new section, last (at most 100). `201`. |
| `PATCH /api/tasks/lists/{id}/sections/{sectionId}` | `{name}`: renames a section |
| `DELETE /api/tasks/lists/{id}/sections/{sectionId}` | Deletes a section; its tasks stay, without a section (`task.changed` for each) |
| `POST /api/tasks/lists/{id}/sections/reorder` | `ReorderRequest {ids, after}`: reorders sections |

Names are 1 to 200 characters on one line, trimmed. `color` is `#rrggbb` or a lower-case color name; `icon` is a lucide icon name (`shopping-cart`). Each answers `TaskListWriteResult` with the lists after the change.

### 20.6 Recurrence

`rrule` is an RFC 5545 `RRULE` value, stored upper case and without an `RRULE:` prefix (one is accepted and removed). The supported subset:

- `FREQ` of `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY` (required);
- `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS`, `WKST`, `BYHOUR`, `BYMINUTE` (hours and minutes apply only to a task with a time);
- `COUNT` or `UNTIL` (not both). `COUNT` is the number of occurrences left, including the current one: each roll-forward decreases it, and completing the last one closes the task. `UNTIL` (`YYYYMMDD` or `YYYYMMDDTHHMMSSZ`) is compared by date.

Rules are evaluated on local dates and times, so daylight-saving changes never shift a task. A rule that never produces an occurrence (`FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30`) is refused with `400`.

| `from` | The next occurrence is |
|---|---|
| `due` | The first occurrence after the task's `due` (else `start`) date that also falls after the completion day. Completing an overdue task therefore skips the occurrences already missed: a weekly Wednesday task three weeks late moves to the next Wednesday. |
| `completion` | The first occurrence after the completion day, at the task's time if it has one: `FREQ=DAILY;INTERVAL=3` means "three days after I last did it". |

Examples, completed on Wednesday 2026-10-14: `FREQ=WEEKLY` from `due` `2026-10-14T08:00` gives `2026-10-21T08:00`; `FREQ=MONTHLY;BYMONTHDAY=-1` from `due` `2026-09-30` gives `2026-10-31`; `FREQ=MONTHLY` from `due` `2026-01-31` skips months without a 31st, as RFC 5545 says.

### 20.7 Archive rollover

Every night (`notes.tasks.archive-cron`, 03:20), tasks closed more than 90 days ago (`notes.tasks.archive-after`) move from their list into `Tasks/Archive/<List file name> <YYYY>.tasks`, by the year they were completed (UTC), so active lists stay small. A task moves only with its whole subtree and only when its parent moves too. An archive file has `"archive": true` and its list's `id` and `name`; it is not a list, and its tasks have `archived: true`. The rollover publishes `list.changed` for each list it changed, with `origin: null`.

### 20.8 Events

| `event:` | `data` | When |
|---|---|---|
| `task.created` | `TaskEvent {task, origin}` | `POST /api/tasks` |
| `task.changed` | `TaskEvent {task, origin}` | Any other change to a task through this API, one event per task touched (moves, completions, reorders, subtasks that followed) |
| `task.deleted` | `TaskDeletedEvent {id, listId, origin}` | `DELETE /api/tasks/{id}`, one event per task removed |
| `list.changed` | `ListChangedEvent {listId, list, origin}` | A list was created, changed (name, color, icon, archived, order, sections) or deleted (`list: null`), or the archive rollover moved its tasks |

- They are content events: not delivered to the client whose `X-Client-Id` made the change (§16.4), and replayed like any other event.
- One task operation publishes, in this order: `folder.created` and `file.created` or `file.changed` for each list file written, then the task events, then (later, with the batch) `history.committed`.
- **Changes made outside the task API** (a hand edit over SSH or in Obsidian, a save through §8, a history restore, a trash restore, a move, or a deleted file) produce only the usual `file.*`, `entry.moved` and `folder.deleted` events. A client showing tasks therefore refetches its task views (debounced, about one second) on any of those events that touches a `.tasks` path; on other devices a task operation is then applied twice, once from the task event and once by the refetch, which is harmless. (The web client compares the versions of the `.tasks` files in its tree, which those events and its own saves of a list file as text both update; DESIGN §6.22.)
- The tasks feature registers these names (`TASK_EVENT_NAMES`) with `registerEventHandler` (DESIGN §6.8), and refetches its views after `hello {resync: true}` and `resync`.

### 20.9 Tasks in search, backlinks and tags

`.tasks` files are indexed documents (§1.8), indexed through the `DocumentIndexer` extension point (DESIGN §6.8): the list's name and each task's title, tags, related notes and notes become searchable text, and the links and tags in it count like a note's.

- A `[[Note]]` (or Markdown link) in a task's title or notes, and each path in `links`, make the list file a backlink source of that note (§11.2). `#tags` in titles and notes and the entries of `tags` count in `GET /api/tags` and `tag:` search.
- `GET /api/search` can return a list file; its `matches` are lines of task text.
- A list file is not a note: `GET /api/notes/meta` answers `409 type-mismatch`, it never appears in unlinked mentions, and it does not count in `/api/status` `vault.notes`.
- Renaming or moving a note rewrites the links to it in task files as in notes: `[[links]]` and Markdown links in titles and notes are rewritten by the rules of §10.3, and each path in `links` becomes the file's new path. A task changed this way gets a new `updatedAt`; the file is listed in `MoveResult.linkUpdates` (with the number of links) and announced with `file.changed`, not task events, so clients refetch their task views (§20.8). A list file the task API would not write (not valid, or from a newer version), or a title the new link would make longer than 500 characters, is left as it is and reported in `failed` with `not-rewritable`; its links can be fixed by editing the task.

**Tasks in notes** (conventions of the clients; the server treats these as ordinary links and embeds):

- **A link to one task** is a link to its list's file with the task's id as an Obsidian block reference: `[[Inbox.tasks#^01JC4M3A0QY1T9X2W4E6R8T0U2|Pay rent]]` (or `[Pay rent](Tasks/Inbox.tasks#%5E01JC4M3A0QY1T9X2W4E6R8T0U2)`). It makes the note a backlink source of the list file, follows the file when the list is renamed (§10.3), and stays a link to the file in Obsidian. The web client opens the task by its id (§20.3), so the link keeps working after the task moved to another list. **Convert checkbox to task** writes such a link in place of the `- [ ]` line it turned into a task: it creates the task with `POST /api/tasks` without a list (so in the Inbox, created when needed) and edits the note only afterwards, through §8 like any edit.
- **An embedded list** is `![[Home.tasks]]`: the web client shows the list there, live, and checking a task completes it through §20.4. `![[Home.tasks#Errands]]` shows one section (by name, case-insensitive) and `![[Home.tasks#^<task id>]]` one task with its subtasks.

---

## 21. Bookmarks (ROADMAP item 12)

Bookmarks are stored in `.notesapp/bookmarks.json`, in the format of Obsidian's `.obsidian/bookmarks.json` (`{"items": [...]}`), so a list can be copied between the two apps. They sync like the settings: a version token, the conflict protocol of §4, and a `bookmarks.changed` event. DESIGN §5.21 has the server's side and §6.23 the client's. Recent files are not part of the API: they are kept per device by the client.

### 21.1 `GET /api/bookmarks`

`200 BookmarksResponse`:

```json
{
  "version": "3f1c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e",
  "items": [
    { "type": "file", "ctime": 1760616202120, "path": "Projects/Plan.md" },
    { "type": "file", "ctime": 1760616230411, "path": "Projects/Plan.md", "subpath": "#Goals" },
    { "type": "folder", "ctime": 1760616251002, "path": "Projects" },
    { "type": "search", "ctime": 1760616270930, "query": "tag:#work -path:Archive" },
    { "type": "group", "ctime": 1760616290000, "title": "Reading",
      "items": [ { "type": "file", "ctime": 1760616301234, "path": "Books/Dune.md", "title": "Dune (reread)" } ] }
  ]
}
```

| `type` | Fields | Meaning |
|---|---|---|
| `file` | `path` (required), `subpath`, `title` | A file of any kind; with `subpath` (`#Heading`, or `#^blockid`) a part of a note |
| `folder` | `path` (required), `title` | A folder; opening it reveals it in the explorer |
| `search` | `query` (required), `title` | A search (§12.1 syntax) |
| `group` | `title`, `items` (required) | A named, nestable list of bookmarks |
| anything else | kept as it is | Obsidian's `url` and `graph` bookmarks, or a type from a newer build |

- Every item may have `ctime` (when it was bookmarked, epoch milliseconds, which Obsidian writes) and `title` (a display name; without one, the client shows the target's name, the heading, or the query).
- Items are **passed through** in Obsidian's shape: a field that does not apply is absent, not `null`, and fields this build does not know are kept, at the item and at the top level of the file.
- Without the file, the response lists the bookmarks of `.obsidian/bookmarks.json` when Obsidian left one (it is only ever read), or none. `version` is then the blob id of the document NotesApp would write, so a `PUT` with it creates the file.
- Items in the file that break the rules of §21.2 (a hand edit) are left out of the response and logged, so a client never receives an item it could not send back. A file that is not JSON at all reads as no bookmarks; the next save keeps it beside the new one as `bookmarks.json.bak-<timestamp>`.
- The file is read on every request, so a hand edit or a pull is seen at once.

### 21.2 `PUT /api/bookmarks`

Request `BookmarksUpdateRequest`: `{"items": [ ...the whole list... ], "baseVersion": "<version from GET>"}`.

| Status | Body |
|---|---|
| `200` | `BookmarksResponse` with the new version. Other clients get `bookmarks.changed` with this client as `origin`. Saving a list equal to the stored one writes nothing and sends no event, whatever `baseVersion` says. |
| `400 bad-request` | `errors[]`, with fields such as `items[2].path` or `items[4].items[0].query` |
| `409 version-conflict` | `currentVersion`, and `currentContent` (the file's JSON) |

**Validation.**

| Field | Rule |
|---|---|
| `items` | Required; a list of objects; at most 5,000 bookmarks in all, groups nested at most 8 deep |
| `type` | Required; 1 to 64 characters |
| `ctime` | Optional; a non-negative integer |
| `title` | Optional; text of at most 1,024 characters |
| `path` (`file`, `folder`) | Required; a vault path that passes the safety rules (§1.3); it need not exist. NFC-normalized. |
| `subpath` (`file`) | Optional; starts with `#`; at most 1,024 characters |
| `query` (`search`) | Required; 1 to 1,024 characters, not blank |
| `items` (`group`) | Required; a list, checked with the same rules |
| `baseVersion` | Required |

Clients apply each change to the latest list: on a `409` they fetch the bookmarks again, apply the same change, and retry, so two devices bookmarking different notes never lose either (DESIGN §6.23).

### 21.3 Bookmarks follow their targets

| What happens to the target | Bookmarks |
|---|---|
| Moved or renamed through the app (§10.3) | Re-keyed, like links: a file's bookmarks (headings included) follow it; a folder's bookmark and every bookmark under the folder follow it. Paths match ignoring case, as link resolution does, unless an entry with the bookmark's exact path still exists. One `bookmarks.changed` with `origin: null` follows the move's other content events. |
| Moved to the trash | Kept. The client shows them as missing (their target is not in the tree), with a Remove action. Restoring the entry to its original path brings them back as they were. |
| Restored to another path (`to`, or a free name) | Bookmarks of the original path follow it when nothing else has taken that path, with `bookmarks.changed` (`origin: null`). |
| Moved, renamed or deleted outside the app (watcher) | Unchanged, as links are (DESIGN §5.9). They show as missing until the target comes back. |

The file is committed with the normal batch, like the settings (`Update .notesapp/bookmarks.json`).

---

## 22. Heading links after a heading is renamed (ROADMAP item 21)

### `POST /api/notes/rename-heading`

Request `HeadingRenameRequest`: `{"path": "Projects/Plan.md", "from": "Goals", "to": "Aims for 2026", "dryRun": false}`.

The client renames the heading in the note and **saves the note first**; the server then rewrites every link in the vault that resolves to `path` and names `from` in a `#` segment of its subpath, so `[[Plan#Goals]]`, `[[Plan#Goals|our goals]]`, `![[Plan#Goals]]`, `[[Plan#Plan#Goals]]`, `[x](Plan.md#Goals)`, `[x](<Plan.md#Goals>)` and same-note `[[#Goals]]` all follow. Headings compare as heading targets do: case-insensitively, with whitespace collapsed. Only the subpath is rewritten; the target, the display text, the style and the embed mark are kept. In a plain markdown destination the new heading is percent-encoded like a path (`Aims%20for%202026`). Heading bookmarks of the note (§21) follow too.

`200 HeadingRenameResult`:

```json
{
  "dryRun": false,
  "path": "Projects/Plan.md",
  "from": "Goals",
  "to": "Aims for 2026",
  "linkUpdates": [ { "path": "Welcome.md", "links": 2, "version": "0b9e8d7c6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c" } ],
  "failed": [ { "path": "Notes/Odd.md", "reason": "not-rewritable" } ],
  "bookmarks": 1,
  "commitId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"
}
```

| Field | Meaning |
|---|---|
| `dryRun` | `true` computes the answer without writing (the client's offer, DESIGN §6.24): `version` is `null` and `commitId` is `null` |
| `linkUpdates` | Notes, and indexed documents (§1.8), whose links were (would be) rewritten, with the number of links and the new version. **The calling client applies these itself**, as for a move (§10.3). |
| `failed` | As for a move: `not-utf8`, `not-rewritable` (a frontmatter link that cannot be spliced, a document whose links the server cannot write back (§1.8), such as an `.excalidraw` drawing or a link only an `.excalidraw.md` drawing's JSON holds, or a new heading the link's syntax cannot hold: `\|`, `#`, `[`, `]` in a wikilink, `<`, `>`, `#` in angle brackets), `span-mismatch`, `io-error` |
| `bookmarks` | Heading bookmarks of the note that were (would be) updated |
| `commitId` | The commit of the rewritten notes (`Update links after renaming heading “Goals” → “Aims for 2026” in Projects/Plan.md (1 note)`), or `null` |

| Errors |
|---|
| `400 bad-request`: `path`, `from` or `to` missing; a heading over 1,024 characters or not one line; `to` equal to `from` ignoring case and spacing; the note has no heading `to`, or still has a heading `from` (`errors[]` names the field) |
| `400 invalid-path`, `403 reserved-path`, `404 not-found` |
| `409 type-mismatch` (`expected: "note"`) for a file that is not a note |

Events to other clients: `file.changed` for each rewritten note, then `bookmarks.changed` (`origin: null`) when heading bookmarks changed, then `history.committed`.

---

## 23. Voice notes (ROADMAP items 32 and 33)

Recording happens in the browser; the recording is uploaded like any attachment (§9.3) and embedded in the note by the client (DESIGN §6.30). Transcription (ROADMAP item 33) is optional: the server forwards a recording to the speech-to-text service it is configured with (`notes.transcription.*`, DESIGN §5.24) and returns the text, which the client adds to the note under the recording's embed. The server writes nothing and keeps no audio or text beyond a small in-memory cache.

### 23.1 `GET /api/transcription`

Whether transcription is available. Side-effect free.

```json
{ "enabled": true, "service": "whisper-asr at http://notesapp-whisper:9000", "language": null, "maxBytes": 26214400 }
```

| Field | Meaning |
|---|---|
| `enabled` | False while `notes.transcription.url` (`NOTES_TRANSCRIPTION_URL`) is empty, the default |
| `service` | The protocol and the service's scheme, host and port; never credentials, a path or a query. `null` when off |
| `language` | The configured language (`NOTES_TRANSCRIPTION_LANGUAGE`); `null` when the service detects it per recording |
| `maxBytes` | Recordings larger than this are not sent (`notes.transcription.max-size`, 25 MiB) |

### 23.2 `POST /api/transcriptions`

Transcribes a recording in the vault. The request can take minutes (the service's time, up to `notes.transcription.timeout`, 10 minutes, plus waiting for other recordings: one is transcribed at a time). It needs `X-Client-Id` like every non-GET request (§2); it changes nothing, so it takes no `Idempotency-Key`.

```json
{ "path": "Attachments/Recording 20261021143005.m4a" }
```

`200 TranscriptionResult`:

```json
{ "path": "Attachments/Recording 20261021143005.m4a", "text": "Call the plumber about the leak.", "language": "en", "millis": 4210 }
```

- `text` is trimmed; `""` when no speech was recognized.
- `language` is the service's detected (or the configured) language, when it reports one.
- A second request for the same version of a file (same path, size and mtime) while the first runs waits for it; a later one is answered from the server's memory of the last 32 transcripts with `millis: 0`. A changed file is transcribed again.
- The service gets the bytes as `recording.<ext>`, never the vault's file name.

| Errors |
|---|
| `400 bad-request` (missing or blank `path`), `400 invalid-path`, `403 reserved-path` |
| `404 not-found` |
| `409 transcription-off` |
| `413 too-large` (`limit`: `maxBytes`) |
| `415 not-audio` (`path`): only `audio` and `video` kinds (DESIGN §4.2) |
| `503 transcription-failed`: `detail` says why, e.g. `The transcription service failed: cannot connect to http://notesapp-whisper:9000`, `… the service answered HTTP 500 (Model base could not be loaded)` or `… no answer within 600 s` |

No events: the client's edit of the note is an ordinary save (§8.3).

---

## 24. Ask your vault and summaries (ROADMAP item 18)

Questions about the vault answered by Claude with citations, summaries of a note, a folder, some notes or a selection, and suggested links, tags and tasks for a note (DESIGN §5.25, §6.21). **Off by default**: nothing is sent to Anthropic until `settings.ai.enabled` is on, the server has the provider's credential, and a request asks. Two providers (`settings.ai.provider`): `claude-code` (default) runs the server's Claude Code CLI headless with the user's Claude subscription (an OAuth token from `claude setup-token`), every tool disabled; `api` calls the Anthropic Messages API with an API key, billed per token. The wire contract is the same for both. Notes under `settings.ai.excludedPaths` or `settings.files.excludedPaths` are never read. The server keeps no conversation: each device keeps its own and sends the earlier turns back as `history`.

Every request is checked, and its prompt built, before the response starts, so a refusal is an ordinary problem document (§3), also for a client that sent `Accept: text/event-stream`:

| Problem | When |
|---|---|
| `409 ai-unavailable` | `reason: "off"` (switched off in Settings) or `"not-configured"` (no Claude Code CLI, no usable token or key; `detail` says why, never quoting the credential) |
| `429 ai-budget-exceeded` | This month's estimated spend reached `settings.ai.monthlyBudgetUsd`; `limit` and `spent` in USD |
| `403 ai-excluded` | The note, folder or selection's note named by the request is excluded |
| `400 bad-request` | A field out of range (below) |
| `404 not-found`, `409 type-mismatch` | The note or folder does not exist, or is not a note |

### 24.1 Conversations and `history`

A turn is what was asked (`AiPrompt`: `action` `ask` with `question`, or `summarize`/`suggest` with the fields of §24.3), the answer as streamed, and `sources`, the paths `start` reported for it (§24.5). A follow-up sends the conversation's answered turns, oldest first (at most 50; the server uses the last 12). The server rebuilds each earlier turn from its prompt and its sources **as the notes are now**, skipping notes that were deleted or are now excluded, with the same rules as the first time: while the notes are unchanged, the earlier turns are byte for byte what was sent before, and the request's prefix comes from Anthropic's prompt cache. Notes already sent in the conversation are not sent again with a new question. When the conversation outgrows `settings.ai.maxContextChars`, the oldest turns lose their notes (their question and answer stay).

### 24.2 `POST /api/ai/ask`

Request `AiAskRequest`:

```json
{ "question": "What did we decide about the kitchen budget?", "activePath": "Projects/Kitchen.md",
  "history": [ { "prompt": { "action": "ask", "question": "When do the tiles arrive?" },
                 "answer": "On Monday [[Projects/Kitchen]].", "sources": ["Projects/Kitchen.md"] } ] }
```

| Field | Rule |
|---|---|
| `question` | 1 to 4,000 characters after trimming |
| `activePath` | Optional: the open note, sent first when it is a note and not excluded |
| `history` | Optional, §24.1 |

**Retrieval.** The question's words (normalized like the search index, without common English words) select the notes that contain **any** of them, ranked with the index's BM25 (DESIGN §5.5.10; embeddings may come later). Up to 8 notes go with the question, the best first, each at most a quarter of `maxContextChars` (2,000 to 20,000 characters): a longer note is cut to its paragraphs with the most matches, marked `[…]`. Notes that do not fit are counted as `omitted`; excluded notes that matched are counted as `excluded` and never read.

The answer cites notes as wikilinks to their path without `.md` (`[[Projects/Kitchen]]`), which the client resolves like any link.

`200 text/event-stream` (§24.5).

### 24.3 `POST /api/ai/summarize`

Request `AiSummarizeRequest`:

| Field | Rule |
|---|---|
| `action` | `summarize` (default) or `suggest`: links to existing notes (chosen from related notes, titles only), tags (preferring the vault's tags) and tasks (`- [ ]` items) for a note |
| `scope` | `note` (`path`), `folder` (`path`, its notes at any depth, newest first), `notes` (`paths`, at most 100, for example this week's daily notes, with a `label` of at most 200 characters) or `selection` (`text`, at most 200,000 characters, from the note at `path`). `suggest` takes `note` only. |
| `history` | Optional, §24.1: a summary can be followed by questions |

A note summary sends the note up to `maxContextChars` (its beginning, marked truncated, when longer). A folder or list sends up to 60 notes, each at least 1,500 characters and together at most `maxContextChars`; the rest are counted as `omitted` and the answer says so. A selection is sent as it is, no note is read; `path` only names it, and must not be excluded.

`200 text/event-stream` (§24.5).

### 24.4 `GET /api/ai/status`

`200 AiStatus`:

```json
{ "state": "ready", "reason": null, "provider": "claude-code", "model": "claude-sonnet-5-5",
  "models": [ { "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "inputUsdPerMTok": 2.0, "outputUsdPerMTok": 10.0 } ],
  "keyFile": "claude-token", "keyPresent": true, "cliInstalled": true, "month": "2026-10", "monthCostUsd": 0.4213, "monthRequests": 37,
  "monthlyBudgetUsd": 5.0, "maxContextChars": 60000, "fake": false }
```

| Field | Values |
|---|---|
| `state` | `off` (switched off in Settings), `not-configured` (no usable key; `reason` says why), `over-budget` (`reason` names the budget), `ready` |
| `provider` | `claude-code` or `api`, from Settings |
| `keyFile`, `keyPresent`, `cliInstalled` | The selected provider's credential file (`claude-token` or `anthropic-key`) and whether it holds one, never its content; whether the Claude Code CLI is on the server |
| `month`, `monthCostUsd`, `monthRequests` | The calendar month in the server's time zone, its estimated spend and its request count. The spend is what the API bills (list prices of the models that answered) or, with Claude Code, the API value Claude Code reports (`total_cost_usd`): the subscription is not charged per request |
| `fake` | `true` on a development server started with `notes.ai.fake=true`, which answers with canned text and never runs Claude Code or calls Anthropic |

### 24.5 The answer stream

The response to §24.2 and §24.3 is `text/event-stream` with `Cache-Control: no-store`, read from the `fetch` body (`EventSource` cannot `POST`). Events, in order:

| `event:` | `data` | Meaning |
|---|---|---|
| `start` | `AiStartEvent` `{model, sources, omitted, excluded}` | The model asked and the notes sent with this turn (`{path, chars, truncated}`): the device keeps the paths as the turn's `sources` |
| `delta` | `AiDeltaEvent` `{text}` | The next piece of the answer (Markdown) |
| `restart` | `AiRestartEvent` `{model}` | The model declined part way and `model`, the server-side fallback, answers from the start: discard the text so far |
| `done` | `AiDoneEvent` | The end: `stopReason` (`end_turn`, `max_tokens`, `refusal`, …), `refusalCategory`, `fellBack`, `usage` (tokens, cache reads and writes), `costUsd` and `monthCostUsd` (estimated) |
| `error` | `AiErrorEvent` `{code, message}` | The end, after a failure: `auth` (the token or key was refused), `rate-limited` (also a subscription's usage limit), `overloaded`, `bad-request`, `unavailable` (network, timeout), `busy` (two answers are already being written), `internal-error`. `message` never contains the key or note text. |

A stream that ends without `done` or `error` was cut off. Closing the connection (Stop) stops the answer on the server too; what was generated until then is still counted in the month's spend, estimated at four characters per token.

---

## 34. Flashcards (ROADMAP item 34)

Sections 34 and 35 are numbered after their ROADMAP items, so branches built in parallel do not collide. Cards live in notes, in the Obsidian Spaced Repetition plugin's syntax, and are parsed and scheduled (FSRS) by the client (DESIGN §6.34). The server stores what notes do not hold: each card's answers and a cached FSRS state, plus the flashcard settings, in `.notesapp/srs.json` (DESIGN §5.34).

### 34.1 Review records

A card is identified by a string of 1 to 64 characters from `[A-Za-z0-9_-]` that the client derives from the card's question (DESIGN §6.34). Its record (`FlashcardCard`):

| Field | Meaning |
|---|---|
| `reviews` | The answers, oldest first, as `"<instant> <rating>[ <ms>]"`: the time in §1.5 form, `again`, `hard`, `good`, `easy` or `reset`, and optionally how long the answer took in milliseconds (0 to 86,400,000). **The answers are a set keyed by their instant**: an answer with an instant already present is a duplicate and is ignored. |
| `state` | The FSRS state after the first `n` answers, as the answering client computed it (`FlashcardCardState`). It is a cache: the server keeps it only while `n` equals the number of answers and `lastReview` is the instant of the last one, and otherwise stores `null`. Clients use a current state as is and replay the answers otherwise. |
| `note`, `front` | Hints from the last answer: the note the card was in, and the start of its question on one line (at most 200 characters). Clients use them to keep the record of a card whose question was edited (§34.4 `from`). |

### 34.2 `GET /api/flashcards/notes`

The notes that may hold cards, with their text: `{config, notes: [{path, version, content}]}`, sorted by path.

- With tags (the default), every note with one of `config.tags` or a tag nested under one (`#flashcards/spanish`), inline or in the frontmatter.
- With `config.foldersAsDecks`, every note whose text contains `::`, `==`, or a line that is only `?` or `??`.
- Drawings (`.excalidraw.md`) are left out. `content` is the indexed text, which is `TextFile.content` (§8.1).

### 34.3 `GET /api/flashcards`

`FlashcardsResponse`: the effective settings (every field, with defaults filled in), every record by card id, and `version`, the blob id of `srs.json` (`null` before the first write).

| Setting | Default | Range |
|---|---|---|
| `tags` | `["flashcards"]` | 1 to 20 tags without spaces; a leading `#` is dropped |
| `foldersAsDecks` | `false` | |
| `newPerDay` | 20 | 0 to 9,999 |
| `reviewsPerDay` | 200 | 0 to 99,999 |
| `retention` | 0.9 | 0.7 to 0.99 |
| `maximumInterval` | 36,500 days | 1 to 36,500 |
| `learningSteps` | `["1m", "10m"]` | at most 10 of `<number><m\|h\|d>` |
| `relearningSteps` | `["10m"]` | as above |
| `fuzz` | `true` | |
| `dayStartsAt` | 4 | local hour, 0 to 23 |

### 34.4 `POST /api/flashcards/reviews`

`{reviews: FlashcardReview[]}` with 1 to 1,000 answers, applied in order under one lock. Answers in the same request may be for different cards. For each answer:

1. With `from` (the card's previous id) naming another record, that record's answers are united with this card's record and the old record is removed (it appears as `null` in the result).
2. The answer is added unless its instant is already there (a retried request changes nothing).
3. `note` and `front` replace the hints when given (`front` is collapsed to one line and cut to 200 characters).
4. `state` is stored when it covers every answer of the record after step 2; otherwise the state already stored is kept if it still does, else the record's state becomes `null`. Two devices answering the same card at once therefore both keep their answer, and the card's state is recomputed by the next client that reads it.

Answer: `FlashcardWriteResult`, the records this request changed and the file's new `version`. Errors: `400 bad-request` with `errors[]` naming every invalid field (`reviews[i].card`, `.at`, `.rating`, `.ms`, `.note`, `.from`, `.state`); an `at` more than 24 hours ahead of the server's clock is refused.

### 34.5 `POST /api/flashcards/undo` and `POST /api/flashcards/prune`

- **Undo** `{card, at, state?}` removes the answer at `at` (a missing answer is not an error). `state` is the card's state before that answer and is stored when it covers the remaining answers. A record left without answers is removed (`null` in the result).
- **Prune** `{cards: string[]}` (1 to 10,000 ids) removes those records; ids without a record are ignored. Clients prune the records of cards that are in no note (DESIGN §6.34); the removed history stays in the vault's git history.

### 34.6 `PUT /api/flashcards/config`

`{config: {...}}` with the settings to change. Fields that are absent keep their value, so two devices changing different settings never overwrite each other; `null` resets a field to its default; unknown fields are ignored. Answer: the effective `FlashcardConfig`. Errors: `400 bad-request` with `errors[]` (`config.<field>`).

### 34.7 `flashcards.changed`

Published after every write that changed the file, before the lock is released, and not delivered to the connection whose client made the change (like a content event, §16.4):

```json
{"cards":{"c3k9…":{"note":"Spanish.md","front":"hola","state":null,"reviews":["2026-10-21T16:57:47.431Z easy"]}},"config":null,"version":"f8f79e…","origin":"c-9a8b7c6d5e4f"}
```

`cards` lists the changed records (`null` for a removed one); with more than 20 it is `null` and clients refetch §34.3. `config` is set when the settings changed.

---

## 35. Habits (ROADMAP item 35)

Habits are notes, and check-ins are edits of notes through the text API (§8.3): there is no habit store. A **habit** is a note in the `Habits` folder (at any depth, matched ignoring case) or a note anywhere with the tag `#habit` (nested tags included). Notes under the templates folder are not habits. Its frontmatter is the shape of Obsidian's Habit Tracker 21 plugin, plus a schedule (DESIGN §6.35):

```yaml
---
title: Morning workout      # optional; the note's name otherwise
color: "#4CAF50"            # optional
schedule: mon, wed, fri     # daily (default), weekdays, weekends, days, or "3/week"
property: exercise          # the daily-note property that checks it in (default: the name, lower case, dashes for spaces)
maxGap: 1                   # missed days a streak survives
created: 2026-10-21
archived: true              # optional: kept, but not listed
entries:                    # the days it was done
  - 2026-10-20
---
```

A **daily note** (a note in the daily-notes folder whose name parses with the daily-note format, §15.2) checks a habit in with the habit's property: `exercise: true`, or `yes`, `y`, `done`, `x`, `✓`, `✔`, `✅`, or a number above 0. A day is done when either source says so.

### 35.1 `GET /api/habits`

`HabitsResponse`, in one request whatever the number of daily notes:

| Field | Meaning |
|---|---|
| `folder` | Where new habits go: the `Habits` folder as it is in the vault, else `Habits` |
| `tag` | `habit` |
| `habits` | Every habit note, sorted by path, with its `version` and its frontmatter as parsed (YAML 1.2 core schema, so dates are strings); `{}` without frontmatter |
| `dailyFolder` | The daily-notes folder (`settings.dailyNotes.folder`), as it is in the vault |
| `daily` | Every note at any depth under `dailyFolder` (habit notes excepted) with at least one frontmatter value that is a boolean, a number, or a string of at most 100 characters, under a key of at most 64; only those values are listed. The client maps paths to days with the daily-note format. |

**Writes.** A check-in adds or removes the day in the habit note's `entries`; undoing a day that a daily note checked sets that note's property to `false`. Clients edit only those properties' lines (`PUT /api/files` with `baseVersion`, re-applying the edit after a `409 version-conflict`), so the rest of each note stays byte for byte. New habits are `POST /api/files` in `folder`. Other devices learn of them through the usual `file.*` events (§16.4).
