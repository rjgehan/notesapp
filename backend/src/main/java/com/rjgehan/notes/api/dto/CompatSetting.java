package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.jspecify.annotations.Nullable;

/**
 * One Obsidian setting and its NotesApp counterpart. {@code source} is {@code file › key}; {@code setting} the
 * NotesApp setting (null when there is none), with its {@code current} and {@code proposed} values as shown to the
 * user.
 */
public record CompatSetting(String source, String obsidianValue, @Nullable String setting, @Nullable String current,
		@Nullable String proposed, Status status, @Nullable String note) {

	/** {@code same}: already in effect; {@code different}: applying changes it; {@code unsupported}: no counterpart. */
	public enum Status {

		@JsonProperty("same") SAME,
		@JsonProperty("different") DIFFERENT,
		@JsonProperty("unsupported") UNSUPPORTED

	}

}
