package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.jspecify.annotations.Nullable;

/** An Obsidian plugin the vault has enabled, and what NotesApp offers instead. */
public record CompatPlugin(String id, String name, Kind kind, Support status, String note,
		@Nullable Integer roadmapItem) {

	public enum Kind {

		@JsonProperty("core") CORE,
		@JsonProperty("community") COMMUNITY

	}

	/**
	 * {@code supported}: NotesApp does the same; {@code partial}: some of it; {@code planned}: a roadmap item will;
	 * {@code unsupported}: not offered; {@code unknown}: a plugin NotesApp knows nothing about.
	 */
	public enum Support {

		@JsonProperty("supported") SUPPORTED,
		@JsonProperty("partial") PARTIAL,
		@JsonProperty("planned") PLANNED,
		@JsonProperty("unsupported") UNSUPPORTED,
		@JsonProperty("unknown") UNKNOWN

	}

}
