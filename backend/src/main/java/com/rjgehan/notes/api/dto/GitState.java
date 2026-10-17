package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code StatusResponse.git.state}. */
public enum GitState {

	/** History works. */
	@JsonProperty("ready") READY,

	/** The startup commit is running after readiness. */
	@JsonProperty("importing") IMPORTING,

	/** Commits fail and are being retried. */
	@JsonProperty("failing") FAILING,

	/** History is off ({@code enabled} is false). */
	@JsonProperty("disabled") DISABLED

}
