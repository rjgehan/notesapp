package com.rjgehan.notes.settings;

import java.util.List;

/**
 * {@code settings.templates}. {@code folderTemplates} (ROADMAP item 30) are applied by the client when it creates a
 * note; a file without the field reads as an empty list.
 */
public record TemplatesSettings(String folder, String dateFormat, String timeFormat,
		List<FolderTemplate> folderTemplates) {

	public TemplatesSettings {
		folderTemplates = List.copyOf(folderTemplates);
	}

	public TemplatesSettings(String folder, String dateFormat, String timeFormat) {
		this(folder, dateFormat, timeFormat, List.of());
	}

	/** New notes in {@code folder} ({@code ""}: every folder) start from {@code template} ({@code ""}: unused). */
	public record FolderTemplate(String folder, String template) {
	}

}
