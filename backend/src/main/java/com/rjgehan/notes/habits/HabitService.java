package com.rjgehan.notes.habits;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.rjgehan.notes.api.dto.DailyNoteValues;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.HabitNote;
import com.rjgehan.notes.api.dto.HabitsResponse;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.Frontmatter;
import com.rjgehan.notes.index.NoteRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * Habits (ROADMAP item 35, API.md §35). A habit is a note in the {@code Habits} folder, or anywhere with the tag
 * {@code #habit}; its frontmatter holds its check-ins ({@code entries}, as Obsidian's Habit Tracker 21 plugin keeps
 * them) and its schedule. A daily note checks a habit in with a frontmatter property ({@code exercise: true}). This
 * service reads both from the index, so the habits page needs one request whatever the number of daily notes.
 */
@Service
public class HabitService {

	public static final String FOLDER = "Habits";

	public static final String TAG = "habit";

	/** Longer strings are not check-in values, and would only make the answer larger. */
	static final int MAX_VALUE_LENGTH = 100;

	static final int MAX_KEY_LENGTH = 64;

	private final VaultIndex index;

	private final SettingsService settings;

	public HabitService(VaultIndex index, SettingsService settings) {
		this.index = index;
		this.settings = settings;
	}

	/** {@code GET /api/habits}. */
	public HabitsResponse habits() {
		Settings current = this.settings.current();
		String templates = current.templates().folder();
		String folder = this.index.folderIgnoreCase(FOLDER);
		Set<String> paths = new TreeSet<>(this.index.notesWithTag(TAG, true));
		if (folder != null && !folder.isEmpty()) {
			for (FileRecord record : this.index.filesUnder(folder)) {
				if (record.kind() == FileKind.NOTE) {
					paths.add(record.path());
				}
			}
		}
		List<HabitNote> habits = new ArrayList<>();
		for (String path : paths) {
			// A habit template is not a habit; drawings are notes another view shows.
			if (within(path, templates) || !path.endsWith(".md") || path.endsWith(".excalidraw.md")) {
				continue;
			}
			NoteRecord note = this.index.note(path);
			if (note != null) {
				habits.add(new HabitNote(path, note.version(), properties(note)));
			}
		}
		Set<String> habitPaths = new TreeSet<>();
		habits.forEach((h) -> habitPaths.add(h.path()));
		String configured = current.dailyNotes().folder();
		String found = this.index.folderIgnoreCase(configured);
		String dailyFolder = (found != null) ? found : configured;
		List<DailyNoteValues> daily = new ArrayList<>();
		for (FileRecord record : this.index.filesUnder(dailyFolder)) {
			if (record.kind() != FileKind.NOTE || habitPaths.contains(record.path())) {
				continue;
			}
			NoteRecord note = this.index.note(record.path());
			Map<String, Object> values = (note != null) ? simpleValues(note) : Map.of();
			if (!values.isEmpty()) {
				daily.add(new DailyNoteValues(record.path(), values));
			}
		}
		return new HabitsResponse((folder != null && !folder.isEmpty()) ? folder : FOLDER, TAG, habits, dailyFolder,
				daily);
	}

	private static boolean within(String path, String folder) {
		return !folder.isEmpty() && PathNames.lower(path).startsWith(PathNames.lower(folder) + "/");
	}

	private static Map<String, @Nullable Object> properties(NoteRecord note) {
		Frontmatter frontmatter = note.parse().frontmatter();
		Map<String, @Nullable Object> data = (frontmatter != null) ? frontmatter.data() : null;
		return (data != null) ? new LinkedHashMap<>(data) : Map.of();
	}

	/** Booleans, numbers and short strings: what a daily note can check a habit in with. */
	static Map<String, Object> simpleValues(NoteRecord note) {
		Frontmatter frontmatter = note.parse().frontmatter();
		Map<String, @Nullable Object> data = (frontmatter != null) ? frontmatter.data() : null;
		if (data == null) {
			return Map.of();
		}
		Map<String, Object> values = new LinkedHashMap<>();
		for (Map.Entry<String, @Nullable Object> entry : data.entrySet()) {
			Object value = entry.getValue();
			if (entry.getKey().length() > MAX_KEY_LENGTH) {
				continue;
			}
			if (value instanceof Boolean || value instanceof Number
					|| (value instanceof String text && text.length() <= MAX_VALUE_LENGTH)) {
				values.put(entry.getKey(), value);
			}
		}
		return values;
	}

}
