package com.rjgehan.notes.settings;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code settings.files.newLinkFormat} (API.md §15.3). */
public enum LinkFormat {

	@JsonProperty("shortest") SHORTEST,
	@JsonProperty("relative") RELATIVE,
	@JsonProperty("absolute") ABSOLUTE

}
