package com.rjgehan.notes.api.dto;

import java.util.Locale;

import com.fasterxml.jackson.annotation.JsonProperty;

/** File kinds of DESIGN §4.2, derived from the lower-cased final extension. */
public enum FileKind {

	@JsonProperty("note") NOTE,
	@JsonProperty("text") TEXT,
	@JsonProperty("image") IMAGE,
	@JsonProperty("audio") AUDIO,
	@JsonProperty("video") VIDEO,
	@JsonProperty("pdf") PDF,
	@JsonProperty("other") OTHER;

	/** Only notes and text files have versions and can be read and saved through the text API. */
	public boolean isText() {
		return this == NOTE || this == TEXT;
	}

	/** The wire name. */
	public String wireName() {
		return name().toLowerCase(Locale.ROOT);
	}

}
