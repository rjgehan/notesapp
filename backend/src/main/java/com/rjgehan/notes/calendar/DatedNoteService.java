package com.rjgehan.notes.calendar;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.DatedNote;
import com.rjgehan.notes.api.dto.DatedNotesResponse;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.Frontmatter;
import com.rjgehan.notes.index.NoteRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * Notes dated by a frontmatter property (ROADMAP item 14, API.md §25): {@code date: 2026-10-21} (Obsidian's Date
 * property), a date-time ({@code 2026-10-21T09:30}, Obsidian's Date and time), a link to a day
 * ({@code "[[2026-10-21]]"}), or a list of them. Read from the index's parsed frontmatter, so the calendar needs one
 * request for a month whatever the size of the vault.
 */
@Service
public class DatedNoteService {

	public static final String DEFAULT_PROPERTY = "date";

	/** A year and a day at most: a bound on the answer. */
	static final int MAX_DAYS = 366;

	static final int MAX_PROPERTIES = 5;

	static final int MAX_PROPERTY_LENGTH = 64;

	/** A list property holds a handful of dates; a longer list is not read. */
	static final int MAX_LIST = 50;

	private static final Pattern DAY = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");

	private static final Pattern VALUE = Pattern
		.compile("(\\d{4}-\\d{2}-\\d{2})(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?");

	private final VaultIndex index;

	private final SettingsService settings;

	public DatedNoteService(VaultIndex index, SettingsService settings) {
		this.index = index;
		this.settings = settings;
	}

	/** {@code GET /api/notes/by-date?from&to&property}. */
	public DatedNotesResponse byDate(@Nullable String from, @Nullable String to, @Nullable String property) {
		LocalDate first = day("from", from);
		LocalDate last = day("to", to);
		if (last.isBefore(first)) {
			throw NotesException.badRequest("to must not be before from");
		}
		if (ChronoUnit.DAYS.between(first, last) >= MAX_DAYS) {
			throw NotesException.badRequest("the range must be at most " + MAX_DAYS + " days");
		}
		List<String> properties = properties(property);
		Set<String> wanted = new HashSet<>();
		properties.forEach((p) -> wanted.add(p.toLowerCase(Locale.ROOT)));
		String low = first.toString();
		String high = last.toString();
		String templates = this.settings.current().templates().folder();
		List<DatedNote> found = new ArrayList<>();
		for (NoteRecord note : this.index.notes()) {
			String path = note.path();
			// A template's date is a placeholder; drawings are notes another view shows.
			if (!path.endsWith(".md") || path.endsWith(".excalidraw.md") || within(path, templates)) {
				continue;
			}
			Frontmatter frontmatter = note.parse().frontmatter();
			Map<String, @Nullable Object> data = (frontmatter != null) ? frontmatter.data() : null;
			if (data == null) {
				continue;
			}
			Set<String> days = new HashSet<>();
			for (Map.Entry<String, @Nullable Object> entry : data.entrySet()) {
				if (!wanted.contains(entry.getKey().toLowerCase(Locale.ROOT))) {
					continue;
				}
				for (String value : values(entry.getValue())) {
					String day = dayOf(value);
					if (day != null && day.compareTo(low) >= 0 && day.compareTo(high) <= 0 && days.add(day)) {
						found.add(new DatedNote(path, day, entry.getKey(), value.strip()));
					}
				}
			}
		}
		found.sort(Comparator.comparing(DatedNote::day).thenComparing(DatedNote::path));
		return new DatedNotesResponse(low, high, properties, found);
	}

	private static LocalDate day(String name, @Nullable String value) {
		if (value == null || !DAY.matcher(value).matches()) {
			throw NotesException.badRequest(name + " must be YYYY-MM-DD");
		}
		try {
			return LocalDate.parse(value);
		}
		catch (DateTimeParseException ex) {
			throw NotesException.badRequest(name + " must be YYYY-MM-DD");
		}
	}

	/** The comma-separated property names, {@code date} when none; repeats (ignoring case) dropped. */
	static List<String> properties(@Nullable String property) {
		if (property == null || property.isBlank()) {
			return List.of(DEFAULT_PROPERTY);
		}
		Set<String> seen = new HashSet<>();
		Set<String> names = new LinkedHashSet<>();
		for (String part : property.split(",")) {
			String name = part.strip();
			if (name.isEmpty()) {
				continue;
			}
			if (name.length() > MAX_PROPERTY_LENGTH) {
				throw NotesException
					.badRequest("property names must be at most " + MAX_PROPERTY_LENGTH + " characters");
			}
			if (seen.add(name.toLowerCase(Locale.ROOT))) {
				names.add(name);
			}
		}
		if (names.isEmpty()) {
			return List.of(DEFAULT_PROPERTY);
		}
		if (names.size() > MAX_PROPERTIES) {
			throw NotesException.badRequest("at most " + MAX_PROPERTIES + " properties");
		}
		return List.copyOf(names);
	}

	private static List<String> values(@Nullable Object value) {
		if (value instanceof String text) {
			return List.of(text);
		}
		if (value instanceof List<?> list && list.size() <= MAX_LIST) {
			List<String> out = new ArrayList<>();
			for (Object item : list) {
				if (item instanceof String text) {
					out.add(text);
				}
			}
			return out;
		}
		return List.of();
	}

	/** The day a property value names, or null: a date, a date-time, or a link to either. */
	static @Nullable String dayOf(String value) {
		String text = value.strip();
		if (text.startsWith("[[") && text.endsWith("]]")) {
			text = text.substring(2, text.length() - 2).strip();
			int alias = text.indexOf('|');
			if (alias >= 0) {
				text = text.substring(0, alias).strip();
			}
		}
		Matcher matcher = VALUE.matcher(text);
		if (!matcher.matches()) {
			return null;
		}
		try {
			return LocalDate.parse(matcher.group(1)).toString();
		}
		catch (DateTimeParseException ex) {
			return null;
		}
	}

	private static boolean within(String path, String folder) {
		return !folder.isEmpty() && PathNames.lower(path).startsWith(PathNames.lower(folder) + "/");
	}

}
