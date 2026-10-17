package com.rjgehan.notes.api.dto;

import java.util.Locale;

import com.fasterxml.jackson.annotation.JsonProperty;

/** What a recurring task's next occurrence counts from: its due date or the day it was completed. */
public enum RecurrenceFrom {

	@JsonProperty("due") DUE,
	@JsonProperty("completion") COMPLETION;

	/** The wire name. */
	public String wireName() {
		return name().toLowerCase(Locale.ROOT);
	}

}
