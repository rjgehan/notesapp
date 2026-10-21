package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code AiStatus.state} (API.md §24.4). */
public enum AiState {

	/** Switched off in Settings (the default). */
	@JsonProperty("off") OFF,

	/** On in Settings, but the server has no usable API key; {@code reason} says why. */
	@JsonProperty("not-configured") NOT_CONFIGURED,

	/** This month's estimated spend reached the budget in Settings. */
	@JsonProperty("over-budget") OVER_BUDGET,

	/** Requests are accepted. */
	@JsonProperty("ready") READY

}
