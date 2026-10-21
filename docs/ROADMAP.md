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
| 3 | Rich Markdown pack: callouts, code highlighting, math, Mermaid *(declined for v1)* | H | M | |
| 4 | **Structured to-do tracking, not Markdown** *(big three c)* | H | L | (9 for reminders) |
| 5 | **Excalidraw drawings** *(big three b)* | H | M | |
| 6 | **Spreadsheets with Google-Sheets-style formulas** *(big three a)* | H | L | |
| 7 | Quick capture inbox and the iPhone Share Sheet | H | M | |
| 8 | Installable PWA and offline mode *(declined for v1)* | H | L | |
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
| 26 | Publish a note publicly through Tailscale Funnel | M | M | 3 helps |
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

**One line:** automatic nightly snapshots of the `notes-data` volume (vault plus `.git`) and `tailscale-state` to a local disk and to off-site object storage.

| Value | Effort | Depends on |
|---|---|---|
| H | S | |

- **Why first.** v1 keeps the vault and its whole git history on one disk. Git history protects against bad edits; this item protects against losing the disk, a mistaken `rm`, or a deleted volume. It is the recommended first item after v1.
- **Approach:** a `restic/restic` sidecar triggered nightly by a small scheduler container or by host cron. Back up to a USB or second disk on homeserver and to Backblaze B2 or S3. Retention: 7 daily, 4 weekly, 12 monthly. Repository credentials come from compose `secrets:` files, never from the vault.
- **Restore drill:** v1's manual drill in DEPLOY.md is extended to restic and run once after setup.
- **Simpler alternative:** `offen/docker-volume-backup`.

### 2. Mirror the vault's git history to a private GitHub repo

**One line:** push the vault repo to a private GitHub repository, debounced to about 10 minutes after commits, for off-site history you can browse on github.com.

| Value | Effort | Depends on |
|---|---|---|
| M | S | |

JGit push over HTTPS with a fine-grained PAT that has `contents: write`, scoped to that one repository and read from a compose `secrets:` file (`NOTES_MIRROR_TOKEN_FILE`). Note that your notes then leave the tailnet; it is opt-in. Nothing secret is ever in the vault (DESIGN §4.1), so the mirror cannot leak a key.

### 3. Rich Markdown pack *(declined for v1)*

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

### 7. Quick capture inbox and the iPhone Share Sheet

**One line:** capture a thought, link or photo in two taps from anywhere on the iPhone, appended to `Inbox.md` or today's daily note.

| Value | Effort | Depends on |
|---|---|---|
| H | M | |

- Add `POST /api/capture {text, target: "inbox" | "daily", url?, date?, tz?}`.
- **"Today" is decided on the phone**, as everywhere else (DESIGN risk 20). The Shortcut sends `date` already formatted on the phone (`YYYY-MM-DD`), or an IANA `tz` such as `America/New_York`; the server formats the daily-note path from that date with the moment-to-java.time token mapping (DESIGN §6.12). The container's `TZ` is only a fallback when neither is sent; it defaults to UTC, which would pick the wrong day for part of every evening.
- An iOS Shortcut ("Add to Notes") in the Share Sheet calls the endpoint over the tailnet, with an `X-Client-Id` header, whenever Tailscale is connected. The phone is a user-owned device, so it passes the identity allowlist.
- There is also an in-app capture box (palette and mobile "+").

### 8. Installable PWA and offline mode *(declined for v1)*

**One line:** add it to the iPhone Home Screen as an app; read and edit recently used notes offline and sync on reconnect.

| Value | Effort | Depends on |
|---|---|---|
| H | L | |

- `vite-plugin-pwa` 2.0.0 (MIT): manifest, icons, a Workbox service worker for the app shell, `display: standalone`.
- The tree and recently opened notes are cached in IndexedDB.
- Offline edits are queued with their `baseVersion`. The existing conflict protocol handles them on reconnect; iOS has no background sync, so syncing happens when the app opens.

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

### 23. Large-attachment policy for git history

**One line:** keep files above a configurable size (for example 25 MB) out of git history so the repo stays small. They stay in the vault and in backups (item 1).

| Value | Effort | Depends on |
|---|---|---|
| M | S | 1 |

A managed section of `info/exclude` holds the exclusions, and `/api/status` shows the repo size.

### 24. Obsidian vault import and compatibility kit

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

### 26. Publish a note publicly through Tailscale Funnel

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

### 29. Customizable hotkeys and per-device preferences

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

**One line:** consistent in-app PDF rendering on iOS, where iframes show only the first page, with page links (`#page=N`) and search. Annotations come later.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

### 33. Voice notes with transcription

**One line:** record audio in the app on the iPhone (MediaRecorder) as an attachment, and optionally transcribe it with a local Whisper service on homeserver. The transcript is appended under the embed.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

Needs `Permissions-Policy: microphone=(self)`.

### 34. Flashcards and spaced repetition

**One line:** review cards written in notes (Obsidian Spaced Repetition plugin syntax: `Q::A`, `?` blocks, `#flashcards`) with FSRS scheduling.

| Value | Effort | Depends on |
|---|---|---|
| M | M | |

Scheduling uses `ts-fsrs` 5.4.2 (MIT). Review state is stored in `.notesapp/srs.json`.

### 35. Habit tracker

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
