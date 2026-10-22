package com.rjgehan.notes.obsidian;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.CompatIssue;
import com.rjgehan.notes.api.dto.CompatIssue.Category;
import com.rjgehan.notes.api.dto.CompatIssue.Severity;
import com.rjgehan.notes.api.dto.CompatOccurrence;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.SkippedEntry;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.HeadingOcc;
import com.rjgehan.notes.index.LinkGraph;
import com.rjgehan.notes.index.LinkOcc;
import com.rjgehan.notes.index.NoteRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * The findings of the compatibility report (ROADMAP item 24, DESIGN §5.23): syntax NotesApp does not render yet,
 * links that lead nowhere, and files it cannot use. Pure: it works on a snapshot of the index, outside its lock.
 * Roadmap items that add rendering remove their rule here.
 */
public final class CompatScanner {

	static final int MAX_OCCURRENCES = 200;

	private static final int MAX_TEXT = 160;

	/** Every finding, in the order the report lists them. */
	enum Rule {

		// ---------- syntax ----------
		DATAVIEW("dataview", Category.SYNTAX, Severity.WARNING, "Dataview queries",
				"```dataview and ```dataviewjs blocks and inline `= …` queries show as code, not as results.", 40),
		TASKS_QUERY("tasks-query", Category.SYNTAX, Severity.WARNING, "Tasks plugin queries",
				"```tasks blocks show as code. Checkboxes work, and Convert checkbox to task turns one into a structured task.",
				null),
		SEARCH_QUERY("search-query", Category.SYNTAX, Severity.WARNING, "Embedded searches",
				"```query blocks show as code, not as search results.", null),
		PLUGIN_BLOCKS("plugin-blocks", Category.SYNTAX, Severity.WARNING, "Other plugin code blocks",
				"Blocks such as ```chart, ```button, ```timeline or ```ad-note (Admonition) show as code.", null),
		TEMPLATER("templater", Category.SYNTAX, Severity.WARNING, "Templater commands",
				"<% … %> commands are not run: templates insert them as text. Core {{date}} and {{title}} work.", null),
		OBSIDIAN_URIS("obsidian-uris", Category.SYNTAX, Severity.INFO, "obsidian:// links",
				"Links that open the Obsidian app work only on devices where Obsidian is installed.", null),
		HTML_REMOVED("html-removed", Category.SYNTAX, Severity.INFO, "Embedded HTML that is removed",
				"<iframe>, <script>, <style>, <form> and similar tags are removed by the reading view's sanitizer.",
				null),
		KANBAN("kanban", Category.SYNTAX, Severity.WARNING, "Kanban boards",
				"Notes with kanban-plugin in their properties show as Markdown lists.", 15),

		// ---------- links ----------
		MISSING_FILES("missing-files", Category.LINKS, Severity.WARNING, "Embeds and file links that lead nowhere",
				"The embedded note or the linked attachment is not in the vault.", null),
		MISSING_HEADINGS("missing-headings", Category.LINKS, Severity.WARNING, "Links to headings that do not exist",
				"The note exists, but not the heading: the link opens the note at the top.", null),
		MISSING_BLOCKS("missing-blocks", Category.LINKS, Severity.WARNING, "Links to blocks that do not exist",
				"The note exists, but no line ends with that ^block-id.", null),
		MISSING_NOTES("missing-notes", Category.LINKS, Severity.INFO, "Links to notes that do not exist yet",
				"As in Obsidian, following such a link creates the note.", null),

		// ---------- files ----------
		SKIPPED("skipped", Category.FILES, Severity.ERROR, "Files NotesApp cannot show",
				"Names with a backslash or a control character, or two names that differ only in Unicode normalization. "
						+ "Rename them over SSH.",
				null),
		TOO_LARGE("too-large", Category.FILES, Severity.WARNING, "Notes too large to edit",
				"Notes over the text size limit can be downloaded but not edited, searched or linked from.", null),
		NOT_UTF8("not-utf8", Category.FILES, Severity.WARNING, "Notes that are not valid UTF-8",
				"They open read-only, so the damaged characters are never written back.", null),
		FRONTMATTER("frontmatter", Category.FILES, Severity.WARNING, "Properties NotesApp cannot read",
				"The YAML between the --- lines does not parse: aliases and tags there are ignored.", null),
		EXCALIDRAW("excalidraw", Category.FILES, Severity.INFO, "Excalidraw notes without the drawing name",
				"Notes with excalidraw-plugin in their properties open as drawings when their name ends in .excalidraw.md; "
						+ "these show as Markdown. Rename them to open them as drawings.",
				null),
		CANVAS("canvas", Category.FILES, Severity.INFO, "Canvases",
				"Supported: .canvas files open as boards, where cards, notes, images, groups and arrows can be edited; "
						+ "search, backlinks and moves include them.",
				null),
		BASES("bases", Category.FILES, Severity.INFO, "Bases", ".base files are listed but not shown as tables.", null);

		final String id;

		final Category category;

		final Severity severity;

		final String title;

		final String detail;

		final @Nullable Integer item;

		Rule(String id, Category category, Severity severity, String title, String detail, @Nullable Integer item) {
			this.id = id;
			this.category = category;
			this.severity = severity;
			this.title = title;
			this.detail = detail;
			this.item = item;
		}

	}

	private static final Pattern FENCE = Pattern.compile("^ {0,3}(`{3,}|~{3,})\\s*([^\\s`{]*)");

	private static final Pattern TEMPLATER = Pattern.compile("<%[\\s\\S]*?%>");

	private static final Pattern OBSIDIAN_URI = Pattern.compile("obsidian://[^\\s)\\]>\"']*");

	private static final Pattern HTML = Pattern
		.compile("<(iframe|script|style|form|button|textarea|select|object|embed)\\b", Pattern.CASE_INSENSITIVE);

	private static final Pattern DATAVIEW_INLINE = Pattern.compile("`\\$?=[^`\\n]+`");

	private static final Set<String> PLUGIN_LANGUAGES = Set.of("chart", "button", "buttons", "timeline", "leaflet",
			"tracker", "contributiongraph", "mindmap", "markmap", "kanban", "excalidraw", "meta-bind",
			"meta-bind-button", "tasks-calendar", "habittracker", "gallery", "embed", "music-abc", "abc", "plantuml");

	private final Map<Rule, Collector> collectors = new EnumMap<>(Rule.class);

	private final Map<String, NoteRecord> notesByPath = new HashMap<>();

	private CompatScanner() {
	}

	/** Scans the notes, files and skipped entries of a vault and returns its findings, the empty ones left out. */
	public static List<CompatIssue> scan(List<VaultIndex.NoteView> notes, List<FileRecord> files,
			List<SkippedEntry> skipped, Kinds kinds) {
		CompatScanner scanner = new CompatScanner();
		for (VaultIndex.NoteView view : notes) {
			scanner.notesByPath.put(view.note().path(), view.note());
		}
		for (VaultIndex.NoteView view : notes) {
			scanner.scanText(view.note());
			scanner.scanLinks(view, kinds);
		}
		for (FileRecord file : files) {
			scanner.scanFile(file);
		}
		for (SkippedEntry entry : skipped) {
			scanner.add(Rule.SKIPPED, entry.name(), null,
					entry.name() + " (" + entry.reason().name().toLowerCase(Locale.ROOT).replace('_', '-') + ")");
		}
		List<CompatIssue> issues = new ArrayList<>();
		for (Rule rule : Rule.values()) {
			Collector c = scanner.collectors.get(rule);
			if (c != null) {
				issues.add(new CompatIssue(rule.id, rule.category, rule.severity, rule.title, rule.detail, rule.item,
						c.count, c.paths.size(), c.occurrences, c.count > c.occurrences.size()));
			}
		}
		return issues;
	}

	/** The file kind of a link target (the server's configured extensions). */
	@FunctionalInterface
	public interface Kinds {

		FileKind kindOf(String path);

	}

	private static final class Collector {

		int count;

		final Set<String> paths = new LinkedHashSet<>();

		final List<CompatOccurrence> occurrences = new ArrayList<>();

	}

	private void add(Rule rule, String path, @Nullable Integer line, String text) {
		Collector c = this.collectors.computeIfAbsent(rule, (r) -> new Collector());
		c.count++;
		c.paths.add(path);
		if (c.occurrences.size() < MAX_OCCURRENCES) {
			c.occurrences.add(new CompatOccurrence(path, line, clip(text)));
		}
	}

	private static String clip(String text) {
		String t = text.strip();
		return (t.length() > MAX_TEXT) ? t.substring(0, MAX_TEXT - 1) + "…" : t;
	}

	// ---------- note text ----------

	private void scanText(NoteRecord note) {
		String path = note.path();
		String text = note.text();
		var parse = note.parse();
		if (parse.frontmatter() != null) {
			Map<String, @Nullable Object> data = parse.frontmatter().data();
			if (data != null && data.containsKey("kanban-plugin")) {
				add(Rule.KANBAN, path, 0, "kanban-plugin: " + data.get("kanban-plugin"));
			}
			if (data != null && data.containsKey("excalidraw-plugin") && !isExcalidrawName(path)) {
				add(Rule.EXCALIDRAW, path, 0, "excalidraw-plugin: " + data.get("excalidraw-plugin"));
			}
		}
		if (parse.frontmatterError() != null) {
			add(Rule.FRONTMATTER, path, 0, parse.frontmatterError());
		}
		if (parse.lossy()) {
			add(Rule.NOT_UTF8, path, null, PathNames.nameOf(path));
		}
		int bodyStart = (parse.frontmatter() != null) ? parse.frontmatter().closingLine() + 1 : 0;
		String[] lines = text.split("\n", -1);
		char fenceChar = 0;
		int fenceLength = 0;
		boolean mathBlock = false;
		for (int i = bodyStart; i < lines.length; i++) {
			String line = lines[i].endsWith("\r") ? lines[i].substring(0, lines[i].length() - 1) : lines[i];
			Matcher fence = FENCE.matcher(line);
			if (fenceChar != 0) {
				if (fence.find() && fence.group(1).charAt(0) == fenceChar && fence.group(1).length() >= fenceLength
						&& fence.group(2).isEmpty()) {
					fenceChar = 0;
				}
				continue;
			}
			if (fence.find()) {
				fenceChar = fence.group(1).charAt(0);
				fenceLength = fence.group(1).length();
				fencedBlock(path, i, line, fence.group(2).toLowerCase(Locale.ROOT));
				continue;
			}
			String trimmed = line.strip();
			// Math renders (ROADMAP item 3); its blocks are skipped so that their content is not read as prose.
			if (trimmed.startsWith("$")) {
				// "$x$" on one line opens and closes.
				boolean closesOnSameLine = trimmed.length() > 2 && trimmed.endsWith("$$");
				if (!closesOnSameLine) {
					mathBlock = !mathBlock;
				}
				continue;
			}
			if (mathBlock) {
				continue;
			}
			String prose = stripCodeSpans(line);
			if (DATAVIEW_INLINE.matcher(line).find()) {
				add(Rule.DATAVIEW, path, i, line);
			}
			// A command over several lines counts once, where it starts.
			if (TEMPLATER.matcher(prose).find() || prose.contains("<%")) {
				add(Rule.TEMPLATER, path, i, line);
			}
			if (OBSIDIAN_URI.matcher(prose).find()) {
				add(Rule.OBSIDIAN_URIS, path, i, line);
			}
			if (HTML.matcher(prose).find()) {
				add(Rule.HTML_REMOVED, path, i, line);
			}
		}
	}

	private void fencedBlock(String path, int line, String text, String language) {
		if (language.isEmpty()) {
			return;
		}
		switch (language) {
			case "dataview", "dataviewjs" -> add(Rule.DATAVIEW, path, line, text);
			case "tasks" -> add(Rule.TASKS_QUERY, path, line, text);
			case "query" -> add(Rule.SEARCH_QUERY, path, line, text);
			// Mermaid and math blocks render (ROADMAP item 3).
			case "mermaid", "math", "latex" -> {
			}
			default -> {
				if (language.startsWith("ad-") || PLUGIN_LANGUAGES.contains(language)) {
					add(Rule.PLUGIN_BLOCKS, path, line, text);
				}
			}
		}
	}

	/** {@code line} with every `code span` blanked, so code that shows such syntax is not reported. */
	static String stripCodeSpans(String line) {
		if (line.indexOf('`') < 0) {
			return line;
		}
		StringBuilder out = new StringBuilder(line.length());
		int i = 0;
		while (i < line.length()) {
			char c = line.charAt(i);
			if (c != '`') {
				out.append(c);
				i++;
				continue;
			}
			int run = 0;
			while (i + run < line.length() && line.charAt(i + run) == '`') {
				run++;
			}
			String ticks = "`".repeat(run);
			int close = line.indexOf(ticks, i + run);
			if (close < 0) {
				out.append(ticks);
				i += run;
				continue;
			}
			out.append(" ".repeat(close + run - i));
			i = close + run;
		}
		return out.toString();
	}

	// ---------- links ----------

	private void scanLinks(VaultIndex.NoteView view, Kinds kinds) {
		String source = view.note().path();
		for (LinkGraph.Resolved resolved : view.links()) {
			LinkOcc occ = resolved.occ();
			String subpath = occ.subpath();
			// Block references render since ROADMAP item 20; only those whose block is missing are findings.
			boolean block = subpath != null && lastSegment(subpath).startsWith("^");
			if (resolved.target() == null) {
				FileKind kind = kinds.kindOf(occ.target());
				boolean note = kind == FileKind.NOTE || kind == FileKind.OTHER;
				add((occ.embed() || !note) ? Rule.MISSING_FILES : Rule.MISSING_NOTES, source, occ.line(), occ.raw());
				continue;
			}
			if (subpath == null || subpath.isBlank()) {
				continue;
			}
			NoteRecord target = this.notesByPath.get(resolved.target());
			if (target == null) {
				continue;
			}
			String wanted = lastSegment(subpath);
			if (block) {
				String id = wanted.substring(1);
				boolean found = target.parse().blockIds().stream().anyMatch((b) -> b.equalsIgnoreCase(id));
				if (!found && !id.isEmpty()) {
					add(Rule.MISSING_BLOCKS, source, occ.line(), occ.raw());
				}
			}
			else if (!hasHeading(target.parse().headings(), wanted)) {
				add(Rule.MISSING_HEADINGS, source, occ.line(), occ.raw());
			}
		}
	}

	private static String lastSegment(String subpath) {
		int hash = subpath.lastIndexOf('#');
		return ((hash < 0) ? subpath : subpath.substring(hash + 1)).strip();
	}

	/** Heading matching as the client does it (DESIGN §6.4): case-insensitive, whitespace collapsed. */
	static boolean hasHeading(List<HeadingOcc> headings, String wanted) {
		String key = normalize(wanted);
		if (key.isEmpty()) {
			return true;
		}
		for (HeadingOcc heading : headings) {
			if (normalize(heading.text()).equals(key)) {
				return true;
			}
		}
		return false;
	}

	private static String normalize(String text) {
		return text.replaceAll("\\s+", " ").strip().toLowerCase(Locale.ROOT);
	}

	// ---------- files ----------

	private void scanFile(FileRecord file) {
		String path = file.path();
		String lower = path.toLowerCase(Locale.ROOT);
		if (file.kind() == FileKind.NOTE && file.version() == null) {
			add(Rule.TOO_LARGE, path, null, PathNames.nameOf(path) + " (" + (file.size() / (1024 * 1024)) + " MB)");
		}
		// .excalidraw and .excalidraw.md drawings open in the drawing editor (ROADMAP item 5).
		if (lower.endsWith(".canvas")) {
			add(Rule.CANVAS, path, null, PathNames.nameOf(path));
		}
		else if (lower.endsWith(".base")) {
			add(Rule.BASES, path, null, PathNames.nameOf(path));
		}
	}

	private static boolean isExcalidrawName(String path) {
		String lower = path.toLowerCase(Locale.ROOT);
		return lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md");
	}

}
