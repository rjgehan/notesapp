package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** The views of {@code GET /api/tasks}. */
public enum TaskView {

	@JsonProperty("today") TODAY,
	@JsonProperty("upcoming") UPCOMING,
	@JsonProperty("list") LIST,
	@JsonProperty("completed") COMPLETED,
	@JsonProperty("search") SEARCH

}
