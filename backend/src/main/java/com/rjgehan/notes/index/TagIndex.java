package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.vault.PathNames;

/**
 * Tag to notes, display casing and nested totals (DESIGN §5.5.11). Keys are lower-cased; the display form is the
 * first casing seen. Not thread-safe: {@link VaultIndex} guards it.
 */
public final class TagIndex {

	/**
	 * One row of {@code GET /api/tags}: {@code count} notes with exactly this tag, {@code total} distinct notes with it
	 * or any descendant.
	 */
	public record TagStat(String tag, int count, int total) {
	}

	private static final class TagInfo {

		final String display;

		final Set<String> notes = new HashSet<>();

		TagInfo(String display) {
			this.display = display;
		}

	}

	private final Map<String, TagInfo> tags = new HashMap<>();

	private final Map<String, Set<String>> noteTags = new HashMap<>();

	/** Replaces a note's tags (any casing; duplicates ignored). */
	public void setNote(String path, List<String> tagNames) {
		removeNote(path);
		Set<String> keys = new HashSet<>();
		for (String tag : tagNames) {
			String key = PathNames.lower(tag);
			if (keys.add(key)) {
				this.tags.computeIfAbsent(key, (k) -> new TagInfo(tag)).notes.add(path);
			}
		}
		if (!keys.isEmpty()) {
			this.noteTags.put(path, keys);
		}
	}

	public void removeNote(String path) {
		Set<String> keys = this.noteTags.remove(path);
		if (keys == null) {
			return;
		}
		for (String key : keys) {
			TagInfo info = this.tags.get(key);
			if (info != null) {
				info.notes.remove(path);
				if (info.notes.isEmpty()) {
					this.tags.remove(key);
				}
			}
		}
	}

	/** The display forms of a note's tags, sorted case-insensitively. */
	public List<String> tagsOf(String path) {
		Set<String> keys = this.noteTags.get(path);
		if (keys == null) {
			return List.of();
		}
		List<String> shown = new ArrayList<>(keys.size());
		for (String key : keys) {
			TagInfo info = this.tags.get(key);
			if (info != null) {
				shown.add(info.display);
			}
		}
		shown.sort(String.CASE_INSENSITIVE_ORDER.thenComparing(Comparator.naturalOrder()));
		return shown;
	}

	/** Notes tagged {@code tag} (any casing) or, with {@code nested}, any {@code tag/...} descendant. */
	public Set<String> notesWithTag(String tag, boolean nested) {
		String key = PathNames.lower(tag);
		Set<String> notes = new HashSet<>();
		for (Map.Entry<String, TagInfo> entry : this.tags.entrySet()) {
			if (entry.getKey().equals(key) || (nested && entry.getKey().startsWith(key + "/"))) {
				notes.addAll(entry.getValue().notes);
			}
		}
		return notes;
	}

	/**
	 * Every tag plus every implied parent, sorted case-insensitively. Parents are cut from the display form and
	 * lower-cased on their own: lower-casing can change a string's length ({@code İ} becomes two chars), so offsets in
	 * a key never apply to its display form.
	 */
	public List<TagStat> stats() {
		Map<String, String> display = new LinkedHashMap<>();
		Map<String, Set<String>> totals = new HashMap<>();
		for (Map.Entry<String, TagInfo> entry : this.tags.entrySet()) {
			display.put(entry.getKey(), entry.getValue().display);
		}
		for (Map.Entry<String, TagInfo> entry : this.tags.entrySet()) {
			String shown = entry.getValue().display;
			int slash = -1;
			while (true) {
				slash = shown.indexOf('/', slash + 1);
				String prefix = (slash < 0) ? shown : shown.substring(0, slash);
				String key = (slash < 0) ? entry.getKey() : PathNames.lower(prefix);
				display.putIfAbsent(key, prefix);
				totals.computeIfAbsent(key, (k) -> new HashSet<>()).addAll(entry.getValue().notes);
				if (slash < 0) {
					break;
				}
			}
		}
		List<TagStat> stats = new ArrayList<>(display.size());
		for (Map.Entry<String, String> entry : display.entrySet()) {
			TagInfo info = this.tags.get(entry.getKey());
			stats.add(new TagStat(entry.getValue(), (info != null) ? info.notes.size() : 0,
					totals.getOrDefault(entry.getKey(), Set.of()).size()));
		}
		stats.sort(Comparator.comparing(TagStat::tag, String.CASE_INSENSITIVE_ORDER).thenComparing(TagStat::tag));
		return stats;
	}

	public void clear() {
		this.tags.clear();
		this.noteTags.clear();
	}

}
