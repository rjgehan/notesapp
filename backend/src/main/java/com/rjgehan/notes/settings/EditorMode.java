package com.rjgehan.notes.settings;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code settings.editor.defaultMode}. */
public enum EditorMode {

	@JsonProperty("edit") EDIT,
	@JsonProperty("read") READ

}
