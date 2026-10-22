package com.rjgehan.notes.index;

import java.text.Normalizer;
import java.util.Collection;
import java.util.Locale;
import java.util.Map;

import org.jspecify.annotations.Nullable;

/**
 * A property clause of a search (ROADMAP item 13, API.md §12.1), Obsidian's syntax:
 *
 * <ul>
 * <li>{@code [status]}: the note has the property (names compare case-insensitively);</li>
 * <li>{@code [status:done]}: a value of the property (the value, or an item of a list) contains {@code done},
 * case-insensitively;</li>
 * <li>{@code [status:"done"]}: a value is exactly {@code done} (case-insensitively);</li>
 * <li>{@code [status:]}: the property is there but empty.</li>
 * </ul>
 *
 * Numbers and booleans compare as they read in YAML ({@code [done:true]}, {@code [rating:4]}).
 */
public record PropertyClause(String name, @Nullable String value, boolean exact) {

	/** The clause written between the brackets; null when it names no property. */
	public static @Nullable PropertyClause parse(String inside) {
		int colon = inside.indexOf(':');
		String name = ((colon < 0) ? inside : inside.substring(0, colon)).strip();
		if (name.isEmpty()) {
			return null;
		}
		if (colon < 0) {
			return new PropertyClause(name, null, false);
		}
		String value = inside.substring(colon + 1).strip();
		boolean exact = value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"");
		if (exact) {
			value = value.substring(1, value.length() - 1);
		}
		return new PropertyClause(name, value, exact);
	}

	/** Whether a note's frontmatter matches. */
	public boolean matches(@Nullable Map<String, @Nullable Object> data) {
		if (data == null) {
			return false;
		}
		String wantedName = fold(this.name);
		for (Map.Entry<String, @Nullable Object> entry : data.entrySet()) {
			if (fold(entry.getKey()).equals(wantedName) && matchesValue(entry.getValue())) {
				return true;
			}
		}
		return false;
	}

	private boolean matchesValue(@Nullable Object value) {
		if (this.value == null) {
			return true;
		}
		if (this.value.isEmpty() && !this.exact) {
			return value == null || "".equals(value) || (value instanceof Collection<?> c && c.isEmpty());
		}
		if (value instanceof Collection<?> items) {
			for (Object item : items) {
				if (matchesScalar(item)) {
					return true;
				}
			}
			return false;
		}
		return matchesScalar(value);
	}

	private boolean matchesScalar(@Nullable Object value) {
		if (value == null || value instanceof Map<?, ?> || value instanceof Collection<?>) {
			return false;
		}
		String text = fold(String.valueOf(value));
		String wanted = fold(this.value);
		if (this.exact || !(value instanceof String)) {
			return text.equals(wanted);
		}
		return text.contains(wanted);
	}

	private static String fold(String s) {
		return Normalizer.normalize(s, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
	}

}
