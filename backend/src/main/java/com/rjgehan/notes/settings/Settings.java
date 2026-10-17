package com.rjgehan.notes.settings;

import java.util.List;

/**
 * The vault settings stored in {@code .notesapp/settings.json} (API.md §5, DESIGN §5.12). Per-device preferences
 * such as the theme are not vault settings; the client keeps them in {@code localStorage}.
 */
public record Settings(int schemaVersion, FilesSettings files, DailyNotesSettings dailyNotes,
		TemplatesSettings templates, EditorSettings editor) {

	/** The schema version this build reads and writes. */
	public static final int SCHEMA_VERSION = 1;

	public static Settings defaults() {
		return new Settings(SCHEMA_VERSION,
				new FilesSettings(NewNoteLocation.ROOT, "", LinkFormat.SHORTEST, true, AttachmentLocation.FOLDER,
						"Attachments", "attachments", true, List.of()),
				new DailyNotesSettings("YYYY-MM-DD", "Daily", "", false),
				new TemplatesSettings("Templates", "YYYY-MM-DD", "HH:mm"),
				new EditorSettings(EditorMode.EDIT, true, false));
	}

}
