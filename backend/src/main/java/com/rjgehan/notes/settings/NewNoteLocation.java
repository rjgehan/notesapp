package com.rjgehan.notes.settings;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code settings.files.newNoteLocation}: where links-to-create and new notes go (API.md §5). */
public enum NewNoteLocation {

	@JsonProperty("root") ROOT,
	@JsonProperty("current") CURRENT,
	@JsonProperty("folder") FOLDER

}
