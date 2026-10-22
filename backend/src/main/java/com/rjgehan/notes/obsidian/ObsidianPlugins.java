package com.rjgehan.notes.obsidian;

import java.util.Map;

import com.rjgehan.notes.api.dto.CompatPlugin;
import com.rjgehan.notes.api.dto.CompatPlugin.Kind;
import com.rjgehan.notes.api.dto.CompatPlugin.Support;
import org.jspecify.annotations.Nullable;

/**
 * What NotesApp offers in place of Obsidian's core plugins and the most common community plugins (ROADMAP item 24).
 * Roadmap items that change an answer update this table.
 */
final class ObsidianPlugins {

	private ObsidianPlugins() {
	}

	/** A known plugin: its display name, NotesApp's support, a short note and the roadmap item that adds it. */
	record Known(String name, Support support, String note, @Nullable Integer item) {
	}

	private static Known k(String name, Support support, String note) {
		return new Known(name, support, note, null);
	}

	private static Known k(String name, Support support, String note, int item) {
		return new Known(name, support, note, item);
	}

	static final Map<String, Known> CORE = Map.ofEntries(
			Map.entry("file-explorer", k("Files", Support.SUPPORTED, "The file explorer.")),
			Map.entry("global-search", k("Search", Support.SUPPORTED, "Full-text search with tag:, path:, file:, line:, section:, OR and regular expressions, typo tolerance and the text of PDFs; searches can be saved.")),
			Map.entry("switcher", k("Quick switcher", Support.SUPPORTED, "Mod-O, with aliases and recent files.")),
			Map.entry("graph", k("Graph view", Support.SUPPORTED, "Global and local graph, with filters and groups.")),
			Map.entry("backlink", k("Backlinks", Support.SUPPORTED, "Linked and unlinked mentions.")),
			Map.entry("canvas", k("Canvas", Support.SUPPORTED, "Canvases open as boards in the same JSON Canvas format; search, backlinks and moves include them.")),
			Map.entry("outgoing-link", k("Outgoing links", Support.PARTIAL, "The local graph shows a note's outgoing links; there is no outgoing-links panel.")),
			Map.entry("tag-pane", k("Tags", Support.SUPPORTED, "The tags panel, with nested tags.")),
			Map.entry("properties", k("Properties view", Support.PARTIAL, "The reading view shows properties; a properties editor is planned.", 13)),
			Map.entry("page-preview", k("Page preview", Support.UNSUPPORTED, "Links do not show a preview on hover.")),
			Map.entry("daily-notes", k("Daily notes", Support.SUPPORTED, "Same formats; the settings are imported.")),
			Map.entry("templates", k("Templates", Support.SUPPORTED, "{{title}}, {{date}} and {{time}}; the settings are imported.")),
			Map.entry("note-composer", k("Note composer", Support.UNSUPPORTED, "Merging and splitting notes is not offered.")),
			Map.entry("command-palette", k("Command palette", Support.SUPPORTED, "Mod-P.")),
			Map.entry("slash-command", k("Slash commands", Support.PLANNED, "Use the command palette meanwhile.", 31)),
			Map.entry("editor-status", k("Editor status", Support.SUPPORTED, "The status bar.")),
			Map.entry("bookmarks", k("Bookmarks", Support.SUPPORTED, "Obsidian's bookmarks.json is shown until the first change; NotesApp then keeps its own copy in the same format.")),
			Map.entry("markdown-importer", k("Format converter", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("zk-prefixer", k("Unique note creator", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("random-note", k("Random note", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("outline", k("Outline", Support.SUPPORTED, "The outline panel.")),
			Map.entry("word-count", k("Word count", Support.SUPPORTED, "In the status bar.")),
			Map.entry("slides", k("Slides", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("audio-recorder", k("Audio recorder", Support.SUPPORTED, "Record voice note records into the open note and embeds the recording; an optional server transcribes it.")),
			Map.entry("workspaces", k("Workspaces", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("file-recovery", k("File recovery", Support.SUPPORTED, "Version history keeps every saved version in git.")),
			Map.entry("publish", k("Publish", Support.PLANNED, "Publishing a note through Tailscale Funnel is planned.", 26)),
			Map.entry("sync", k("Sync", Support.SUPPORTED, "Not needed: every device edits the same vault on the server.")),
			Map.entry("webviewer", k("Web viewer", Support.UNSUPPORTED, "Web links open in the browser.")),
			Map.entry("footnotes", k("Footnotes view", Support.PARTIAL, "Footnotes render; there is no footnotes panel.")),
			Map.entry("bases", k("Bases", Support.UNSUPPORTED, ".base files are listed but not shown as tables.")));

	static final Map<String, Known> COMMUNITY = Map.ofEntries(
			Map.entry("dataview", k("Dataview", Support.PARTIAL, "```dataview queries run with a subset of the query language: TABLE, LIST and TASK with FROM (tags, a folder, a link), WHERE, SORT and LIMIT. ```dataviewjs and inline queries show as code; a ```script block does what dataviewjs does, in a sandbox.")),
			Map.entry("templater-obsidian", k("Templater", Support.UNSUPPORTED, "<% %> commands stay as text; core {{date}} and {{title}} placeholders work.")),
			Map.entry("obsidian-excalidraw-plugin", k("Excalidraw", Support.PARTIAL, ".excalidraw and .excalidraw.md drawings open in Excalidraw and sync; embedded notes, LaTeX and PDF pages show as static images.")),
			Map.entry("obsidian-kanban", k("Kanban", Support.PARTIAL, "Notes with kanban-plugin in their properties open as boards: drag cards between lanes, edit cards, add, rename and reorder lanes, archive; the file stays in the plugin's format and its settings block is kept as is. The plugin's settings, date picker and lane options are not offered.")),
			Map.entry("obsidian-tasks-plugin", k("Tasks", Support.PARTIAL, "Checkboxes work, and Convert checkbox to task brings a line's emoji dates and priorities into a structured task; task queries are not interpreted.")),
			Map.entry("calendar", k("Calendar", Support.PLANNED, "A calendar view is planned; daily notes work.", 14)),
			Map.entry("obsidian-git", k("Git", Support.SUPPORTED, "Not needed: NotesApp keeps the vault's history in git itself. Turn the plugin off for this vault.")),
			Map.entry("periodic-notes", k("Periodic Notes", Support.PARTIAL, "Daily notes work; weekly and monthly notes are not created.")),
			Map.entry("obsidian-admonition", k("Admonition", Support.UNSUPPORTED, "ad- blocks show as code blocks; Obsidian callouts replace them.")),
			Map.entry("quickadd", k("QuickAdd", Support.PARTIAL, "Quick capture appends to Inbox.md or today's note from anywhere; macros and templates of QuickAdd are not offered.")),
			Map.entry("omnisearch", k("Omnisearch", Support.SUPPORTED, "Full-text search is built in.")),
			Map.entry("meld-encrypt", k("Meld Encrypt", Support.SUPPORTED, "Encrypted .mdenc notes and inline encrypted sections open in the browser with their passphrase, in the plugin's current format; they are never searched or sent to Ask your vault.", 27)),
			Map.entry("table-editor-obsidian", k("Advanced Tables", Support.PARTIAL, "Tables render; editing them as a grid is planned.", 10)),
			Map.entry("obsidian-outliner", k("Outliner", Support.PARTIAL, "Tab and Shift-Tab indent list items; outline folding is not offered.")),
			Map.entry("obsidian-style-settings", k("Style Settings", Support.UNSUPPORTED, "Themes and CSS snippets are not used.")),
			Map.entry("obsidian-minimal-settings", k("Minimal Theme Settings", Support.UNSUPPORTED, "Themes and CSS snippets are not used.")),
			Map.entry("obsidian-hider", k("Hider", Support.UNSUPPORTED, "Themes and CSS snippets are not used.")),
			Map.entry("obsidian-spaced-repetition", k("Spaced Repetition", Support.PARTIAL, "Cards in the plugin's syntax and its tag decks work on the Flashcards page, scheduled with FSRS; the plugin's <!--SR:...--> review dates are not imported, so cards start as new.", 34)),
			Map.entry("obsidian-reminder-plugin", k("Reminder", Support.PLANNED, "Reminders are planned.", 9)),
			Map.entry("obsidian-linter", k("Linter", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("obsidian-icon-folder", k("Iconize", Support.UNSUPPORTED, "Folder icons are not shown.")),
			Map.entry("nldates-obsidian", k("Natural Language Dates", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("obsidian-day-planner", k("Day Planner", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("homepage", k("Homepage", Support.PARTIAL, "Settings › Daily notes can open today's note at startup.")),
			Map.entry("remotely-save", k("Remotely Save", Support.SUPPORTED, "Not needed: every device edits the same vault on the server.")),
			Map.entry("obsidian-livesync", k("Self-hosted LiveSync", Support.SUPPORTED, "Not needed: every device edits the same vault on the server.")),
			Map.entry("editing-toolbar", k("Editing Toolbar", Support.PARTIAL, "The phone toolbar covers the basics.")),
			Map.entry("cmdr", k("Commander", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("breadcrumbs", k("Breadcrumbs", Support.UNSUPPORTED, "Not offered.")),
			Map.entry("juggl", k("Juggl", Support.PARTIAL, "The graph view covers the common uses.")),
			Map.entry("obsidian-checklist-plugin", k("Checklist", Support.UNSUPPORTED, "Structured to-dos are planned.", 4)),
			Map.entry("obsidian-full-calendar", k("Full Calendar", Support.PLANNED, "A calendar view is planned.", 14)),
			Map.entry("obsidian-latex", k("Extended MathJax", Support.PLANNED, "Math rendering is planned.", 3)),
			Map.entry("mysnippets-plugin", k("MySnippets", Support.UNSUPPORTED, "CSS snippets are not used.")));

	static String knownName(String id) {
		Known known = COMMUNITY.get(id);
		return (known != null) ? known.name() : id;
	}

	static CompatPlugin core(String id) {
		Known known = CORE.get(id);
		if (known == null) {
			return new CompatPlugin(id, id, Kind.CORE, Support.UNKNOWN,
					"A core plugin this version of NotesApp does not know.", null);
		}
		return new CompatPlugin(id, known.name(), Kind.CORE, known.support(), known.note(), known.item());
	}

	static CompatPlugin community(String id, String name) {
		Known known = COMMUNITY.get(id);
		if (known == null) {
			return new CompatPlugin(id, name, Kind.COMMUNITY, Support.UNKNOWN,
					"NotesApp does not run Obsidian plugins; anything this one adds to notes shows as plain text.",
					null);
		}
		return new CompatPlugin(id, name, Kind.COMMUNITY, known.support(), known.note(), known.item());
	}

}
