package com.rjgehan.notes.api.dto;

import java.util.Locale;

import com.fasterxml.jackson.annotation.JsonProperty;

/** A task's state (API.md §20). Done and cancelled tasks are both closed and carry {@code completedAt}. */
public enum TaskStatus {

	@JsonProperty("open") OPEN,
	@JsonProperty("done") DONE,
	@JsonProperty("cancelled") CANCELLED;

	/** The wire name. */
	public String wireName() {
		return name().toLowerCase(Locale.ROOT);
	}

	public boolean isClosed() {
		return this != OPEN;
	}

}
