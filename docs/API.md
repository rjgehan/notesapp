# NotesApp REST and SSE API: v1 contract

| | |
|---|---|
| Status | **Binding.** WP-Backend and WP-Frontend implement this independently and in parallel. |
| Date | 2026-10-16 (revision 2, matching DESIGN.md revision 2; integration amendments in §6.3, §11.3, §14.4, §15.1 and §17, agreed by both sides). Roadmap amendments, 2026-10-17: drawings (item 5) in §10.3, §11.2, §12.1 and §12.2. 2026-10-21: Ask your vault and summaries (item 18) in §3, §5, §17, §18, §19 and the new §20. |
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

---

## 2. Common headers and CSRF rules

| Header | Requests | Rule |
|---|---|---|
| `X-Client-Id` | **Required** on every `POST`, `PUT`, `PATCH` and `DELETE` under `/api`. The client sends it on *every* request. | Must match `^[A-Za-z0-9-]{8,64}$`. A missing or malformed value gets `403 client-id-required`. One value per page load, for example `crypto.randomUUID()`. The server uses it as the `origin` of the events your writes cause, and does not echo those events back to you (§16.4). |
| `Origin` | Sent automatically by browsers | On mutating requests, if present, its host:port must equal the `Host` header, compared case-insensitively. `Origin: null` is rejected. Failure gets `403 cross-origin`. |
| `Sec-Fetch-Site` | Sent automatically by browsers | On mutating requests, if present, it must be `same-origin` or `none`. Anything else gets `403 cross-origin`. |
| `Accept` | Optional | `application/json`, or `text/event-stream` for §16 |
| `Idempotency-Key` | Optional on `POST /api/files`, `PUT /api/files/raw` and `POST /api/attachments` | Any string of 8 to 64 characters from `[A-Za-z0-9-]`, unique per logical operation (for example `crypto.randomUUID()` generated once and reused for every retry). The server keeps a per-boot cache of 1,000 keys for 1 hour; a request whose key, method and path match an earlier one gets the **stored status and body** of the first result, and nothing is done again. Without it, a retried "New note" whose response was lost would create `Untitled 1.md`. |
| `Host` | Sent by every client | Must match the server's allowlist (`notes.<tailnet>.ts.net` in production). Otherwise `421 unknown-host`. |
| `Tailscale-User-*` | Set by `tailscale serve` in production | Identity (§6.1). A request without an allowed `Tailscale-User-Login` gets `403 identity-not-allowed` (DESIGN §5.13). Clients never send them. |

**Response headers** on every response: `X-Notes-Build: <buildSha>`. Every `/api/**` JSON response carries `Cache-Control: no-store`; the raw-file endpoints (§9.1, §13.2, §14.3) and `/api/events` set their own.

- **Every `GET` is side-effect free.**
- `POST /api/links/resolve` is a read-only `POST`, but it still needs `X-Client-Id`.
- `GET` requests, including `<img src>` and `EventSource`, need no custom headers.
- The health endpoints (§6.3) are exempt from the Host and identity checks.

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
| `ai-unavailable` | 409 | Ask and summaries are unavailable | §20: switched off in Settings, or the server has no usable Anthropic API key | `reason`: `"off"` or `"not-configured"` |
| `ai-excluded` | 403 | Excluded from Ask and summaries | §20: the note, folder or selection named is under `settings.ai.excludedPaths` or `settings.files.excludedPaths` | `path` |
| `ai-budget-exceeded` | 429 | Monthly AI budget reached | §20: this month's estimated spend reached `settings.ai.monthlyBudgetUsd` | `limit` (the budget, USD), `spent` (USD) |

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
    "ai": { "enabled": false, "model": "claude-sonnet-5-5", "excludedPaths": ["Private"],
            "maxContextChars": 60000, "monthlyBudgetUsd": 5.0 }
  },
  "readOnly": false
}
```

- `readOnly` is `true` when the file on disk was written by a newer version of the app or fails validation. The server then serves what it could read plus defaults, and refuses writes (DESIGN §5.12).
- Fields in the file that this version does not know are **preserved** on write.
- Per-device preferences (theme, spellcheck, autocorrect, remote images) are not vault settings; the client keeps them in `localStorage`.

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
| `ai` (ROADMAP item 18) | **Optional**, unlike the other groups: it came after schema version 1, so a file or a request without it, or without one of its fields, is valid. A request without `ai` keeps the current values (an old page cannot switch it off by accident); a file without it gets the defaults. A field that is present must be valid: `enabled` a boolean; `model` one of `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`; `excludedPaths` as `files.excludedPaths`; `maxContextChars` an integer from 4,000 to 400,000; `monthlyBudgetUsd` a number above 0 and at most 10,000. |

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
| `ai.*` | Ask your vault and summaries (§20). `enabled` is off by default: until it is on, nothing is ever sent to Anthropic. `excludedPaths` (default `["Private"]`) and `files.excludedPaths` are never read for a request. `maxContextChars` caps the note text of one request, earlier turns included; `monthlyBudgetUsd` refuses requests once the month's estimated spend reaches it. |

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

---

## 9. Raw files and uploads

### 9.1 `GET /api/files/raw?path={path}[&v={size}-{mtimeMillis}][&download=true]`

This returns the raw bytes of any visible file. It supports `Range` (206) and conditional requests (304). It is used for `<img>`, `<audio>`, `<video>` and `<iframe>` sources and for downloads. Symlinks are never served (`404`).

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
| `failed` | Notes whose links could not be updated, as `{path, reason}`; the move itself still happened. `reason` is `not-utf8` (the note is not valid UTF-8 and is never rewritten), `not-rewritable` (a frontmatter link whose source text does not match its parsed value, such as an escaped quoted string, or a link in a drawing that is indexed from its JSON rather than its Markdown, §11.2), `span-mismatch` (the note changed in a way that invalidated the plan) or `io-error`. |
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
| `409 type-mismatch` (`expected: "note"`) for non-`.md` files |

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
| `linked` | Notes with a link or embed (including frontmatter `"[[...]]"`) resolving to `path`, sorted by source mtime, newest first. `matched` is the raw link text. |
| `unlinked` | `null` unless `unlinked=true`. Then it lists plain-text, whole-word, case-insensitive occurrences of the note's basename or aliases (3 or more characters) outside code, links, frontmatter and URLs, in notes not matching `excludedPaths`. `matched` is the text found. At most 200 groups. It is `[]` for non-notes. |
| `context` | The source line, clipped to at most 240 characters around the match. A leading or trailing `…` marks clipping. `contextRange` is relative to `context`. |
| `from`, `to` | Absolute offsets in the source file at `sourceVersion` (used by §15.5) |
| Drawings as sources | An `.excalidraw` drawing links through `[[Note]]` in a text element, an element's link, and the images it stores as attachments (DESIGN §6.8.1). Such a group's `source` is the drawing, `context` is the element's text or link (for example `Call [[Plumber]] about the leak`), and `line`, `from` and `to` refer to that indexed text, not to the file's JSON. An `.excalidraw.md` drawing is a note: links in its Markdown sections are ordinary mentions; a link only its JSON holds is a mention whose `line`, `from` and `to` lie past the end of the file. Unlinked mentions never come from a drawing's JSON. |

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

---

## 12. Search and tags

### 12.1 `GET /api/search?q={query}[&limit=50][&sort=relevance][&prefix=true]`

This is full-text search over notes, and over the texts of `.excalidraw` drawings (a hit's `path` is then the drawing, and `matches` are lines of its text, never of its JSON). Notes whose path matches `settings.files.excludedPaths` (case-insensitive prefix) are never returned.

| Parameter | Meaning |
|---|---|
| `sort` | `relevance` (the default) or `mtime` (newest first) |
| `prefix` | With `true`, the last bare word of the query matches as a prefix when it is 2 or more characters long (search-as-you-type) |

`200 SearchResponse`:

```json
{
  "query": "\"weekly review\" tag:#work -draft",
  "total": 3,
  "tookMs": 4,
  "results": [
    { "path": "Work/Weekly review.md", "basename": "Weekly review", "score": 12.84,
      "mtime": "2026-10-14T18:20:11.000Z",
      "titleRanges": [ { "from": 0, "to": 13 } ],
      "matches": [
        { "line": 7, "text": "…so the weekly review covers open loops and next actions", "ranges": [ { "from": 7, "to": 20 } ] }
      ],
      "moreMatches": 2 }
  ]
}
```

| Field | Meaning |
|---|---|
| `total` | All matching notes; `results` holds at most `limit` of them |
| `matches` | Up to 3 matching body lines, each clipped to 200 characters (with `…` marking a clip). `ranges` are relative to `text`. `line` is the 0-based line number; the client opens a hit with `/n/<path>?line=<line>&q=<query>` (DESIGN §6.4). |
| `titleRanges` | Ranges in `basename` |
| `score` | Higher is better; 0 for filter-only queries |

- An empty or all-negative query returns `200` with `total: 0`.
- Errors: `400 bad-request` when `limit` is out of range or `sort` is unknown.

**Query grammar.** This is normative.

```
query   = ws* [ clause { ws+ clause } ] ws*
clause  = [ "-" ] ( filter | phrase | word )
filter  = ( "tag:" | "path:" | "file:" ) ( phrase | word )          ; keywords are case-insensitive
phrase  = '"' { char - '"' } ( '"' | end-of-query )                  ; an unterminated phrase runs to the end
word    = 1*( char - ws - '"' )
```

| Clause | Matches |
|---|---|
| `word` | Notes containing the word in the title, aliases, headings, tags or body. Matching is case-, accent- and width-insensitive. A word that tokenizes into several tokens (`e-mail`) acts as a phrase. |
| `"a phrase"` | Consecutive tokens |
| `tag:x` / `tag:#x` | Notes tagged `x` or any nested `x/…` |
| `path:x` | Case-insensitive substring of the full vault path |
| `file:x` | Case-insensitive substring of the file name |
| `-clause` | Excludes matches |

All clauses must match (AND). `OR`, parentheses and regular expressions are not supported in v1.

### 12.2 `GET /api/tags`

`200 TagsResponse`. Every tag plus every implied parent, sorted case-insensitively by `tag`.

```json
{ "tags": [
  { "tag": "project", "count": 3, "total": 5 },
  { "tag": "project/alpha", "count": 2, "total": 2 },
  { "tag": "work", "count": 9, "total": 9 }
] }
```

- `count` is the number of notes with exactly this tag. Drawings count as notes here: an `.excalidraw` drawing whose texts hold the tag, and an `.excalidraw.md` drawing through its Markdown or the texts only its JSON holds (DESIGN §6.8.1).
- `total` is the number of distinct notes (drawings included) with this tag or any descendant.
- A parent that only exists through nesting has `count: 0`.
- Display casing is the first one seen.

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
| `status.changed` | `StatusChangedEvent` | yes | Something shown by `GET /api/status` changed state (`git.state`, `watcher.mode`, `settings.readOnly`, `mirror.state`, or free space crossing 1 GiB), or a push requested with §6.4 ended; refetch it |
| `resync` | `ResyncEvent` | yes | The server could not describe the change precisely (watcher overflow, a bulk change of more than 50 entries, or a rescan error). Refetch everything (§16.5). |

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
  | 'too-large' | 'not-text' | 'unsupported-media-type' | 'unknown-host'
  | 'io-error' | 'permission-denied' | 'internal-error'
  | 'busy' | 'history-unavailable' | 'insufficient-storage'
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
/** Ask your vault and summaries (§20). Optional in a request: a body without it keeps the current values. */
export interface AiSettings {
  enabled: boolean;               // off by default: nothing is sent to Anthropic until this is on
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

// ---------- search / tags (§12) ----------
export interface SearchMatch { line: number; text: string; ranges: TextRange[] }
export interface SearchHit {
  path: VaultPath;
  basename: string;
  score: number;
  mtime: IsoInstant;
  titleRanges: TextRange[];
  matches: SearchMatch[];
  moreMatches: number;
}
export interface SearchResponse { query: string; total: number; tookMs: number; results: SearchHit[] }
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

// ---------- templates (§15.4) ----------
export interface TemplateEntry { path: VaultPath; name: string }
export interface TemplatesResponse { folder: VaultPath; templates: TemplateEntry[] }

// ---------- Ask your vault and summaries (§20) ----------
export type AiModelId = string;
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
  model: AiModelId;
  models: AiModelInfo[];
  keyFile: string;                // the key file's name, never its content
  keyPresent: boolean;
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
export interface StatusChangedEvent { reason: 'git' | 'watcher' | 'settings' | 'disk' | 'mirror' }
export interface ResyncEvent { reason: 'watcher-overflow' | 'bulk-change' | 'rescan-error' }

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
  'status.changed': StatusChangedEvent;
  'resync': ResyncEvent;
}
export type VaultEventName = keyof VaultEventMap;
export const VAULT_EVENT_NAMES: readonly VaultEventName[] = [
  'hello', 'ping', 'file.created', 'file.changed', 'file.deleted', 'folder.created', 'folder.deleted',
  'entry.moved', 'trash.changed', 'history.committed', 'settings.changed', 'status.changed', 'resync',
];
// Extensions add their own event names at runtime with registerEventHandler (DESIGN §6.8).
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
| GET | `/api/files/raw?path=&v=&download=` | | 200/206/304 bytes | 9.1 |
| PUT | `/api/files/raw?path=&onConflict=` | raw bytes | 201/200 `WriteResult` | 9.2 |
| POST | `/api/attachments?name=&source=` | raw bytes | 201 `AttachmentResult` | 9.3 |
| POST | `/api/folders` | `CreateFolderRequest` | 201 `FolderResult` | 10.1 |
| DELETE | `/api/folders?path=` | | 200 `TrashEntry` | 10.2 |
| POST | `/api/move` | `MoveRequest` | 200 `MoveResult` | 10.3 |
| GET | `/api/notes/meta?path=` | | 200 `NoteMeta` | 11.1 |
| GET | `/api/notes/backlinks?path=&unlinked=` | | 200 `BacklinksResponse` | 11.2 |
| POST | `/api/links/resolve` | `ResolveRequest` | 200 `ResolveResponse` | 11.3 |
| GET | `/api/search?q=&limit=&sort=&prefix=` | | 200 `SearchResponse` | 12.1 |
| GET | `/api/tags` | | 200 `TagsResponse` | 12.2 |
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
| GET | `/api/templates` | | 200 `TemplatesResponse` | 15.4 |
| GET | `/api/events?clientId=&lastEventId=` | | `text/event-stream` | 16 |
| GET | `/api/ai/status` | | 200 `AiStatus` | 20.4 |
| POST | `/api/ai/ask` | `AiAskRequest` | 200 `text/event-stream` | 20.2 |
| POST | `/api/ai/summarize` | `AiSummarizeRequest` | 200 `text/event-stream` | 20.3 |
| GET | `/actuator/health`, `/livez`, `/readyz` | | 200 / 503 | 6.3 |

**SPA routes** are served `index.html` by the server: `/`, `/n/**`, `/search`, `/trash`, `/settings`, `/settings/**` and `/x/**` (pages registered by extensions). Static bundles are served from `/assets/**`; root files such as `/theme-boot.js` and `/favicon.svg` are served with `no-cache`.

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
| `CreateFolderRequest`, `FolderResult`, `MoveRequest`, `MovedFile`, `LinkUpdate`, `FailedUpdate`, `MoveResult` | Same | `MoveRequest.updateLinks` and `dryRun` are `@Nullable Boolean`. `FailedUpdate.reason` is the enum `FailedReason` |
| `HeadingInfo`, `OutgoingLink`, `NoteMeta`, `Mention`, `BacklinkGroup`, `BacklinksResponse`, `ResolveRequest`, `ResolvedLink`, `ResolveResponse` | Same | `NoteMeta.frontmatter` is `@Nullable Map<String, Object>` |
| `SearchMatch`, `SearchHit`, `SearchResponse`, `TagCount`, `TagsResponse` | Same | |
| `TrashEntry`, `TrashListResponse`, `RestoreRequest`, `RestoreResult`, `PurgeResult` | Same | |
| `HistoryEntry`, `HistoryResponse`, `HistoryExclusion`, `HistoryContent`, `HistoryRestoreRequest`, `HistoryRestoreResult`, `CommitResult` | Same | `HistoryExclusion.reason` is the nested enum `Reason` (`large-file`) |
| `TemplateEntry`, `TemplatesResponse` | Same | |
| `HelloEvent`, `PingEvent`, `FileEvent`, `FileDeletedEvent`, `FolderEvent`, `FolderDeletedEvent`, `MovedEvent`, `TrashChangedEvent`, `HistoryCommittedEvent`, `SettingsChangedEvent`, `StatusChangedEvent`, `ResyncEvent` | Same names in `com.rjgehan.notes.events`, all implementing `sealed interface VaultEvent { @JsonIgnore String eventName(); @JsonIgnore default @Nullable String echoOrigin() { return null; } }` | `eventName()` returns the §16.4 string. Content events (`file.*`, `folder.*`, `entry.moved`, `settings.changed`) have a real `origin` record component, which is serialized, and override `echoOrigin()` to return it. Non-content events have no `origin` component, so they never serialize `"origin": null` into an event the TypeScript types declare without one. Neither interface method is serialized. `HelloEvent` and `PingEvent` are written by `EventHub` directly and never stored in the replay ring. |
| `AiSettings` | Same name in `com.rjgehan.notes.settings` | `model` is a `String` checked against `AiSettings.MODELS` |
| `AiAskRequest`, `AiSummarizeRequest`, `AiTurn`, `AiPrompt`, `AiStatus`, `AiModelInfo`, `AiSource`, `AiStartEvent`, `AiDeltaEvent`, `AiRestartEvent`, `AiUsage`, `AiDoneEvent`, `AiErrorEvent` | Same | Every request component is `@Nullable` (the service validates and applies defaults). `AiStatus.state` is the enum `AiState` (`off`, `not-configured`, `over-budget`, `ready`). The stream events are written by `AiController` through an `SseEmitter`, not through `EventHub`. |
| `Problem` / `VersionConflictProblem` | Not records: Spring `ProblemDetail` with properties added by `NotesException` / `VersionConflictException` | |

**Enums.** `FileKind`, `EntryType`, `OnConflict`, `LinkStyle` and `ChangeType` (in `api.dto`) serialize as the exact lower-case strings in §17, through `@JsonProperty` on each constant. Settings enums do the same with their string values.

**Nullability.** Every TypeScript `T | null` is a `@Nullable` component that is always serialized, including when null. An optional request field (`?`) is a `@Nullable` component; the server applies the documented default.

---

## 20. Ask your vault and summaries (ROADMAP item 18)

Questions about the vault answered by Claude with citations, summaries of a note, a folder, some notes or a selection, and suggested links, tags and tasks for a note (DESIGN §5.20, §6.21). **Off by default**: nothing is sent to Anthropic until `settings.ai.enabled` is on, the server has an API key file, and a request asks. Notes under `settings.ai.excludedPaths` or `settings.files.excludedPaths` are never read. The server keeps no conversation: each device keeps its own and sends the earlier turns back as `history`.

Every request is checked, and its prompt built, before the response starts, so a refusal is an ordinary problem document (§3), also for a client that sent `Accept: text/event-stream`:

| Problem | When |
|---|---|
| `409 ai-unavailable` | `reason: "off"` (switched off in Settings) or `"not-configured"` (no usable key; `detail` says why, never quoting the key) |
| `429 ai-budget-exceeded` | This month's estimated spend reached `settings.ai.monthlyBudgetUsd`; `limit` and `spent` in USD |
| `403 ai-excluded` | The note, folder or selection's note named by the request is excluded |
| `400 bad-request` | A field out of range (below) |
| `404 not-found`, `409 type-mismatch` | The note or folder does not exist, or is not a note |

### 20.1 Conversations and `history`

A turn is what was asked (`AiPrompt`: `action` `ask` with `question`, or `summarize`/`suggest` with the fields of §20.3), the answer as streamed, and `sources`, the paths `start` reported for it (§20.5). A follow-up sends the conversation's answered turns, oldest first (at most 50; the server uses the last 12). The server rebuilds each earlier turn from its prompt and its sources **as the notes are now**, skipping notes that were deleted or are now excluded, with the same rules as the first time: while the notes are unchanged, the earlier turns are byte for byte what was sent before, and the request's prefix comes from Anthropic's prompt cache. Notes already sent in the conversation are not sent again with a new question. When the conversation outgrows `settings.ai.maxContextChars`, the oldest turns lose their notes (their question and answer stay).

### 20.2 `POST /api/ai/ask`

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
| `history` | Optional, §20.1 |

**Retrieval.** The question's words (normalized like the search index, without common English words) select the notes that contain **any** of them, ranked with the index's BM25 (DESIGN §5.5.10; embeddings may come later). Up to 8 notes go with the question, the best first, each at most a quarter of `maxContextChars` (2,000 to 20,000 characters): a longer note is cut to its paragraphs with the most matches, marked `[…]`. Notes that do not fit are counted as `omitted`; excluded notes that matched are counted as `excluded` and never read.

The answer cites notes as wikilinks to their path without `.md` (`[[Projects/Kitchen]]`), which the client resolves like any link.

`200 text/event-stream` (§20.5).

### 20.3 `POST /api/ai/summarize`

Request `AiSummarizeRequest`:

| Field | Rule |
|---|---|
| `action` | `summarize` (default) or `suggest`: links to existing notes (chosen from related notes, titles only), tags (preferring the vault's tags) and tasks (`- [ ]` items) for a note |
| `scope` | `note` (`path`), `folder` (`path`, its notes at any depth, newest first), `notes` (`paths`, at most 100, for example this week's daily notes, with a `label` of at most 200 characters) or `selection` (`text`, at most 200,000 characters, from the note at `path`). `suggest` takes `note` only. |
| `history` | Optional, §20.1: a summary can be followed by questions |

A note summary sends the note up to `maxContextChars` (its beginning, marked truncated, when longer). A folder or list sends up to 60 notes, each at least 1,500 characters and together at most `maxContextChars`; the rest are counted as `omitted` and the answer says so. A selection is sent as it is, no note is read; `path` only names it, and must not be excluded.

`200 text/event-stream` (§20.5).

### 20.4 `GET /api/ai/status`

`200 AiStatus`:

```json
{ "state": "ready", "reason": null, "model": "claude-sonnet-5-5",
  "models": [ { "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "inputUsdPerMTok": 2.0, "outputUsdPerMTok": 10.0 } ],
  "keyFile": "anthropic-key", "keyPresent": true, "month": "2026-10", "monthCostUsd": 0.4213, "monthRequests": 37,
  "monthlyBudgetUsd": 5.0, "maxContextChars": 60000, "fake": false }
```

| Field | Values |
|---|---|
| `state` | `off` (switched off in Settings), `not-configured` (no usable key; `reason` says why), `over-budget` (`reason` names the budget), `ready` |
| `keyFile`, `keyPresent` | The key file's name and whether it holds a key; never the key |
| `month`, `monthCostUsd`, `monthRequests` | The calendar month in the server's time zone, and its estimated spend (list prices of the models that answered) and request count |
| `fake` | `true` on a development server started with `notes.ai.fake=true`, which answers with canned text and never calls Anthropic |

### 20.5 The answer stream

The response to §20.2 and §20.3 is `text/event-stream` with `Cache-Control: no-store`, read from the `fetch` body (`EventSource` cannot `POST`). Events, in order:

| `event:` | `data` | Meaning |
|---|---|---|
| `start` | `AiStartEvent` `{model, sources, omitted, excluded}` | The model asked and the notes sent with this turn (`{path, chars, truncated}`): the device keeps the paths as the turn's `sources` |
| `delta` | `AiDeltaEvent` `{text}` | The next piece of the answer (Markdown) |
| `restart` | `AiRestartEvent` `{model}` | The model declined part way and `model`, the server-side fallback, answers from the start: discard the text so far |
| `done` | `AiDoneEvent` | The end: `stopReason` (`end_turn`, `max_tokens`, `refusal`, …), `refusalCategory`, `fellBack`, `usage` (tokens, cache reads and writes), `costUsd` and `monthCostUsd` (estimated) |
| `error` | `AiErrorEvent` `{code, message}` | The end, after a failure: `auth` (the key was refused), `rate-limited`, `overloaded`, `bad-request`, `unavailable` (network, timeout), `busy` (two answers are already being written), `internal-error`. `message` never contains the key or note text. |

A stream that ends without `done` or `error` was cut off. Closing the connection (Stop) stops the answer on the server too; what was generated until then is still counted in the month's spend, estimated at four characters per token.
