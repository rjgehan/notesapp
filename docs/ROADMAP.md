# NotesApp Roadmap

| | |
|---|---|
| Date | 2026-10-17 |
| Status | **Everything approved, 2026-10-17** ("build all of the features"): items 1–41, built on the `build/roadmap` branch in waves and merged to `main` once verified. |
| Decisions (2026-10-17) | **Server:** homeserver, as designed. **Formula engine** (items 6 and 39): GPL-3.0 with HyperFormula; the repository becomes GPL-3.0. **Reminder delivery** (item 9): undecided, so every route is built and each one is switched on in Settings. **Public publishing** (item 26): built switched off; nothing is exposed until you enable it. **No iOS app**; the phone uses the web app. **Desktop app** (item 41): Electron, because rgpc has no Rust toolchain. |
| Build order | Wave 1: 10, 6, 4, 5, then 1, 2, 23 and 38. Wave 2: 3, 39, 40 (with 17), 13, 12, 7, 19, 8, 22. Wave 3: everything else except 37 and 41. Wave 4: 37 and 41, then end-to-end verification. |

**Legend**

| Column | Values |
|---|---|
| **Value** | **H**: daily-use impact or data safety. **M**: noticeable improvement. **L**: nice to have. |
| **Effort** | **S**: up to about 2 days of focused work (about one PR). **M**: about a week (a few PRs). **L**: multiple weeks, with its own short design doc first. |

---

## v1 scope (approved, being built now)

DESIGN.md has the details.

- **Vault and storage.** Plain Obsidian-compatible files in `/data/vault` on homeserver: `.md` notes, attachments, a flat `.trash/` and `.notesapp/settings.json`. Atomic writes and no-clobber creates, NFC and case-safe names, CRLF files kept CRLF, BOMs kept. Files with Windows-unfriendly names created over SSH stay usable.
- **Editor.** CodeMirror 6 styled source mode, plus a reading view (markdown-it) with Obsidian's line-break behaviour, `==highlights==` and hidden `%%comments%%`. Autosave with local drafts (IndexedDB), inline title rename, a mobile toolbar, dark (default) and light themes.
- **Linking.**
  - `[[wikilinks]]` with autocomplete (notes, aliases, `#headings`), click-to-navigate and create-on-click, resolved on the device (no round trip per click).
  - `![[embeds]]` for images, audio, video, PDF and notes one level deep.
  - Links update automatically on rename or move, with a preview in the Move dialog, collateral protection, and Undo (a reverse move).
  - Backlinks (linked and unlinked, with a Link action), an outline, and tags (inline and frontmatter, nested).
- **Finding things.**
  - Full-text search with phrases, `tag:`, `path:`, `file:` and negation.
  - Quick switcher (`Mod-O`), with fuzzy matching, aliases, recent files and create.
  - Command palette (`Mod-P`).
- **Files.** Explorer with folders: create, rename, move (drag and drop), delete. A trash with restore, purge and empty. Paste or drop attachments.
- **Version history.** JGit inside the vault: batched commits (30 s quiet, 5 min maximum), immediate commits for delete, move and restore, per-note history with a diff and restore, authors taken from your Tailscale identity, and a status-bar warning if commits ever start failing.
- **Live sync.** An SSE stream, version tokens, idempotent retries, a conflict banner (Keep mine, Take theirs with Undo, Compare), live updates of open notes, notes that follow a rename made on another device, and automatic reload of open tabs after a deploy.
- **Daily notes and templates.** Obsidian semantics: moment-style formats, `{{title}}`, `{{date:FMT}}`, and frontmatter merging.
- **Mobile.** A responsive iPhone Safari layout: drawer (with Settings, Trash and the theme toggle), bottom sheet, keyboard-aware editor, long-press menus, and the command palette on the toolbar.
- **Deploy.** GitHub Actions builds an amd64 and arm64 image and pushes it to GHCR, with a weekly rebuild for security fixes and Dependabot for dependency updates. On homeserver, Watchtower updates it (with notifications and a documented rollback), and it runs behind a Tailscale sidecar (`https://notes.<tailnet>.ts.net`, kernel mode, loopback-only app). A tailnet policy and Host and identity allowlists limit it to your own devices.
- **Extension points** for the big three:
  - a frontend file-type view registry, plus page, panel, command and event-handler registration;
  - a generic versioned text/JSON file API, with per-extension size limits;
  - `.sheet`, `.excalidraw`, `.tasks` and `.canvas` already treated as text kinds.
- **Not protected in v1:** losing the server's disk. Git history lives on the same disk; a manual backup procedure is documented. Item 1 is the recommended first addition.

---

## Backlog at a glance (recommended order)

| # | Item | Value | Effort | Depends on |
|---|---|---|---|---|
| 1 | Nightly and off-site backups *(declined for v1; recommended first after v1)* | H | S | |
| 10 | **Live Preview editing: no visible Markdown, tables as a grid** *(your pick, 2026-10-17)* | H | L | 3 helps |
| 39 | **Formulas in notes: spreadsheet math in tables and text** *(new)* | H | M | 10a; item 6's engine decision |
| 40 | **Scripts in notes: blocks that run and show their result** *(new)* | H | L | 10; 39 for formula functions |
| 2 | Mirror the vault's git history to a private GitHub repo | M | S | |
| 3 | Rich Markdown pack: callouts, code highlighting, math, Mermaid *(declined for v1; **built 2026-10-21**)* | H | M | |
| 4 | **Structured to-do tracking, not Markdown** *(big three c)* | H | L | (9 for reminders) |
| 5 | **Excalidraw drawings** *(big three b)* | H | M | |
| 6 | **Spreadsheets with Google-Sheets-style formulas** *(big three a)* | H | L | |
| 7 | Quick capture inbox and the iPhone Share Sheet *(built 2026-10-21, `feat/pwa-capture`)* | H | M | |
| 8 | Installable PWA and offline mode *(declined for v1; built 2026-10-21, `feat/pwa-capture`)* | H | L | |
| 9 | Reminders and push notifications | H | M | 4; 8 for Web Push |
| 11 | Tabs and split panes *(declined for v1)* | M | M | |
| 12 | Bookmarks (starred) and a recent-files pane | M | S | |
| 13 | Properties editor (typed frontmatter UI) | M | M | |
| 14 | Calendar view | M | M | 4 optional |
| 15 | Kanban boards | M | M | 4 |
| 16 | Graph view *(declined for v1)* | M | M | |
| 17 | Dataview-style query blocks *(shrinks to a `query()` helper inside 40)* | M | S | 40; 13 helps |
| 18 | Ask your vault and summaries, powered by Claude | H | M | |
| 19 | Web clipper | M | M | 7 |
| 20 | Block references and block embeds | M | M | |
| 21 | Update `[[Note#Heading]]` links when a heading is renamed | M | S | |
| 22 | Search upgrades: OR, regex, saved searches, PDF text | M | M | |
| 23 | Large-attachment policy for git history | M | S | 1 |
| 24 | Obsidian vault import and compatibility kit | M | S | |
| 25 | Canvas (JSON Canvas, Obsidian-compatible) | M | L | |
| 26 | Publish a note publicly through Tailscale Funnel *(built 2026-10-21, `feat/publish`, switched off)* | M | M | 3 helps |
| 27 | Per-note encryption | M | M | |
| 28 | Vault-wide timeline and restoring deleted files from git | M | M | |
| 29 | Customizable hotkeys and per-device preferences | L | S | |
| 30 | Templates v2: folder templates, prompts, cursor | M | S | |
| 31 | Slash commands and editor niceties | M | M | |
| 32 | PDF viewer (PDF.js) | M | M | |
| 33 | Voice notes with transcription | M | M | |
| 34 | Flashcards and spaced repetition | M | M | |
| 35 | Habit tracker | L | M | 4 or 13 |
| 36 | Vim mode | L | S | |
| 37 | Multiple vaults | M | L | |
| 38 | Ops polish: JDK 25 runtime, faster start, app-error alerts, status page | M | S | |
| 41 | **Desktop app (Windows and macOS) with live sync** *(new, 2026-10-17)* | M | M | 7 for quick capture; 8 for offline |

---

## Writing without seeing Markdown (your direction, 2026-10-17)

You don't want to "code" a note and then switch to a preview to see it. These three items cut out that step. Item 10 is the editor itself. Items 39 and 40 add live content to notes: spreadsheet math, and small programs whose output appears in place.

### 10. Live Preview editing *(your pick, 2026-10-17; declined for v1)*

**One line:** notes render as you type, in the one editor. There is no separate preview, Markdown syntax is hidden by default, and tables show and edit as a grid. The file on disk stays plain Markdown, byte for byte what you wrote.

| Value | Effort | Depends on |
|---|---|---|
| H | L | 3 helps (callouts, math and Mermaid render inside it once 3 lands) |

**Why this approach.** Three options were weighed on 2026-10-17:

| Option | Verdict |
|---|---|
| **Live Preview in the v1 CodeMirror editor** | **Chosen.** The editor's text *is* the file, so nothing is ever reformatted. Conflicts, drafts, history, autocomplete, search and the merge view keep working unchanged. |
| A rich-text editor (ProseMirror, through TipTap or Milkdown) that saves Markdown | Not now. It holds a document tree instead of text and regenerates the Markdown on every save, which risks reformatting files, mangling Obsidian syntax it doesn't model (`%%comments%%`, `^block-ids`, callouts) and noisy git history. It also replaces v1's editor engine. The file format doesn't change under item 10, so this stays possible later. |
| A non-Markdown format (Notion-style JSON blocks) | Rejected. It gives up plain files, Obsidian compatibility and readable history, and buys nothing the rich-text option doesn't. |

**Modes.**

- **Live Preview** is the default for every note.
- **Source** (today's styled source mode) is a per-note toggle for when you want the raw text.
- The **reading view becomes a "lock editing" toggle**: the same rendering, read-only. There is one look everywhere.

**Syntax visibility** is a per-device setting:

- **Hide all** (default). Markers stay hidden even under the cursor; you format with the toolbar, shortcuts and typing shortcuts below. Hidden markers are atomic ranges, so the cursor steps over them, and Backspace at the edge of bold text deletes a letter, not a `*`. Typing at the end of bold text continues in bold, as in a word processor.
- **Reveal at cursor** (Typora style). The markers of the element the cursor is in appear; everything else stays rendered.

**What renders.**

| Element | In Live Preview |
|---|---|
| Headings | Sized text, no `#` |
| Bold, italic, strikethrough, `==highlight==`, inline code | Styled; markers hidden |
| `[[links]]` and `[text](url)` | The link text, clickable (tap, or click with `Mod` held while editing); unresolved links dimmed as in v1 |
| Bullets, numbered lists, quotes, `---` | Bullets and numbers, a quote bar, a horizontal rule |
| `- [ ]` checkboxes | Real checkboxes; tap to toggle |
| **Tables** | **A grid.** Click a cell to edit its text; `Tab`, `Shift-Tab` and `Enter` move between cells; add, remove and drag rows and columns. An edit rewrites only that table's text, as one undo step. |
| `![[embeds]]` and images | Inline, honouring `\|400` sizes; notes embedded one level deep, as in the reading view |
| Frontmatter | A collapsed properties block (item 13 turns it into a typed editor) |
| `%%comments%%` | Hidden; shown dimmed in reveal-at-cursor mode |
| Footnotes | A superscript number; hover or tap shows the text |
| Code blocks | Highlighted code with the fences hidden; callouts, math and Mermaid render once item 3 lands |

**Never typing syntax.**

- **Typing shortcuts** convert as you type: `# ` to `###### ` make headings, `- ` a bullet, `1. ` a numbered item, `[] ` a checkbox, `> ` a quote, `---` a rule, ```` ``` ```` a code block, and a `|` header line followed by `Enter` a table. `[[` opens the existing note picker.
- **Formatting:** `Mod-B`, `Mod-I`, `Mod-K` (link) and a few more; a small toolbar over selected text on desktop; and the v1 mobile keyboard toolbar gains bold, italic, heading, list, checkbox, table and link buttons.
- **Pasting** from a web page, Google Docs or Word keeps the formatting: the HTML is converted to Markdown with turndown (also used by item 19).

**How it is built.**

- CodeMirror 6 replace decorations and widgets, computed for the visible range from the Lezer Markdown tree v1 already parses. `highlight.ts`, `unresolved.ts` and `obsidianSyntax.ts` already decorate from that tree.
- Block widgets for tables, embeds and frontmatter. Embeds reuse the view registry's `loadEmbed()` hook.
- The table grid edits a model of the table and writes the table's text back in a single transaction.

**iPhone.** Selection handles next to hidden markers and widgets need testing on a real device in Safari. Table cells use tap-to-edit, with Next and Previous on the keyboard toolbar.

**Phases.**

- **10a:** the mode toggle and visibility setting; inline formatting, headings, lists, quotes, checkboxes and links; **tables rendered and editable as a grid** (in the first phase because Live Preview isn't usable without them); typing shortcuts, toolbar and rich paste; Live Preview as the default.
- **10b:** inline images and embeds, the frontmatter block, footnotes and comments; the reading view becomes "lock editing".
- **10c:** iPhone polish, and a performance pass on long notes (a 10,000-line test note).

### 39. Formulas in notes: spreadsheet math in tables and text *(new, 2026-10-17)*

**One line:** Excel- and Google-Sheets-style formulas inside ordinary notes. A table cell containing `=SUM(B2:B5)` shows its result, and inline `` `=1450*12` `` shows `17,400`. The file keeps the formula you typed.

| Value | Effort | Depends on |
|---|---|---|
| H | M | 10a (the table grid); the engine decision in item 6 |

**Tables.**

- Every Markdown table is also a small sheet. Columns are A, B, C, …; the header row is row 1, so the first data row is row 2, as in a spreadsheet with a header row.
- A cell whose text starts with `=` is a formula: `=B2*C2`, `=SUM(B2:B5)`, `=AVERAGE(B:B)`, `=IF(C3>100, "over", "ok")`.
- Live Preview shows the result. Clicking the cell shows the formula, and the grid gets a formula bar. Errors show the usual codes (`#DIV/0!`, `#REF!`, `#NAME?`), with the message on hover.

```markdown
| Item      | Cost         |
|-----------|--------------|
| Rent      | 1450         |
| Utilities | 210          |
| Internet  | 65           |
| **Total** | =SUM(B2:B4)  |
```

renders as a grid whose last cell shows `1725`.

**Inline.**

- Inline code that starts with `=` is a formula: `` `=1450*12` `` renders as `17,400`. Obsidian shows it as code, so the file still reads sensibly there.
- **39b:** name a table with an Obsidian block id (a `^budget` line under it) and use it anywhere in the note: `` `=budget!B5` ``, `` `=SUM(budget!B2:B4)*12` ``.
- A note whose tables or inline code legitimately start with `=` turns formulas off with `formulas: false` in its frontmatter.

**Engine.** It is **the same formula engine as item 6**, so every function behaves the same in a note table and in a `.sheet` file. A note's tables load as the sheets of one engine instance, lazily, and only for notes that contain formulas. This means **the item 6 licence decision (GPL-3.0 with HyperFormula, or permissive with IronCalc) has to be made before 39 starts**, even if item 6 itself is built later.

**Not stored.** Results are never written into the file; the file holds exactly what you typed. Search therefore finds the formula text, not the result.

**Phases.**

- **39a:** formulas in table cells, and inline formulas that don't refer to tables.
- **39b:** named tables and inline references to them; per-column number formats (currency, percent, decimals), stored in a `%%` comment line under the table so Obsidian ignores it.

### 40. Scripts in notes: blocks that run and show their result *(new, 2026-10-17)*

**One line:** a code block that runs and shows its output in place, for content that changes by itself. For example, "on Mondays, show my Monday notes", "list my `#project` notes that aren't done", or a countdown.

| Value | Effort | Depends on |
|---|---|---|
| H | L (40a alone is M) | 10 (output appears in place); 39 for formula functions |

**What it looks like.** Your example, as a script:

````markdown
```script
if (today().weekday === "Monday") {
  show(embed("Monday notes"))
}
```
````

- In Live Preview the block shows only its output: the embedded "Monday notes" on a Monday, nothing on other days. Click into the block, or its small `</>` button, to see and edit the code.
- In Source mode it is an ordinary code block, and Obsidian shows it as code.
- More examples:
  - `show(list(notes({ tag: "project" }).filter(n => n.props.status !== "done")))`
  - `show(table(notes({ folder: "Daily" }).slice(0, 7), ["title", "mood"]))`
  - `` show(`${today().daysUntil("2026-12-25")} days to Christmas`) ``

**Language: JavaScript, run in a sandbox.**

- **Why JavaScript.** Your example is already JavaScript-shaped (`getDay`), it is the most documented language there is, and there is no parser for us to build and maintain. Claude (item 18) can write scripts for you.
- **Why a sandbox.** Notes can come from outside: a clipped web page, a file copied in over SSH, a shared device. JavaScript running in the app page could read, change or delete every note through the API. Scripts therefore run in **QuickJS compiled to WebAssembly** (`quickjs-emscripten`, MIT; pin the version at implementation time), inside a Web Worker:
  - a script has no DOM, no network, no storage, and no functions except the API below;
  - a CPU limit (about 250 ms per run) and a memory cap stop runaway loops;
  - output passes through the reading-view sanitizer as Markdown or structured values, never raw HTML.
- **Security policy change.** Compiling WebAssembly needs `'wasm-unsafe-eval'` in `script-src`. `SecurityHeadersFilter` adds it **only to the sandbox worker's script response**; the app page keeps `script-src 'self'`.
- **Alternatives considered.**
  - A friendlier custom syntax (`if today is Monday: show [[Monday notes]]`) reads more nicely, but it needs a parser, documentation and an editor mode that we would own forever.
  - Excel-style formulas (`=IF(WEEKDAY(TODAY())=2, …)`) are fine for one-liners and awkward for anything with steps. Item 39 covers one-liners.

**API (read-only in 40a).** API calls look synchronous to the script (QuickJS's asyncify build), so no `await` is needed.

| Function | Gives you |
|---|---|
| `today()`, `now()`, `date("2026-10-17")` | Dates with `.weekday` (`"Monday"`), `.day`, `.month`, `.year`, `.format("YYYY-MM-DD")`, `.add(3, "days")`, `.daysUntil(…)` |
| `note("Title or path")` | One note: `title`, `path`, `tags`, `props` (frontmatter), `modified`, `text()` |
| `notes({ tag, folder, prop, linksTo, search })` | Matching notes, as an array to filter and sort in JavaScript |
| `thisNote()` | The note the script is in |
| `show(value)` | Renders text, a number, Markdown, `list(items)`, `table(rows, columns)` or `embed("Note")`; several calls show in order |
| `fn.SUM(…)`, `fn.WEEKDAY(…)`, … | Every formula function from item 39 (40b), so math works the same everywhere |

- **New endpoint.** `notes()` needs metadata for many notes at once, which v1 does not have (`/api/notes/meta` takes one path). A `GET /api/notes/query?tag=&folder=&prop=&linksTo=&q=` returns `{path, title, tags, frontmatter, mtime}` for the matches, from the server's in-memory index, with a result cap.

**When it reruns.**

- When the note opens.
- When a note the script read changes, using the SSE events the client already receives.
- At local midnight, so `today()` stays right.
- With a ↻ button on the block.

Errors show in the block as the message and line number, with the code visible.

**Relation to item 17.** This covers what item 17 was for. Item 17 shrinks to an optional `query("TABLE due, status FROM #project WHERE status != \"done\"")` helper inside scripts, for people who would rather not write JavaScript.

**Later, not in 40a or 40b:** scripts that change things, such as a button that creates a note from a template or checks off a task. Writes would need a confirmation and would go through the normal API, with history, so they come only after the read-only version has proven itself.

**Phases.**

- **40a:** the sandbox, the `notes/query` endpoint, the date and note API, `show()` for text, lists, tables and embeds, rendering in Live Preview and the reading view, and error display.
- **40b:** reruns on change and at midnight, formula functions (after 39), and the `query()` helper.
- **40c (optional):** write actions with confirmation.

---

## The big three

### 4. Structured to-do tracking, not Markdown *(big three c)*

**Status:** built (wave 1): phases 4a and 4b, as below; phase 4c (reminder delivery) comes with item 9, as planned. Reminders are already stored, edited and moved with repeating tasks, so item 9 only adds delivery. Deviations from this spec, and why:

- **Embeds in Live Preview.** `![[Home.tasks]]` is interactive in the reading view, through the view registry's `loadEmbed`. Live Preview (item 10) renders no embeds until its phase 10b, which mounts them through that same hook, so task embeds need no change then. Embeds also take `#Section` or `#^<task id>` to show part of a list.
- **Convert checkbox to task** leaves `- [[Inbox.tasks#^<task id>|Title]]`: a link to the list's file with the task's id as an Obsidian block reference, because a task has no note of its own. NotesApp opens the task from it, even after the task moved to another list, and Obsidian keeps it as a link to the file. The line keeps its list marker. The Obsidian Tasks plugin's emoji dates, priorities and 🔁 rules become task fields, which this spec did not ask for, so a vault that used that plugin keeps its dates.
- **Kanban.** Cards are the top-level tasks; subtasks are counted on their card and open in the details. In the status columns, Done and Cancelled are ordered by completion time, so cards are reordered within To do only. A list's layout (list or board) is remembered per device.
- **A `.tasks` file opens as its list**, with its JSON one click away (Source), rather than as JSON. Link and embed targets then show something useful.
- **Pages.** Completed and Filter are reached from tabs on every task page and from the palette, not the ribbon, which keeps three task icons (Today, Upcoming, lists). Upcoming leaves out overdue tasks (Today has them). A filter is saved as its page address (bookmarkable), not as a named saved filter.
- **Recurrence** is the RRULE subset of API.md §20.6 (`DAILY` to `YEARLY`). `COUNT` is stored as the occurrences left, and completed occurrences are not logged as separate tasks, so the Completed log shows a repeating task only once it is done for good. The rule editor offers common choices, a rule in words and a raw RRULE.
- **Conflicts are per field.** A `PATCH` carries the `base` values the client saw rather than a version of the task or list: two devices editing different tasks, or different fields of one task, never conflict, and a retry changes nothing. `complete` takes the `due` and `start` it saw, so a repeating task never rolls forward twice. Additions to the API: `GET /api/tasks/{id}`, `Task.archived`, `TaskList.path` and `writable`, and the `task-conflict` and `malformed-file` errors (API.md §20).
- **Changes made outside the task API** (hand edits, saves of the file as text, restores, moves) send only the usual file events. Clients refetch their task views when a `.tasks` file changes.
- **Search and backlinks.** `DocumentIndexer` hands the index the searchable content as Markdown blocks, scanned with the note rules, instead of its own model of links and tags. When a note is renamed or moved, the move rewrites the links to it in task files too (titles, notes and `links` paths), through the indexer, since the indexed links point into search text rather than the file.
- **Versions.** chrono-node is 2.10.2, not 2.10.3: 2.10.3 was less than two weeks old when it was pinned. rrule is 2.8.1 and lib-recur 0.17.1.

**One line:** a real task manager (lists, due dates, priorities, recurrence, subtasks, reminders, Today and Upcoming views) whose data lives in the vault as JSON, not as `- [ ]` lines.

| Value | Effort | Depends on |
|---|---|---|
| H | L | Reminders need item 9 |

**Data model**

```ts
interface TaskList {
  id: string;                    // ULID
  name: string;
  color?: string;
  icon?: string;                 // lucide icon name
  order: string;                 // fractional index
  archived: boolean;
  sections?: { id: string; name: string; order: string }[];   // also the Kanban columns
}
interface Task {
  id: string;                    // ULID
  listId: string;
  sectionId?: string;
  parentId?: string;             // subtasks, max depth 3
  title: string;                 // plain text; [[Note]] links and #tags allowed inline
  notes?: string;                // Markdown body
  status: 'open' | 'done' | 'cancelled';
  priority: 0 | 1 | 2 | 3;       // none / low / medium / high
  due?: string;                  // 'YYYY-MM-DD' (all-day) or 'YYYY-MM-DDTHH:mm' (local time)
  start?: string;                // "do on" date; drives the Today view
  recurrence?: { rrule: string; from: 'due' | 'completion' };   // RFC 5545 RRULE subset
  reminders?: { at: string }[];  // local date-times
  tags: string[];
  links: string[];               // vault paths of related notes
  order: string;                 // fractional index for manual ordering
  createdAt: string; updatedAt: string; completedAt?: string;
}
```

**Storage.** There is one JSON file per list under `Tasks/`, for example `Tasks/Inbox.tasks` and `Tasks/Home.tasks`:

```json
{ "type": "notesapp-tasks", "version": 1,
  "list": { "id": "01JA…", "name": "Home", "order": "a0", "archived": false },
  "tasks": [ { "id": "01JA…", "title": "Pay rent", "due": "2026-11-01", "priority": 2, … } ] }
```

- The file is pretty-printed and sorted by id, so git diffs are readable and every list gets full history, trash and restore for free.
- Tasks completed more than 90 days ago roll into `Tasks/Archive/<List> <YYYY>.tasks`, so active files stay small.
- Rejected alternatives:
  - Markdown checkboxes: you explicitly do not want them.
  - SQLite: it would not be a vault file, would have no git history, and would not be portable.

**API.**

- The server owns task operations, so two devices can edit different tasks in the same list without file-level conflicts: `GET /api/tasks?view=today|upcoming|list|search…`, `POST /api/tasks`, `PATCH /api/tasks/{id}` (field-level), `POST /api/tasks/{id}/complete`, `POST /api/tasks/reorder`, plus list CRUD.
- Each operation runs under the list file's path lock and is written atomically. Commits are batched like autosaves.
- New SSE events `task.created`, `task.changed`, `task.deleted` and `list.changed` are added; the frontend consumes them with the v1 `registerEventHandler` extension point. Today and Upcoming are `registerPage` routes, "Tasks linking to this note" is a `registerPanel` panel, and quick add is a global `registerCommand` (DESIGN §6.8).
- Hand edits to `.tasks` files are reconciled like any external change.

**Recurrence.**

- The rule is stored as an RRULE string.
- On completion, the server computes the next occurrence, from either `due` or the completion date, with `org.dmfs:lib-recur` (Apache-2.0; pin the version at implementation time) and rolls the task forward.
- The UI renders a readable form with `rrule` 2.8.1 (BSD-3) `toText()`.

**Views.**

| View | Contents |
|---|---|
| Today | Overdue tasks, tasks due today, and tasks with a start date of today or earlier |
| Upcoming | The next 14 days grouped by day, with a week strip |
| List | Sections, subtasks, drag to reorder |
| Kanban | Columns are sections or status (shared with item 15) |
| Completed | A log of finished tasks |
| Filter | By tag, priority or list |
| Note panel | "Tasks linking to this note" in the right sidebar |

**Quick add.**

- It lives in the palette, behind a mobile floating "+" button and on a hotkey.
- Example input: `Pay rent tomorrow 9am every month !high #home @Bills [[Apartment]]`.
- Parsing:
  - dates and times use `chrono-node` 2.10.3 (MIT);
  - `every …` uses `rrule`'s `RRule.fromText`;
  - `!high`, `!med`, `!low` or `!!!` set the priority;
  - `#tag`, `@List` and `[[link]]` are recognized.
- Parsed parts appear as chips before you save.

**Reminders.** These come from item 9: Web Push in the installed PWA (item 8), or ntfy. Phase 4c therefore needs your choice of route first (see item 9).

**Integration with notes.**

- `![[Home.tasks]]` embeds an interactive list in a note.
- `[[Note]]` in a task title becomes a backlink, through the backend `DocumentIndexer` extension point.
- The command **Convert checkbox to task** moves a `- [ ]` line into Inbox and leaves a link in its place.

**Phases.**

- **4a:** model, storage, API, List and Today views, quick add.
- **4b:** recurrence, Upcoming, Kanban, embeds, backlinks.
- **4c:** reminders, together with item 9.

### 5. Excalidraw drawings *(big three b)*

**Status:** built (wave 1). The editor for `.excalidraw` and Obsidian `.excalidraw.md` files, `![[drawing]]` embeds, and search and backlinks from drawings; design in DESIGN §6.8.1, the `DocumentIndexer` in §6.8. Deviations and additions:

- **Fonts under `/assets/excalidraw-<version>/`**, not `/excalidraw-assets/`: the existing immutable `/assets/**` handler serves them, and the version in the path makes permanent caching safe. The CSP is unchanged by drawings; the editor's own SVG export embedded whole fonts because glyph subsetting compiles WebAssembly, which the policy allows since item 32 (`'wasm-unsafe-eval'`), so exports subset fonts now.
- **More than the drawing block and Text Elements is written** in an `.excalidraw.md`: images added here get `## Embedded Files` entries (Obsidian would not show them otherwise), and `## Element Links` is kept in step with the drawing (the plugin reads it before the JSON, so a stale entry would revert a link edited here). Both stay byte-identical while nothing in them changed. New text elements get 8-character ids in the file, the plugin's block ids.
- **Automatic merge** is a generic `DocumentSession` extension (`SessionDeps.mergeFor`), not drawing code; a rename's rewritten link survives a concurrent edit of the same element.
- **Embeds** are `<img>`s of the SVG (sandboxed, no id clashes) with the fonts inlined by the app, since Excalidraw's inlining fails under the CSP and its fallback can fail on Safari. Live Preview gets them when item 10 adds embeds (10b), through the same `loadEmbed`.
- **The plugin's extras** render as static images: an embedded note as a card with its title and text, an embedded drawing as its SVG (one level deep), a LaTeX formula as its source (the plugin typesets with MathJax; the app has no SVG math renderer), PDF pages and web images as placeholders.
- **`.excalidraw.md` is indexed as the note it is** (as in Obsidian), with the JSON decompressed on the server (a Java port of lz-string, tested against its output) only to add what the Markdown sections lack. To allow that, the `DocumentIndexer` of item 4 also supplements notes.
- **Links inside drawings are not rewritten** by a rename (only those in an `.excalidraw.md`'s Markdown sections are); the move reports the drawing as `not-rewritable`, and the editor still finds a moved image by name.
- "New drawing" opens once its pending title is committed (Enter or blur), because drawings have no inline title to take the typing over. Large data URLs in imported excalidraw.com files are kept, never moved out on open.
- **A linked text of an `.excalidraw.md` is edited as the canvas shows it** ("plan" for `[[Project Plan|plan]]`), not as its Markdown source as in the plugin, whose Excalidraw fork has a hook for that; the edit is carried over to the source word by word, keeping its links (DESIGN §6.8.1). An edit that cannot be carried over keeps the links after the text and says so.
- **Drafts of a `compressed-json` drawing are not compressed**: compressing a large handwritten page on every draft stalled drawing. Saves keep the file's encoding; only a draft restored after a crash is saved as `json`, once.

**One line:** hand-drawn diagrams as vault files, editable on PC and iPhone (touch and pencil) and embeddable in notes.

| Value | Effort | Depends on |
|---|---|---|
| H | M | |

**Library.** `@excalidraw/excalidraw` 0.18.1 (MIT). Its peer dependencies are React 17–19, so it works with React 19.3.

- It is loaded as a **lazy chunk** because it is large.
- Fonts and assets are **self-hosted**: copy `dist/prod/fonts` into the build and set `window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/"`. The app's CSP blocks third-party CDNs, and offline mode (item 8) needs local assets too.

**File format.** `*.excalidraw` is plain Excalidraw JSON (`{"type":"excalidraw","version":2,"elements":[…],"appState":{…},"files":{…}}`). These are the same files excalidraw.com saves and opens.

**Obsidian-Excalidraw compatibility.** The Obsidian plugin's default format is `*.excalidraw.md`: a Markdown file with frontmatter `excalidraw-plugin: parsed`, a `## Text Elements` section, and a `%%`-wrapped `## Drawing` section holding a ```` ```json ```` or ```` ```compressed-json ```` block (LZ-String base64; `lz-string` 1.5.0). The plan:

- **Read** both formats.
- **Write** `.excalidraw` for new drawings.
- When **editing an existing `.excalidraw.md`**, rewrite only the drawing block and the text-elements section, leaving everything else as it was, so the file round-trips with Obsidian.
- The plugin's extras (Markdown-embedded elements, LaTeX) render as static elements.

**Embedding.**

- `![[Diagram.excalidraw]]` renders an SVG through `exportToSvg`, loaded lazily on first use. `|400` sets the width. Clicking it opens the editor.
- The view registry's `loadEmbed()` hook already exists for this.

**Sync and conflicts.**

- The view registers `merge()` using Excalidraw's element `version` and `versionNonce` reconciliation, so concurrent edits from two devices merge automatically; the session's `baseText` (DESIGN §6.8) supplies the merge base. The banner appears only when the merge fails.
- A `file.changed` event while a drawing is open merges the remote scene in live.
- The view saves through `markDirty(serialize)`, so the scene is serialized only when a save or draft is written, not on every pointer move.

**Images inside drawings: stored as vault attachments from phase one**, as the Obsidian plugin does. `.excalidraw` is a text kind with the 5 MiB text limit, and base64 adds about a third to every image, so two or three phone photos embedded as data URLs would make a drawing unsaveable (`413`), and then impossible to reopen; every autosave would also store the whole multi-megabyte JSON as a new git blob.

- A pasted or dropped image is uploaded with `POST /api/attachments` (source = the drawing), and the scene's `files` entry references the attachment's vault path.
- On load, the view fetches each referenced attachment through `/api/files/raw` and hands Excalidraw a data URL in memory only.
- Small embedded data URLs (up to about 256 KB) that come from excalidraw.com files are kept as they are.
- `notes.limits.text-size-overrides.excalidraw` (DESIGN §4.4) stays available for drawings imported with large embedded images, for example 25 MB.
- A size test asserts that a drawing with five 3 MB photos stays under 1 MB of JSON.

**Search and backlinks.** Text elements are indexed, and element `link`s and `[[ ]]` text become backlinks (`DocumentIndexer`).

### 6. Spreadsheets with Google-Sheets-style formulas *(big three a)*

**Status:** built (wave 1)

All three phases are built; DESIGN §6.21 has the design.

- **6a.** The GPL-3.0 licence and generated third-party notices; the `.sheet` format with its validating parser and stable serializer; the HyperFormula engine adapter (cached values, named ranges, multiple sheets, undo and redo, recalculation on an engine change); the cell-level merge; the spreadsheet view on Glide Data Grid (formula bar, A1 headers, range selection, TSV copy and paste, fill, column resizing, frozen rows and columns, bold rows, sheet tabs, named ranges, "New spreadsheet").
- **6b.** `![[Budget.sheet]]`, `![[Budget.sheet#Summary]]` and `![[Budget.sheet#Budget!A1:C10]]` (and named ranges) render through the view's `loadEmbed()` from the cached values, without the engine; a click opens the spreadsheet at that sheet or range. On the server, `SheetDocumentIndexer` (through the `DocumentIndexer` extension point, the same commit as items 4 and 5) indexes cell text and cached values, and `[[Note]]` strings in cells become backlinks.
- **6c.** CSV import (into a new sheet or a new file) and export (the current sheet); number formats per cell, row or column (currency, percent, decimals, dates, custom codes) in the grid and in embeds, and typed input that recognizes them; bar, line and pie charts of a range, stored in the sheet JSON and drawn as plain SVG; xlsx import and export with SheetJS 0.20.3 from cdn.sheetjs.com, pinned by its integrity hash and lazy-loaded.

Deviations, and why:

- HyperFormula is pinned at **3.4.0**, not 3.5.0, because 3.5.0 (published 2026-10-09) is less than two weeks old (same GPL-3.0-only licence; a later upgrade recalculates each sheet once). Glide Data Grid is pinned at **6.0.4-alpha24**, not 6.0.3: 6.0.3 declares React 16 to 18 as peers, and only the 6.0.4 line accepts React 19.
- Glide has no frozen top rows, so frozen rows are drawn in its header: they are edited in the formula bar rather than in place, and a range selection stops at them. On phones a cell is edited in the formula bar (tap a selected cell), and columns are resized with a width dialog as well as by dragging.
- Embeds in **Live Preview**: Live Preview does not render any embeds yet (item 10b). Sheet embeds are built as the view's `loadEmbed()` and handle their own clicks, so they work wherever embeds are hydrated: in the reading view today, and in Live Preview once 10b renders embeds through the same `loadEmbed`.
- Embeds show at most 100 rows and 26 columns (and say so), and an embed of a whole sheet also shows its charts.
- The format goes beyond the spec in three compatible ways, documented in DESIGN §6.21.1: cells take `fmt` (before the row's and the column's); each sheet takes `charts`, keyed by time-ordered ids so charts merge per chart; and a sheet takes `structure`, a marker that changes when rows or columns are inserted or deleted, so a merge never misplaces cells another device added meanwhile. Files without charts or such edits keep their exact earlier layout.
- Rows and columns can be inserted and deleted (references follow, as in Google Sheets); sorting and filtering a range in place are not built yet (the `SORT` and `FILTER` functions are).
- Charts show in a folding pane below the grid rather than floating over it as in Google Sheets; at most eight series (the palette's colours) and 500 categories; a pie folds slices beyond eight into Other.
- Number formats cover Excel's and Google Sheets' codes except conditions (`[>100]`, ignored) and fractions. Typed dates read as ISO (`2026-10-17`) and US (`10/17/2026`) dates.
- Search indexes numbers as the Automatic format writes them (`1937.5`), not in their number format. As for every indexed document, renaming a note does not rewrite `[[links]]` in cells; the move reports the sheet as `not-rewritable`.
- CSV export writes values as they show (`$1,450.00`), as Google Sheets does; importing that back reads the number and its format.
- xlsx: SheetJS Community Edition writes no styles, so only number formats, column widths and row heights carry over; merged cells, comments, frozen panes, charts and sheet-scoped names are not, and imports say what they left out. Sheet names longer than Excel's 31 characters are cut on export, with formulas following.

**One line:** spreadsheet files in the vault, with a fast grid, about 400 Excel-compatible functions (`=SUM`, `=VLOOKUP`, `=IF`, ...), multiple sheets and named ranges, embeddable in notes.

| Value | Effort | Depends on |
|---|---|---|
| H | L | |

**File format.** `*.sheet` is JSON owned by NotesApp: engine-independent, diffable, and able to outlive any library choice.

```json
{
  "type": "notesapp-sheet", "version": 1, "engine": "hyperformula@3.5.0",
  "sheets": [ {
    "id": "s1", "name": "Budget",
    "cells": {
      "A1": { "v": "Item" },  "B1": { "v": "Cost" },
      "A2": { "v": "Rent" },  "B2": { "v": 1450 },
      "B10": { "f": "=SUM(B2:B9)", "c": 1937.5 }
    },
    "cols": { "A": { "w": 180 }, "B": { "w": 110, "fmt": "$#,##0.00" } },
    "rows": { "1": { "bold": true } },
    "frozen": { "rows": 1, "cols": 0 }
  } ],
  "named": { "Total": "Budget!$B$10" }
}
```

| Key | Meaning |
|---|---|
| `v` | Literal value |
| `f` | Formula |
| `c` | **Cached** computed value. It is written on save so embeds, search and previews work without loading the engine. |
| `engine` (top level) | The engine and version that computed the `c` values. When a different engine or version opens the file, it recalculates every formula and rewrites `c`, because function coverage and semantics differ between engines. |

Cells are sparse and keyed by A1 references, so a one-cell edit is a one-line diff.

**Formula engine options.** Licences were checked on npm on 2026-10-16.

| Option | Licence | Assessment |
|---|---|---|
| **HyperFormula 3.5.0** | **GPL-3.0-only**, or a paid commercial licence from Handsontable | The best Excel compatibility: about 400 functions, a dependency graph, named expressions, array formulas, undo/redo and i18n. It is headless, so we bring our own grid. **Licence impact:** using it under GPLv3 means NotesApp must be distributed under GPLv3-compatible terms whenever it is distributed. That is harmless for a personal project; just license the repo GPL-3.0. A private image you only pull yourself is not even a distribution. **Runtime enforcement:** the engine must be created with `licenseKey: 'gpl-v3'`; without it every function returns `#LIC!` and edit methods throw `LicenseCapabilityMissingError`. |
| IronCalc 0.9.0 (`@ironcalc/wasm`) | MIT / Apache-2.0 | A Rust engine compiled to WASM, with xlsx import/export and its own web UI. Permissive, but pre-1.0, with less function coverage and a WASM payload. |
| Univer 1.0.4 (`@univerjs/presets`) | Core `@univerjs/*`: Apache-2.0. Charts, pivot tables, print, edit history and xlsx exchange: `@univerjs-pro/*`, **commercial**; xlsx exchange also needs Univer Server. | A complete Sheets-like product with UI and engine. It is the fastest way to "looks like Google Sheets", but the heaviest bundle, it has its own snapshot model that we would convert to and from `.sheet`, and the features that make it look most like Sheets are in the paid tier. |
| formulajs 4.6.1 | MIT | Function implementations only. We would have to write the parser and dependency graph. Not recommended. |

**Grid UI options.**

| Option | Licence | Notes |
|---|---|---|
| **Glide Data Grid 6.0.3** | MIT | Canvas-rendered, virtualized, custom cells, fast on mobile |
| RevoGrid 4.29.0 | MIT | Web components |
| Handsontable 18.1.2 | Commercial; only a non-commercial key for personal use | Avoid |
| Univer | | Bundled with Univer |
| jspreadsheet CE 5 | | Simpler, DOM-based |

**Recommendation.** Use **HyperFormula with Glide Data Grid** and the `.sheet` format, and license the NotesApp repo under GPL-3.0. If GPL is unacceptable, use IronCalc behind the same `.sheet` format. Choose Univer only if a pixel-perfect Sheets UI matters more than bundle size and owning the UI, and only its Apache-2.0 core.

**Decision needed before 6a or 39a starts,** because item 39 uses the same engine. Licensing the repository under GPL-3.0 is a one-way door for practical purposes, and swapping engines later is not free (the `engine` field forces a recalculation, and results can differ). Please confirm "GPL-3.0 with HyperFormula" or "permissive with IronCalc" explicitly.

**Embedding in notes.**

| Embed | Renders |
|---|---|
| `![[Budget.sheet]]` | The first sheet's used range as a read-only table, from the cached `c` values, without loading the engine |
| `![[Budget.sheet#Summary]]` | A named sheet |
| `![[Budget.sheet#Budget!A1:C10]]` | A range |

Clicking an embed opens the full editor.

**Conflicts.** The descriptor's `merge()` does a cell-level 3-way merge, so a conflict only reaches the banner when the same cell changed on both devices.

**Search and backlinks.** Cell text and cached values are indexed; `[[Note]]` strings in cells become backlinks (`DocumentIndexer`).

**Mobile.** Viewing, tapping to edit a cell, a formula bar, and column resizing.

**Phases.**

- **6a:** format, engine, grid, view, formulas, multiple sheets. With HyperFormula, 6a also includes: `licenseKey: 'gpl-v3'` in the engine config, a GPL-3.0-only `LICENSE` file at the repo root, and a third-party notices file.
- **6b:** embeds and search indexing.
- **6c:** CSV import and export, number formats, basic charts, then xlsx import and export. The xlsx path is **IronCalc**, or SheetJS from `cdn.sheetjs.com` pinned with an integrity hash. Never the npm `xlsx` package: it is frozen at 0.18.x and has published advisories.

---

## The rest of the backlog

### 1. Nightly and off-site backups *(declined for v1)*

**Status:** built (wave 1). A `restic/restic` sidecar and a `backup-scheduler` container (`docker:cli`, with host cron as the documented alternative), off until `COMPOSE_PROFILES` is set; design in DESIGN §7.10, setup, restore and drill in DEPLOY.md *Backups*. Deviations and additions:

- **Consistency by a short nightly stop.** The app is stopped for the local snapshot only (seconds after the first run), because a live copy can capture `refs/` ahead of `objects/` in `.git`. The off-site copy is a `restic copy` of the local snapshots and runs with the app up.
- **Off-site through the S3 API.** Backblaze B2 is reached through its S3-compatible endpoint, which restic recommends over its own B2 backend; Amazon S3 works the same way.
- **Additions:** failure alerts on ntfy, an optional heartbeat URL, a weekly `restic check` with a low-priority "backups OK" report, and CI tests of the scripts against a fake Docker CLI and a real restic.
- **Alerts name the failed steps only.** restic's output names vault files, so it goes to `status.json` (the status page) and the log, never to the ntfy topic, which may be on ntfy.sh.
- **CasaOS: a second paste-in app.** CasaOS has no `.env`, compose profiles or checkout of `deploy/`, so the sidecars are `deploy/casaos-backup-compose.yml`, installed after its setup (docs/CASAOS.md), with bind mounts under `/DATA/AppData/notesapp/backup`; NotesApp itself installs and runs the same without it.

**One line:** automatic nightly snapshots of the `notes-data` volume (vault plus `.git`) and `tailscale-state` to a local disk and to off-site object storage.

| Value | Effort | Depends on |
|---|---|---|
| H | S | |

- **Why first.** v1 keeps the vault and its whole git history on one disk. Git history protects against bad edits; this item protects against losing the disk, a mistaken `rm`, or a deleted volume. It is the recommended first item after v1.
- **Approach:** a `restic/restic` sidecar triggered nightly by a small scheduler container or by host cron. Back up to a USB or second disk on homeserver and to Backblaze B2 or S3. Retention: 7 daily, 4 weekly, 12 monthly. Repository credentials come from compose `secrets:` files, never from the vault.
- **Restore drill:** v1's manual drill in DEPLOY.md is extended to restic and run once after setup.
- **Simpler alternative:** `offen/docker-volume-backup`.

### 2. Mirror the vault's git history to a private GitHub repo

**Status:** built (wave 1). `GitMirror` pushes `HEAD` with JGit over HTTPS, fast-forward only, with the token from the `mirror_token` compose secret (`NOTES_MIRROR_TOKEN_FILE`); off until `NOTES_MIRROR_URL` is set. Design in DESIGN §5.8 *Mirror*, setup and troubleshooting in DEPLOY.md *Mirror to GitHub*, contract in API.md §6.2 and §6.4. Deviations and additions:

- **Delay with a ceiling.** A push comes 10 minutes after the last commit, and at most 1 hour after the first unpushed one, so a long writing session (a commit every 5 minutes) is still mirrored.
- **Diverged means stop, then a manual retry.** When the mirror has commits the vault lacks, pushing stops (`mirror.state: diverged`, a status-bar warning) until **Push history to the mirror now** (`POST /api/mirror/push`, a new endpoint) is used after fixing the repository. Failures back off 1, 5 and 15 minutes, then every 30 minutes, and log `GIT_MIRROR_FAILED` once per streak.
- **The secret is always mounted.** Compose cannot create a container whose secret file is missing, so `mirror_token` defaults to an empty file in git (`deploy/mirror/no-token`) and `NOTES_MIRROR_TOKEN_SECRET` points it at `deploy/secrets/mirror-token` when the mirror is set up; existing deploys need no change.
- **Additions:** `file:` URLs work too (the tests push to a local bare repository); URLs with credentials are refused; the mirror's state is in Settings › About; nothing is pushed at shutdown.
- **A mirror whose settings cannot be used is a problem, not just "off".** An SSH or `http://` URL, or one with a token in it, is refused; the status bar, the ⋯ menu and the status page then warn "Mirror is off: …", and the startup logs `GIT_MIRROR_FAILED`, which raises an app alert.
- **On CasaOS** the token is a file next to the vault, `/DATA/AppData/notesapp/data/secrets/mirror-token` (`NOTES_MIRROR_TOKEN_FILE`), read before every push, and `NOTES_MIRROR_URL` is set in the app's settings; empty by default.

**One line:** push the vault repo to a private GitHub repository, debounced to about 10 minutes after commits, for off-site history you can browse on github.com.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

JGit push over HTTPS with a fine-grained PAT that has `contents: write`, scoped to that one repository and read from a compose `secrets:` file (`NOTES_MIRROR_TOKEN_FILE`). Note that your notes then leave the tailnet; it is opt-in. Nothing secret is ever in the vault (DESIGN §4.1), so the mirror cannot leak a key.

### 3. Rich Markdown pack *(declined for v1; built 2026-10-21)*

**One line:** Obsidian callouts, syntax-highlighted code blocks, KaTeX math and Mermaid diagrams in the reading view, plus editor styling for them.

| Value | Effort | Depends on |
|---|---|---|
| H | M | |

| Feature | Approach |
|---|---|
| Callouts | `> [!note]+ Title` with fold, via a small markdown-it plugin |
| Code highlighting | Reuses the CodeMirror `language-data` grammars through `@lezer/highlight`'s `highlightCode`, so no Prism or Shiki is needed |
| Math | KaTeX 0.19.0 for `$…$` and `$$…$$`, lazy-loaded |
| Mermaid | Mermaid 12.2.0, lazy-loaded, `securityLevel: 'strict'`, SVG sanitized |

(`==highlights==` and hidden `%%comments%%` moved into v1, because they are core Obsidian syntax.)

**Status: built (2026-10-21, branch `feat/rich-markdown`), as designed above.** DESIGN §6.7.1 has the details. What it adds or decides beyond the table:

- **Callouts:** every Obsidian type and alias, `+`/`-` folding (native `<details>`), custom Markdown titles, `[!type|metadata]`, nesting, unknown types in the note style. Obsidian's class names, so CSS snippets carry over.
- **Code:** the editor and the reading view share one token-class table, so code looks the same in both; a Copy button on every fenced block.
- **Math:** `@mdit/plugin-tex` parses (so `$5 and $10` stays text), `$$…$$` inside a paragraph is display math as in Obsidian, and `mhchem` (`\ce{}`) is included. KaTeX `trust` is off.
- **Mermaid:** follows the app theme, shows errors inline, and wide diagrams scroll sideways on the phone. **The ELK layout is left out:** Mermaid 12 defaults to it, but `elkjs` is EPL-2.0 (not GPL-compatible) and 1.4 MB, so diagrams use the dagre layout (as in Obsidian) and `layout: elk` in a diagram is ignored.
- **Editor:** `$math$` and `$$` blocks are styled in source mode, and a callout's title line is bold.
- **No CSP change**, and the initial load grows by only 1.5 kB gzip; KaTeX and Mermaid are chunks loaded on first use.
- **Reuse:** `render/rich/index.ts` exports `parseCalloutHeader`, `renderCallout`, `renderMath`, `renderMermaid` and `highlightCode` for Live Preview (item 10).

### 7. Quick capture inbox and the iPhone Share Sheet

**One line:** capture a thought, link or photo in two taps from anywhere on the iPhone, appended to `Inbox.md` or today's daily note.

| Value | Effort | Depends on |
|---|---|---|
| H | M | |

- Add `POST /api/capture {text, target: "inbox" | "daily", url?, date?, tz?}`.
- **"Today" is decided on the phone**, as everywhere else (DESIGN risk 20). The Shortcut sends `date` already formatted on the phone (`YYYY-MM-DD`), or an IANA `tz` such as `America/New_York`; the server formats the daily-note path from that date with the moment-to-java.time token mapping (DESIGN §6.12). The container's `TZ` is only a fallback when neither is sent; it defaults to UTC, which would pick the wrong day for part of every evening.
- An iOS Shortcut ("Add to Notes") in the Share Sheet calls the endpoint over the tailnet, with an `X-Client-Id` header, whenever Tailscale is connected. The phone is a user-owned device, so it passes the identity allowlist.
- There is also an in-app capture box (palette and mobile "+").

**Status: built 2026-10-21** on `feat/pwa-capture` (DESIGN §6.27, API.md §8.5–8.6). `POST /api/capture` and `POST /api/capture/file` (photos), a capture dialog (`Mod-Shift-Space`, ribbon, palette, drawer, the phone's **+**) and a `/capture` page, an offline capture queue with idempotency keys, a Web Share Target for the installed app (Android, desktop Chrome and Edge), and for the iPhone a Shortcut spelled out in Settings › Quick capture (iOS has no share target for web apps). The inbox is `Inbox.md` at the vault root (a setting can come later).

### 8. Installable PWA and offline mode *(declined for v1)*

**One line:** add it to the iPhone Home Screen as an app; read and edit recently used notes offline and sync on reconnect.

| Value | Effort | Depends on |
|---|---|---|
| H | L | |

- `vite-plugin-pwa` 2.0.0 (MIT): manifest, icons, a Workbox service worker for the app shell, `display: standalone`.
- The tree and recently opened notes are cached in IndexedDB.
- Offline edits are queued with their `baseVersion`. The existing conflict protocol handles them on reconnect; iOS has no background sync, so syncing happens when the app opens.

**Status: built 2026-10-21** on `feat/pwa-capture` (DESIGN §6.26). Manifest, icons (maskable included) and iOS standalone tags; a hand-written service worker instead of vite-plugin-pwa (the update flow is tied to the build check and unsaved edits; DESIGN §6.21 has the reasons) that precaches the shell and every lazy chunk, serves navigations network-first with the cached shell offline, and never caches the API; offline copies of the last 100 opened notes and of the tree in IndexedDB, with a per-device switch; offline edits saved through the ordinary version check (drafts of closed tabs replayed, stale ones shown as the conflict banner); and a deploy hand-over that cannot leave a tab on an old bundle or worker.

### 9. Reminders and push notifications

**One line:** task reminders (item 4) and "daily note" nudges as real phone notifications.

| Value | Effort | Depends on |
|---|---|---|
| H | M | 4; 8 for Web Push |

- **Web Push (VAPID).** iOS requires the PWA installed on iOS 16.4 or later, so this route needs item 8, which you declined for now. The VAPID key pair and the subscriptions are stored in `/data/secrets/push.json`, outside the vault, so they never reach git, the trash or a mirror (DESIGN §4.1). A scheduler sends notifications at reminder times. Message encryption (RFC 8291) uses JDK crypto or a maintained library.
- **ntfy alternative.** The iOS ntfy app, with no PWA needed; it is the fastest route. The privacy trade-off differs by setup:
  - **Self-hosted ntfy on the tailnet:** on iOS, instant notifications require `upstream-base-url: https://ntfy.sh`, so message ids and timing (not the text) pass through ntfy.sh to reach Apple's push service.
  - **ntfy.sh directly:** the reminder text itself leaves the tailnet. Use an unguessable topic and an access token.
- **Decision (2026-10-17): build every route; pick later.** One scheduler fires reminders through a list of delivery channels, each switched on in Settings and all off by default:
  - **in-app**: a toast plus a browser notification in any open tab, using the Notification API with the tailnet origin;
  - **desktop**: native notifications from the item 41 app;
  - **Web Push**: needs the item 8 installed web app on iOS;
  - **ntfy**: self-hosted or ntfy.sh. The topic, server URL and token come from `/data/secrets/ntfy.json`, never from the vault.

  A reminder is marked delivered once at least one channel accepts it, and missed reminders are delivered when the server starts.

### 11. Tabs and split panes *(declined for v1)*

**One line:** open several notes as tabs and view two side by side on desktop.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

- A workspace model, `panes: [{ tabs: [{path, mode}], active }]`, persisted per device.
- `Mod`+click opens a new tab; drag a tab to split.
- Phones keep a single pane with a tab switcher.

### 12. Bookmarks (starred) and a recent-files pane

**Status:** built (wave 2) on `feat/bookmarks`: DESIGN §5.21 and §6.23, API.md §21. Choices beyond this spec, and why:

- **Obsidian's format, Obsidian's types.** Files, headings (and `#^block` references), folders, searches and nested groups, with `ctime` and `title`; Obsidian's `url` and `graph` bookmarks and unknown fields are kept untouched. A vault without `.notesapp/bookmarks.json` shows the bookmarks of `.obsidian/bookmarks.json` until the first change (read only), so a vault moved over from Obsidian keeps them.
- **Bookmarks follow their targets on the server**, like links: a move or rename through the app re-keys them (a folder's bookmark and everything under it too), and a trash restore to another path brings them along. A deleted target leaves its bookmark in place, dimmed, until it comes back; external moves are not followed, as for links.
- **One list, saved whole** with the version protocol, as the settings are; each change is re-applied on top of another device's after a conflict, so neither is lost.
- **Recent files are per device** (they were already kept for the quick switcher), now with the time each was opened, in their own pane; the switcher's empty state marks bookmarked files with a star.
- **On the phone** both panes are drawer tabs, and ⋯ has Bookmark. Headings are starred from the Outline; searches from the search panel or page.

**One line:** star notes, headings and searches, and see recently opened files in a sidebar pane.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

Stored in `.notesapp/bookmarks.json`, in a format compatible with Obsidian's `bookmarks.json` where possible.

### 13. Properties editor

**One line:** an Obsidian-style typed "Properties" UI above the note (text, list, number, checkbox, date, date-time, tags).

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

- Property types are vault-wide, in `.notesapp/types.json`.
- Edits rewrite only the changed YAML nodes, using the `yaml` Document API.

### 14. Calendar view

**One line:** a month or week calendar showing which days have daily notes, task due dates (item 4) and notes with a `date` property. Tap a day to open or create it.

| Value | Effort | Depends on |
|---|---|---|
| M | M | 4 optional |

### 15. Kanban boards

**One line:** drag-and-drop boards.

| Value | Effort | Depends on |
|---|---|---|
| M | M | 4 |

- The primary boards are views over task sections (item 4).
- Optional: read and write the Obsidian Kanban plugin's Markdown format (`kanban-plugin: basic`) for interoperability.

### 16. Graph view *(declined for v1)*

**Status:** built (wave 3, branch `feat/graph-import`). The global graph is the page `/x/graph` (ribbon, drawer, *Open Graph*); the local graph is a right-sidebar panel (*Open local graph*, the phone ⋯ menu and bottom sheet) with a depth of 1 to 5. Filters (search, tags as nodes, attachments, existing files only, orphans, folder, tag), color groups, display (arrows, text fade, node size, link thickness) and forces (center, repel, link force, link distance) follow Obsidian's `graph.json`. Hover highlights a node's neighbours; click or tap opens it; pinch and drag work on the iPhone; live updates arrive through SSE. Design in DESIGN §5.5.12 and §6.28, API in API.md §11.4. Deviations and additions:

- **Renderer: d3-force 3.0.0 (ISC) and an own canvas renderer**, not `force-graph`. The layout runs in a Web Worker, so a 10,000-note graph never blocks the page, and the renderer batches all links and every node color into a handful of canvas calls (about 4 ms per frame at 10,000 notes). It is one lazy chunk.
- **Refreshes are cheap.** `GET /api/graph` has a version that changes only when links, tags or files change, and `?since=` answers "unchanged" with an empty body, so the graph refreshes after every save without moving.
- **Filters match names, paths, aliases and tags, not note text**, with the search grammar (`tag:`, `path:`, `file:`, `-`, phrases). They are instant, and they work on attachments, unresolved links and tags too. A folder and a tag filter are added to Obsidian's.
- **Graph settings are per device** (`localStorage`), like the theme; an imported vault's `.obsidian/graph.json` can be applied from the compatibility report (item 24).
- **Excluded files** (`settings.files.excludedPaths`) are left out of the graph, as in Obsidian.

**One line:** an interactive global and local (1–2 hop) graph of notes and links, filterable by folder and tag.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

`GET /api/graph`, built from the existing `LinkGraph`, rendered with `force-graph` 1.52.0 (MIT, canvas).

### 17. Dataview-style query blocks

**One line:** ```` ```query ```` blocks such as `TABLE due, status FROM #project WHERE status != "done" SORT due`, evaluated on the server over frontmatter, file metadata and tasks, rendered live in the reading view.

| Value | Effort | Depends on |
|---|---|---|
| M | S | 40; 13 helps |

Results update through SSE.

**Update 2026-10-17:** scripts (item 40) cover what this item was for. It shrinks to an optional `query("…")` helper inside scripts, evaluated with the same `notes/query` endpoint, for queries you'd rather write in this style than in JavaScript.

### 18. Ask your vault and summaries, powered by Claude

**One line:** ask questions about your notes and get answers citing them, summarize a note or this week's daily notes, and get suggested links, tags or tasks.

| Value | Effort | Depends on |
|---|---|---|
| H | M | |

- **Approach.** Add `POST /api/ai/ask`, which retrieves the top notes with the existing BM25 search (embeddings come later), then calls the Claude Messages API through the official Java SDK (`com.anthropic:anthropic-java`). The default model is `claude-opus-5-5`, configurable. The answer streams to the browser.
- **Off by default.** The API key comes from a compose `secrets:` file (`ANTHROPIC_API_KEY_FILE`), not from `deploy/.env` and never from the vault.
- **Privacy.** Every request is explicitly user-initiated, because note content leaves the tailnet.

**Status:** built (2026-10-21). Design in DESIGN §5.25 (server) and §6.31 (client), contract in API.md §24, setup in DEPLOY.md *Ask your vault* and CASAOS.md *Ask your vault*. `POST /api/ai/ask` and `POST /api/ai/summarize` stream answers as server-sent events to an *Ask* panel (the bottom sheet on phones and tablets) and the page `/x/ask` (the phone's drawer entry); citations are wikilinks that open the notes. Summaries of the open note, its folder, the editor's selection and this week's daily notes, and suggested links, tags and tasks for a note, from the palette and the panel. Conversations are kept per device. Deviations and additions:

- **Claude Code with your Claude subscription is the default provider**, not the API (your direction, 2026-10-21: no per-token bill). The image ships Anthropic's Claude Code CLI (pinned 2.1.304, about 290 MB per architecture); the server runs it headless once per answer with every tool disabled, a fresh empty home and a clean environment holding only the OAuth token from `claude setup-token` (`/data/secrets/claude-token`, `NOTES_AI_CLAUDE_TOKEN_FILE`). Usage counts against the plan's limits, for personal use. Because Claude Code is proprietary, **the GHCR package should stay private** (CASAOS.md and DEPLOY.md now say so), or the image is built with `CLAUDE_CODE_VERSION=none`.
- **The Anthropic API stays as the second provider** (Settings › Provider), as first specified: `com.anthropic:anthropic-java` 3.0.0, the key in `/data/secrets/anthropic-key` (`NOTES_AI_API_KEY_FILE`, named like the app's other `NOTES_*` settings rather than `ANTHROPIC_API_KEY_FILE`; the plain-compose deploy uses a compose secret, `NOTES_AI_KEY_SECRET`, with `deploy/ai/no-key` as the empty placeholder).
- **The default model is Claude Sonnet 5.5** (`claude-sonnet-5-5`), not Opus (your direction, 2026-10-21). Opus 5.5 and Haiku 5.5 are one setting away.
- **Two locks, not one.** Besides the credential, a vault setting (`settings.ai.enabled`) must be switched on; Settings, the panel's first-use notice and its footer say that note text goes to Anthropic. Credentials are read again when they change, and never logged.
- **Excluded folders** (`settings.ai.excludedPaths`, `Private` by default, plus the search exclusions) are never read; naming one explicitly is refused (`403 ai-excluded`).
- **Caps and a spend guard.** A context cap per request (`maxContextChars`, 60,000 characters by default, history included), 16,000 output tokens on the API, and a monthly budget (`monthlyBudgetUsd`, $5 by default) counted in `.notesapp/cache/ai-usage.json`: what the API bills, or with Claude Code the API value it reports, as a guard against using up the plan; requests are refused once it is reached (`429 ai-budget-exceeded`).
- **Retrieval** ranks the notes containing *any* of the question's words with the index's BM25 (the search endpoint ANDs its words); long notes are cut to their best paragraphs. Embeddings are still for later.
- **Follow-ups use the prompt cache.** Earlier turns come back from the device with their sources and are rebuilt byte for byte, so their notes are read from Anthropic's cache.
- **Refusals** fall back server-side (`fallbacks: "default"`) on Sonnet and Opus through the API.
- **Development** runs with `notes.ai.fake=true`: canned answers that cite the retrieved notes, without a key or the network.

### 19. Web clipper

**One line:** save a web page as a clean Markdown note (title, source URL, date, readable body) from the desktop browser or the iPhone Share Sheet.

| Value | Effort | Depends on |
|---|---|---|
| M | M | 7 |

- **The client fetches the page, not the server.** The desktop bookmarklet sends the page's own HTML, and the iPhone Share Sheet passes the page content. The app's network namespace routes `100.64.0.0/10`, so a server-side fetch of a user-supplied URL (or of any redirect it follows) could reach the app itself on `127.0.0.1:8080`, tailscaled on `127.0.0.1:9002`, every tailnet device, and the home LAN, and the response would then be saved and rendered as a note.
- If a server-side fetch is ever needed (for example for a URL-only share), it goes through a guarded HTTP client: it resolves DNS itself; rejects loopback, RFC 1918, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`, `::1` and `100.100.100.100`; re-checks the address on every redirect hop; allows only `http` and `https` on ports 80 and 443; caps responses at about 10 MB; and has a timeout. The v1 policy rule that `tag:notes` has no grants as a source is the second layer.
- Readability extraction: Mozilla Readability 0.6.0 (Apache-2.0) in the browser.
- HTML to Markdown with turndown 7.2.4 (MIT).
- The note is saved to `Clippings/` and rendered with the v1 reading-view sanitizer (no forms, no fixed positioning, optional click-to-load remote images).

### 20. Block references and block embeds

**One line:** `[[Note#^` autocomplete, automatic `^id` generation, `![[Note#^id]]` transclusion, and highlighting of the target block on navigation.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

### 21. Update heading links when a heading is renamed

**Status:** built (with item 12, on `feat/bookmarks`): DESIGN §5.22 and §6.24, API.md §22. Typing a new heading text offers, once the text rests, to update the links that pointed at the old one (the offer counts them with a dry run, and says nothing when there are none); **Rename heading and update links to it…** in the palette does it on purpose. Every link form follows (wiki with display or as an embed, nested `#H1#H2`, markdown with a percent-encoded or angle-bracket destination, same-note `[[#H]]`, frontmatter), only the subpath is rewritten, heading bookmarks follow too, and the rewrite is one commit, like a move's link update.

**One line:** when you change a heading's text, offer to update every `[[Note#Old heading]]` across the vault. Obsidian does not do this.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

### 22. Search upgrades

**One line:** a richer search language and wider coverage.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

- `OR` and parentheses, `/regex/`, and `line:` and `section:` operators.
- Saved searches and typo tolerance.
- Text from PDFs (Apache PDFBox), `.sheet` and `.excalidraw` files.

**Status: built (2026-10-21, branch `feat/search`).** API.md §12, DESIGN §5.5.10 and §6.4.1.

- The grammar has `OR`, parentheses, `/regex/` (also as `file:`, `path:` and `tag:` values), `line:(…)` and `section:(…)`; the client parses it the same way to highlight hits.
- Regular expressions are safe: at most 500 characters, one 2 s budget per query enforced while the engine reads the text (catastrophic backtracking ends in a clear `400`), at most two such queries at once, and never under the index lock. Search p95 on the 10k-note perf vault stays under 100 ms with the new forms included.
- Typo tolerance: a word that is not in the index matches words one or two edits away (never short words or numbers); the panel says so and offers "Exact words only".
- Saved searches live in `.notesapp/searches.json`, so they sync to every device and have history; the panel lists them when the field is empty.
- PDF text is extracted with PDFBox 3.0.8 (Apache-2.0) in the background, within size, page, character and time limits, cached in `.notesapp/cache/search-text/`, and hits open the PDF at the matching page.
- `.sheet` and `.excalidraw` text is indexed by the `DocumentIndexer` of items 5 and 6 (their branches), not here.

### 23. Large-attachment policy for git history

**Status:** built (wave 1). Files over `notes.git.large-file-threshold` (`NOTES_GIT_LARGE_FILE_THRESHOLD`, 25 MB by default, 0 turns it off) are listed in a managed section of `.git/info/exclude`, rebuilt from the index at startup and before every commit; a tracked file that crosses the threshold is untracked (`Stop versioning …`) before anything is staged, so no large version ever becomes a git object. `/api/status` reports `git.largeFiles` (threshold, count, bytes) next to the repository size (`disk.repoBytes`), and the History panel explains why such a file has no new versions. Design in DESIGN §4.6 and §5.8 *Large files*, operations in DEPLOY.md *Large files*. Deviations and additions:

- **The replaced version goes to the trash.** Git cannot bring back a version it never stored, so a raw overwrite or a history restore of a large file first keeps the current file in the trash (a hard link where the filesystem has them, so nothing is copied). Restore it from the Trash page like any deleted file.
- **Existing repositories are brought in line at startup.** The bootstrap commit stops tracking large files an imported or older repository still tracks; versions already committed stay (history is never rewritten).
- **Repository size** was already in `/api/status` as `disk.repoBytes` (measured by the rescan); it is now also in Settings › About.
- **Hidden files are covered too.** The index never sees dot-files, dot-folders or names such as `*.part`, so the server also walks the disk (the whole tree at startup and in the bootstrap commit, the staged folders in a commit) and keeps such files out as well; `/api/status` still counts only the files the app shows.
- **The threshold cannot be below the text limit** (`notes.limits.max-text-size`, 5 MB): text saves keep no copy of the version they replace, which is safe only while every note the app saves is versioned, so a lower threshold stops the app at startup with an explanation.

**One line:** keep files above a configurable size (for example 25 MB) out of git history so the repo stays small. They stay in the vault and in backups (item 1).

| Value | Effort | Depends on |
|---|---|---|
| M | S | 1 |

A managed section of `info/exclude` holds the exclusions, and `/api/status` shows the repo size.

### 24. Obsidian vault import and compatibility kit

**Status:** built (wave 3, branch `feat/graph-import`). Copy the vault into the data folder before the first start (DEPLOY.md and CASAOS.md *Import an Obsidian vault*, over SSH or CasaOS's Files app); the first start takes its settings from `.obsidian/` (attachment folder, new notes, link format, excluded files, line breaks, default view, daily notes, templates), and `/x/compat`, the **Compatibility report** (ribbon, drawer, palette, Settings › About), lists what does not carry over. Design in DESIGN §5.23 and §6.29, API in API.md §11.5. Deviations and additions:

- **The report is a page with actions, not a file.** Each Obsidian setting is shown next to NotesApp's; *Apply Obsidian's settings* saves them on an installation that already had settings, and *Use them on this device* takes `graph.json`'s graph settings (item 16). Plugins are listed with what NotesApp offers instead and the roadmap item that adds it.
- **Findings go beyond syntax**: links to missing files, headings and `^blocks` (and, as information, notes that do not exist yet), notes NotesApp cannot read (frontmatter, UTF-8, size, skipped names), Excalidraw files, canvases and bases. Each finding lists up to 200 places, each opening the note at its line. Code is never reported.
- **Seeding happens once.** Only a vault without `.notesapp/settings.json` takes Obsidian's settings; afterwards the report proposes them. Unusable values (a regular expression in *Excluded files*, a nested attachment subfolder) are reported, not applied.
- **`.obsidian/` is never written**, stays hidden from the app, and is versioned except `workspace*.json`, so the same vault keeps working in Obsidian.
- **For the integrator:** the callout, Mermaid and math findings (item 3), block references (item 20), Dataview (items 17 and 40) and the plugin table (`ObsidianPlugins`) describe this branch's renderer; drop or update them as those items merge.

**One line:** importing an existing Obsidian vault seeds NotesApp settings from `.obsidian/` (`app.json`, `daily-notes.json`, `templates.json`) and produces a compatibility report listing the syntax and plugins NotesApp does not render yet.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

`.obsidian/` stays untouched, so the vault remains usable in Obsidian.

### 25. Canvas (JSON Canvas)

**One line:** an infinite canvas of cards, notes, images, groups and arrows, using Obsidian's open JSON Canvas 1.0 `.canvas` format, so it is interoperable with Obsidian.

| Value | Effort | Depends on |
|---|---|---|
| M | L | |

Plugs into the view registry. `.canvas` is already a text kind.

**Status:** built (wave 3). Design in DESIGN §6.8.2 (the view) and §5.5.13 (indexing, through the `DocumentIndexer` of §6.8), contract in API.md §1.8, §11 and §12. What it does:

- **Board.** Text cards (Markdown rendered like the reading view, edited inline with `[[` and `#` completion), file nodes (notes as transclusions, images, audio and video, nested canvases, other files), web links (address and Open: the CSP does not allow embedding other sites), groups with labels, colours and background images, and edges with sides, arrows, labels and colours.
- **Editing.** Pan and zoom (wheel, trackpad, pinch), selection box and multi-select, drag (groups carry their contents, 20 px grid), resize, connect (dropping on empty space makes a connected card), delete, undo and redo, copy, cut, paste and duplicate as JSON Canvas, convert a card to a note, open files and links, drag and drop from the explorer and the OS, menus on right click and long press, palette commands. iPhone: pinch, one-finger pan, double tap to edit (the keyboard opens), long press for menus.
- **Files.** Byte-stable: an unchanged file is written back exactly, and an edit rewrites only the lines of the nodes it touched in the file's own layout (Obsidian's by default), keeping fields this app does not know.
- **Sync.** Autosave, drafts, history and conflicts through the document session; edits from two devices merge node by node (the banner shows only when both changed the same card's content).
- **Elsewhere.** `![[Board.canvas]]` shows a scaled preview; search finds cards; notes on a canvas list it among their backlinks (the `DocumentIndexer` extension point, shared with item 5).
- **Moves.** The server rewrites a canvas's links after a move (card links and file nodes, replacing only those JSON strings); an open canvas also follows moves its tab saw and offers to relink a missing file.

### 26. Publish a note publicly through Tailscale Funnel *(built 2026-10-21, switched off)*

**One line:** share a read-only page for chosen notes with people outside the tailnet, without exposing the app.

| Value | Effort | Depends on |
|---|---|---|
| M | M | 3 helps |

**Decision (2026-10-17): build it switched off.** The publish server only starts when `NOTES_PUBLISH_ENABLED=true`. The shipped `serve.json` has no Funnel entry; DEPLOY.md documents the opt-in `serve.json` change. Nothing is public until you do both.

- **The public site is a separate, minimal server**, not a second connector. In Spring Boot an extra Tomcat connector serves the same servlet context, so every controller, all of `/api/**` and the SPA would answer on it too; built that way, this item would publish unauthenticated read and write access to the whole vault to the internet. Instead:
  - a small, separate HTTP server (a JDK `HttpServer`, or a child Spring context with its own `DispatcherServlet` and only the publish controller) binds `127.0.0.1:8081` and serves only `GET`/`HEAD` on `/p/<slug>` and its static assets, with 404 for everything else;
  - it serves **pre-rendered HTML snapshots** of the notes listed in `.notesapp/publish.json`, written when you publish, never live vault reads;
  - the main app keeps its v1 identity allowlist, and additionally rejects any request on 8080 that carries `Tailscale-Funnel-Request`.
- `serve.json` adds `:8443` → `127.0.0.1:8081` with `AllowFunnel` true for that port only. `:443` stays tailnet-only.
- Integration tests request `/api/tree`, `/api/files?path=…`, `/n/x` and `/` on 8081 and expect 404.
- Prerequisite: the v1 identity and Host allowlists (DESIGN §5.13) are in place.

**Status: built 2026-10-21** on `feat/publish` (DESIGN §5.28, API.md §26), switched off: `NOTES_PUBLISH_ENABLED` defaults to `false` in the app, `docker-compose.yml`, `.env.example` and `casaos-compose.yml`, and the shipped `serve.json` has no Funnel entry; `deploy/tailscale/serve.funnel.json.example` (CasaOS: `NOTES_PUBLISH_FUNNEL`) is the opt-in, documented in DEPLOY.md and CASAOS.md "Public publishing". The publish server is a JDK `HttpServer` on `127.0.0.1:8081` that serves only snapshots listed in `.notesapp/publish.json` (stored outside the vault in `/data/publish`), `404` for everything else; the app answers `403 funnel-request` to anything carrying `Tailscale-Funnel-Request`. Snapshots are rendered on the server (commonmark-java) with no app JavaScript and a CSP without scripts: frontmatter, comments, raw HTML and vault queries are left out, links to unpublished notes become plain text without their folder, and only the attachments the note embeds are copied. Publish, republish (title, address) and unpublish from the note header, the ⋯ menu or the palette, and a list in Settings › Publishing. The integration tests request `/api/tree`, `/api/files?path=…`, `/n/x`, `/`, unreferenced attachments, `.notesapp` and `.git` paths (escaped and dot-segment variants too) on the publish server and get `404`. Not yet: math and Mermaid show as source on public pages; a snapshot links to another published note only if that note was published first (republish to update).

### 27. Per-note encryption

**One line:** encrypt sensitive notes in the browser with a passphrase. The server and git only ever see ciphertext.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

- WebCrypto AES-GCM-256, with the key derived by PBKDF2-SHA256 (600k iterations) or Argon2id (WASM).
- Encrypted notes are not searchable.
- Interoperability with the Obsidian Meld Encrypt plugin is to be evaluated.

### 28. Vault-wide timeline and restoring deleted files from git

**One line:** a global history view (all commits, filtered by path, author or date), diffs between any two versions, "what changed this week", and restoring files deleted long ago straight from git, even after the trash was emptied.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

**Status: built (2026-10-21, branch `feat/search`).** API.md §14.6–14.8, DESIGN §5.8 and §6.11.1.

- The **Vault history** page (`/x/history`, in the ribbon and linked from the History panel) has three tabs: the timeline of every commit with its files, filtered by path, author and period; **Changes**, the net change over a period ("This week" by default) with a start-to-end diff per file; and **Deleted files**, which previews and restores files from git even after the trash was emptied.
- The version view's **Compare with** diffs any two versions of a file.
- The deleted-files list is computed from the whole history once, then only from new commits.

### 29. Customizable hotkeys and per-device preferences

**Status:** built (with items 12 and 21, on `feat/bookmarks`): DESIGN §6.25. Settings has a **Hotkeys** section listing every command with its key on this device: change (record the next key), remove, reset, reset all, and a filter. A key another command uses can be taken over (that command loses it); keys the browser keeps (`Ctrl+T`, `Ctrl+W`, …) and editing keys (`Ctrl+Z`, `Ctrl+C`, …) are refused. Chosen keys work everywhere, in the editor too, and an editor default (`Ctrl+B`, `Ctrl+S`, …) steps aside once its command has another key. The palette, ribbon and header tooltips show each device's keys. The other per-device preferences (theme, spell check, autocorrect, remote images) were already kept per device; recent files and collapsed bookmark groups now are too (item 12).

**One line:** rebind any command, with conflict detection. Bindings are stored per device.

| Value | Effort | Depends on |
|---|---|---|
| L | S | |

### 30. Templates v2

**One line:** templates applied automatically by folder, `{{prompt:Question}}` placeholders, `{{cursor}}` placement, and a "new note from template" picker in each folder's menu. There are no arbitrary-JavaScript templates.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

### 31. Slash commands and editor niceties

**One line:** small editing aids.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

- A `/` menu: heading, table, callout, template, date, attachment.
- Table editing helpers.
- Pasting a URL creates `[title](url)` with the fetched title.
- Smart list continuation and renumbering.
- Heading folding.

### 32. PDF viewer (PDF.js)

**Status:** built (wave 3). PDF.js (`pdfjs-dist` 6.4.299, Apache-2.0) renders PDFs in the app: lazy chunks, the worker and its data files self-hosted under `/assets/pdfjs-<version>/`, page thumbnails, find (Mod-F) with every match highlighted, zoom presets, pinch zoom on the phone and Ctrl+wheel on the PC, selectable text, `[[file.pdf#page=N]]` links and "Copy link to current PDF page", and `![[file.pdf#page=3]]` embeds of the same viewer. Design in DESIGN §6.8.3. Deviations and additions:

- **The CSP gained `'wasm-unsafe-eval'`** (DESIGN §5.14): PDF.js decodes JPEG 2000 and JBIG2 scans and ICC colours with WebAssembly, and falls back to much slower JavaScript without it. It allows no JavaScript `eval`. It also lets Excalidraw's SVG export subset its fonts (item 5).
- **Dark pages.** In the dark theme the pages are inverted with their hues kept, as drawings are; one tap (or a palette command) turns it off on the device, for photo-heavy PDFs.
- **The page is remembered** per device: reopening a PDF continues where it was read last, unless a link names a page.
- **Ranges only.** A PDF is read in the 64 KiB ranges the shown pages need, not downloaded whole first, which matters for large scans on the phone.
- **Password-protected PDFs** open after a masked password prompt.
- **Embeds load lazily**, when they come near the screen, and keep Obsidian's `#page=` and `#height=` (600 px by default).
- **Not built:** annotations (as planned). PDF text in vault search came with item 22; a hit opens this viewer at its page.

**One line:** consistent in-app PDF rendering on iOS, where iframes show only the first page, with page links (`#page=N`) and search. Annotations come later.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

### 33. Voice notes with transcription

**Status:** built (wave 3). **Record voice note** (palette, and the microphone on the phone's editing toolbar) records with MediaRecorder (AAC in MP4 on the iPhone and where Chrome can, else Opus in WebM or Ogg), saves `Recording <date>.<ext>` as an attachment and embeds it at the cursor; it plays inline. Transcription is an optional sidecar, off by default: whisper-asr-webservice (faster-whisper, MIT) as the `whisper` service of `deploy/docker-compose.yml` (profile `transcription`) or the second CasaOS app `deploy/casaos-whisper-compose.yml`, enabled with `NOTES_TRANSCRIPTION_URL`; the transcript goes under the embed as a quote, so search finds it. Design in DESIGN §5.24 and §6.30, API in API.md §23, setup in DEPLOY.md *Voice notes* and CASAOS.md *Voice note transcription*. Deviations and additions:

- **Two protocols.** Besides the sidecar's, any OpenAI-compatible `/v1/audio/transcriptions` server works (`NOTES_TRANSCRIPTION_API=openai`: whisper.cpp's server, speaches, LocalAI, or OpenAI itself with a key in a file under `/data/secrets/`, never in the vault or an environment variable).
- **The client writes the transcript**, not the server: the place is an upload widget that follows edits made while recording and transcribing, so the server never edits a note behind the user's back and no conflict arises. The server keeps the last transcripts in memory, so a phone that slept through the answer retries for free.
- **Transcribe recording on this line** (palette) transcribes older recordings, or ones made before the service existed; a failed transcription has a Retry.
- **Per-device switch** for transcripts (Settings › This device and the recording panel).
- **A WebM recording plays as audio**: `.webm` is a video kind, so its embed switches to an audio player once it shows no picture.
- **The microphone is allowed for the app only** (`Permissions-Policy: microphone=(self)`), as planned.

**One line:** record audio in the app on the iPhone (MediaRecorder) as an attachment, and optionally transcribe it with a local Whisper service on homeserver. The transcript is appended under the embed.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

Needs `Permissions-Policy: microphone=(self)`.

### 34. Flashcards and spaced repetition

**Status:** built (wave 3). Cards are read from notes in the Spaced Repetition plugin's syntax (`Q::A`, `Q:::A`, `?` and `??` paragraphs, `==cloze==` deletions with `^[hints]` and numbered groups; decks from `#flashcards` tags, deck lines and question-specific tags, or from folders) and scheduled with FSRS (`ts-fsrs` 5.4.2, MIT). `/x/flashcards` has the decks with today's counts, a phone-first review session with keyboard shortcuts, statistics and settings (DESIGN §5.34, §6.34; API.md §34). Deviations and additions:

- **Nothing is written into notes.** A card is identified by a hash of its question, and its answers live in `.notesapp/srs.json` as the ROADMAP said: a set of answers per card (the truth) and the FSRS state computed from them (a cache, kept only while it covers every answer). Two devices reviewing at once both keep their answers, and a retry is stored once. An edited question keeps its history when the new text is close to the old one in the same note; the records of deleted cards can be pruned from the statistics page.
- **The plugin's `<!--SR:…-->` schedules are ignored**, not imported: they are SM-2 numbers. Cards they follow start as new.
- **Settings** (tags, folder decks, daily limits, desired retention, maximum interval, learning steps, fuzz, the hour a day starts) live in the same file and change field by field.
- **Offline answers** wait in an outbox in `localStorage` and are sent when the server is back.
- **Left for later:** cramming (studying cards that are not due), sibling burying across days, Anki-style `{{c1::…}}` clozes, `**bold**` clozes, and optimizing the FSRS weights from the review history.

**One line:** review cards written in notes (Obsidian Spaced Repetition plugin syntax: `Q::A`, `?` blocks, `#flashcards`) with FSRS scheduling.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

Scheduling uses `ts-fsrs` 5.4.2 (MIT). Review state is stored in `.notesapp/srs.json`.

### 35. Habit tracker

**Status:** built (wave 3), on daily-note properties (the "13" of "4 or 13"), without tasks. A habit is a note in `Habits/` or tagged `#habit`; its check-ins are the `entries` list in its frontmatter, the format of Obsidian's Habit Tracker 21 plugin (`title`, `color` and `maxGap` too), and a daily note checks a habit in with a property such as `exercise: true`. `/x/habits` has one-tap check-ins for today, the last week to check in late, streaks, a 30-day rate and calendar heatmaps for each habit and for all of them; the Habits panel checks in from the daily note in view (DESIGN §5.35, §6.35; API.md §35). Deviations and additions:

- **Schedules:** every day, weekdays, weekends, chosen days, or N times a week (streaks then count weeks), with Habit Tracker 21's `maxGap` gap tolerance.
- **Edits touch only the property they change**, through an open note's session when there is one, and re-apply after a version conflict. Live sync is the notes' own `file.*` events.
- **Tasks later:** a habit note may name a recurring task (item 4) whose completions would count as check-ins; not built.
- **Left for later:** rendering Habit Tracker 21's `habittracker` code block in notes (it needs a code-block renderer in the reading view), goals for quantities (today any number above 0, such as `water: 6`, counts as done; a goal of 8 would not be met), and reminders (item 9).

**One line:** track habits as recurring tasks (item 4) or as daily-note properties (`exercise: true`), with streaks and a heatmap, and one-tap check-off on the phone.

| Value | Effort | Depends on |
|---|---|---|
| L | M | 4 or 13 |

### 36. Vim mode

**One line:** a desktop-only, per-device toggle using `@replit/codemirror-vim` 6.4.0 (MIT).

| Value | Effort | Depends on |
|---|---|---|
| L | S | |

### 37. Multiple vaults

**One line:** several independent vaults (for example Personal and Work), each with its own index, git repo and watcher, a vault switcher, and URLs of the form `/v/<vault>/n/...`.

| Value | Effort | Depends on |
|---|---|---|
| M | L | |

### 38. Ops polish

**Status:** built (wave 1). The image runs on `eclipse-temurin:25-jre-noble` with an AOT cache from a training run at build time (DESIGN §7.1). The app pushes its stable ERROR markers to ntfy itself (`ops/AppAlerts`, DESIGN §5.18.1), configured in `/data/secrets/ntfy.json`, the file item 9 will share. The status page is `/x/status`, registered with `registerPage` (DESIGN §6.18.1), backed by `GET /api/status/details` and `POST /api/alerts/test` (API.md §6.5 and §6.6). Setup and troubleshooting are in DEPLOY.md *App alerts*. Deviations and additions:

- **Compiled for Java 21, run on 25.** The source level stays at `--release 21` because the development machine has only JDK 21; a new `backend-jdk25` CI job runs every backend test on JDK 25, and `publish` waits for it.
- **The AOT training run stops at context refresh** (`-Dspring.context.exit=onRefresh`), so it covers the startup path, not request handling. It must run on the target architecture: natively a failure fails the build, while under QEMU (arm64) the image ships without the cache rather than blocking the weekly security rebuild. JGit's classes are not cached because its jar is signed. Not measured on JDK 25 here (Docker is not installed on the development machine); a JDK 21 CDS proxy of the same run halved the context's start.
- **curl is installed** in the runtime image: the JDK 25 Temurin images no longer ship it, and the `HEALTHCHECK` (which the nightly backup waits on) and the restore drill need it.
- **Alerts carry fixed texts, never the log message,** so no path, error text or note content leaves the server. A marker is sent at most once an hour (repeats are summed up in one follow-up) and at most 10 alerts an hour in all.
- **Additions:** *Send a test alert* on the status page; an alert after a Tailscale watchdog restart, sent by the restarted app because the exiting one has no network; the backup state mounted read-only into the app (`NOTES_BACKUP_STATE` for host cron) so the status page shows the last backup; the markers logged since start, counted even without ntfy; and `registerPage`'s command now closes the phone drawer, which the first registered page showed staying open, and the phone and tablet top bar shows a registered page's title.

**One line:** a JDK 25 runtime image (no virtual-thread pinning, AOT cache for faster start), ntfy alerts for app errors (the v1 ERROR markers pushed directly, not only through logs), and an in-app status page. Watchtower notifications, the `/readyz` probe and Dependabot are already in v1.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

### 41. Desktop app with live sync *(new, 2026-10-17)*

**One line:** a Windows and macOS app for NotesApp, with its own window, a tray icon, a quick-capture hotkey and native notifications. It shows the same live-synced vault as the browser.

| Value | Effort | Depends on |
|---|---|---|
| M | M | 7 for quick capture; 8 for offline |

- **Electron**, in a new `desktop/` folder. rgpc has no Rust toolchain, which Tauri would need, while Electron only needs npm.
- **A thin shell around the server.** It loads the configured server URL (asked on first launch; for example `https://notes.<tailnet>.ts.net`) and bundles no copy of the frontend. Every deploy therefore updates the desktop UI too, and live sync is the same SSE stream the browser uses. After sleep or resume, or when the network changes, it reconnects.
- **Identity.** Requests come from the computer's tailnet address, so the v1 Tailscale identity and Host allowlists work unchanged. The app stores no tokens.
- **Security.**
  - Renderer settings: `contextIsolation` on, `sandbox` on, `nodeIntegration` off.
  - A preload script exposes only a small `notesDesktop` API: notifications, the capture hotkey and the app version.
  - Navigation is locked to the server's origin; other links open in the default browser.
  - Permission requests are denied, except notifications.
- **Features.**
  - The window position and size are remembered.
  - A tray menu: Quick capture, Open today's note, Quit.
  - A global hotkey (default `Ctrl+Shift+Space`, `Cmd+Shift+Space` on macOS) opens a small capture window that posts to `/api/capture` (item 7).
  - Native notifications are a reminder delivery route (item 9).
  - Launch at login (opt-in).
  - Connection state is shown in the window title.
  - Offline, it shows the service worker's cached app (item 8), or a "Can't reach the server. Is Tailscale connected?" page with Retry.
- **Packaging.** electron-builder produces a Windows NSIS installer and an unsigned macOS dmg. A GitHub Actions workflow builds them on `desktop-v*` tags and attaches them to a release in the private repository. There is no auto-updater: the shell rarely changes, because the UI comes from the server.

---

## Explicitly not planned

- **Obsidian Sync protocol compatibility.** Proprietary. Your devices sync through this server instead.
- **Running Obsidian community plugins.** Different runtime. The popular ones are covered natively above: Excalidraw, Kanban, Tasks, Dataview and Spaced Repetition.
- **Multi-user accounts.** The tailnet is the security boundary. Sharing with another tailnet user works through Tailscale device sharing **plus** adding their login to `NOTES_IDENTITY_ALLOWED_LOGINS`, with history recording the correct author.
- **Exposing the app to the public internet.** Only item 26's separate, read-only publish server ever goes through Funnel.
