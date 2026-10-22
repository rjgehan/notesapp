package com.rjgehan.notes.index;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.NoteTask;
import com.rjgehan.notes.api.dto.NotesQueryResponse;
import com.rjgehan.notes.api.dto.QueriedNote;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * {@code GET /api/notes/query} (ROADMAP items 40 and 17, API.md §40.1): the metadata of many notes at once, read from
 * the in-memory index, for scripts in notes ({@code notes()}, {@code query()}). Read-only; excluded paths never
 * match; the answer is capped. Filters combine with AND.
 */
@Service
public class NoteQueryService {

	public static final int DEFAULT_LIMIT = 500;

	public static final int MAX_LIMIT = 2000;

	static final int MAX_FILTERS = 10;

	static final int MAX_FILTER_LENGTH = 200;

	/** At most this many tasks per note are returned. */
	static final int MAX_TASKS = 500;

	private static final Pattern TASK = Pattern.compile("^\\s*(?:>\\s?)*\\s*(?:[-+*]|\\d{1,9}[.)])\\s+\\[(.)\\]\\s+(.*)$");

	private static final Pattern FENCE = Pattern.compile("^\\s{0,3}(`{3,}|~{3,})");

	private final VaultIndex index;

	private final FileKinds kinds;

	private final SettingsService settings;

	private final SearchService search;

	public NoteQueryService(VaultIndex index, FileKinds kinds, SettingsService settings, SearchService search) {
		this.index = index;
		this.kinds = kinds;
		this.settings = settings;
		this.search = search;
	}

	/** A property filter: {@code name} (present, not empty), {@code name=value} or {@code name!=value}. */
	record PropFilter(String name, @Nullable String value, boolean negated) {

		static PropFilter parse(String raw) {
			int not = raw.indexOf("!=");
			int eq = raw.indexOf('=');
			if (not > 0 && not < eq) {
				return new PropFilter(raw.substring(0, not).strip(), raw.substring(not + 2).strip(), true);
			}
			if (eq > 0) {
				return new PropFilter(raw.substring(0, eq).strip(), raw.substring(eq + 1).strip(), false);
			}
			if (raw.isBlank() || eq == 0 || not == 0) {
				throw NotesException.badRequest("prop must be name, name=value or name!=value");
			}
			return new PropFilter(raw.strip(), null, false);
		}

		boolean matches(@Nullable Map<String, @Nullable Object> data) {
			Object found = null;
			boolean present = false;
			if (data != null) {
				for (Map.Entry<String, @Nullable Object> e : data.entrySet()) {
					if (e.getKey().equalsIgnoreCase(this.name)) {
						found = e.getValue();
						present = true;
						break;
					}
				}
			}
			if (this.value == null) {
				return present && !isEmpty(found);
			}
			boolean equal = present && valueMatches(found, this.value);
			return this.negated ? !equal : equal;
		}

		private static boolean isEmpty(@Nullable Object value) {
			return value == null || (value instanceof String s && s.isBlank())
					|| (value instanceof List<?> l && l.isEmpty()) || (value instanceof Map<?, ?> m && m.isEmpty());
		}

		private static boolean valueMatches(@Nullable Object found, String wanted) {
			if (found instanceof List<?> list) {
				for (Object item : list) {
					if (valueMatches(item, wanted)) {
						return true;
					}
				}
				return false;
			}
			String text = (found == null) ? "" : String.valueOf(found);
			// A link property (`"[[Note]]"`) matches its target too.
			String bare = text.startsWith("[[") && text.endsWith("]]") ? text.substring(2, text.length() - 2) : text;
			return text.equalsIgnoreCase(wanted) || bare.equalsIgnoreCase(wanted);
		}

	}

	/** {@code GET /api/notes/query}. */
	public NotesQueryResponse query(@Nullable String path, List<String> tags, @Nullable String folder,
			List<String> props, @Nullable String linksTo, @Nullable String q, boolean withTasks, int limit) {
		if (limit < 1 || limit > MAX_LIMIT) {
			throw NotesException.badRequest("limit must be between 1 and " + MAX_LIMIT);
		}
		if (tags.size() + props.size() > MAX_FILTERS) {
			throw NotesException.badRequest("at most " + MAX_FILTERS + " tag and prop filters");
		}
		for (String value : concat(tags, props, folder, linksTo)) {
			if (value.length() > MAX_FILTER_LENGTH) {
				throw NotesException.badRequest("filters must be at most " + MAX_FILTER_LENGTH + " characters");
			}
		}
		List<PropFilter> propFilters = props.stream().map(PropFilter::parse).toList();
		String prefix = folderPrefix(folder);
		Set<String> allowed = null;
		if (path != null && !path.isBlank()) {
			// One note, by its exact path (`note()` in a script).
			allowed = new HashSet<>(Set.of(path.strip()));
		}
		for (String tag : tags) {
			String name = tag.strip();
			if (name.startsWith("#")) {
				name = name.substring(1);
			}
			if (name.isEmpty()) {
				throw NotesException.badRequest("tag must not be empty");
			}
			allowed = intersect(allowed, this.index.notesWithTag(name, true));
		}
		if (linksTo != null && !linksTo.isBlank()) {
			String target = linksTo.strip();
			String resolved = (this.index.file(target) != null) ? target : this.index.resolveLink(target, "");
			allowed = intersect(allowed, (resolved == null) ? Set.of() : this.index.backlinkSources(resolved));
		}
		if (q != null && !q.isBlank()) {
			allowed = intersect(allowed, new HashSet<>(this.search.matchingPaths(q)));
		}
		FilesSettings files = this.settings.current().files();
		List<QueriedNote> out = new ArrayList<>();
		int total = 0;
		for (VaultIndex.NoteView view : this.index.noteViews()) {
			NoteRecord note = view.note();
			String notePath = note.path();
			if ((allowed != null && !allowed.contains(notePath)) || (prefix != null && !notePath.startsWith(prefix))
					|| files.isExcluded(notePath) || this.kinds.kindOf(notePath) != FileKind.NOTE) {
				continue;
			}
			Frontmatter frontmatter = note.parse().frontmatter();
			Map<String, @Nullable Object> data = (frontmatter != null) ? frontmatter.data() : null;
			if (!propFilters.stream().allMatch((f) -> f.matches(data))) {
				continue;
			}
			total++;
			if (out.size() >= limit) {
				continue;
			}
			FileRecord file = this.index.file(notePath);
			Set<String> links = new LinkedHashSet<>();
			for (LinkGraph.Resolved link : view.links()) {
				if (link.target() != null) {
					links.add(link.target());
				}
			}
			out.add(new QueriedNote(notePath, PathNames.basenameOf(PathNames.nameOf(notePath)), note.parse().aliases(),
					note.parse().distinctTags(), data, (file != null) ? file.mtime() : Instant.EPOCH,
					(file != null) ? file.size() : note.text().length(), List.copyOf(links),
					withTasks ? tasks(note.text()) : null));
		}
		return new NotesQueryResponse(out, total, total > out.size());
	}

	/** The checkbox tasks of a note's text, outside code fences. */
	static List<NoteTask> tasks(String text) {
		List<NoteTask> out = new ArrayList<>();
		String[] lines = text.split("\n", -1);
		String fence = null;
		for (int i = 0; i < lines.length && out.size() < MAX_TASKS; i++) {
			String line = lines[i].endsWith("\r") ? lines[i].substring(0, lines[i].length() - 1) : lines[i];
			Matcher f = FENCE.matcher(line);
			if (f.find()) {
				String marker = f.group(1);
				if (fence == null) {
					fence = marker;
				}
				else if (marker.charAt(0) == fence.charAt(0) && marker.length() >= fence.length()) {
					fence = null;
				}
				continue;
			}
			if (fence != null) {
				continue;
			}
			Matcher m = TASK.matcher(line);
			if (m.matches()) {
				String status = m.group(1);
				out.add(new NoteTask(i, status, status.equalsIgnoreCase("x"), m.group(2).strip()));
			}
		}
		return out;
	}

	/** {@code folder} as a path prefix ({@code Projects/}), or null for the whole vault. */
	private static @Nullable String folderPrefix(@Nullable String folder) {
		if (folder == null) {
			return null;
		}
		String f = folder.strip();
		while (f.startsWith("/")) {
			f = f.substring(1);
		}
		while (f.endsWith("/")) {
			f = f.substring(0, f.length() - 1);
		}
		return f.isEmpty() ? null : f + "/";
	}

	private static Set<String> intersect(@Nullable Set<String> current, Set<String> more) {
		if (current == null) {
			return new HashSet<>(more);
		}
		current.retainAll(more);
		return current;
	}

	private static List<String> concat(List<String> a, List<String> b, @Nullable String c, @Nullable String d) {
		List<String> all = new ArrayList<>(a);
		all.addAll(b);
		all.add(Objects.requireNonNullElse(c, ""));
		all.add(Objects.requireNonNullElse(d, ""));
		return all;
	}

}
