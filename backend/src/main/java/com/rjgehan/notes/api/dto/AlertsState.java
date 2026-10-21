package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code AlertsStatus.state} (API.md §6.5). */
public enum AlertsState {

	/** No {@code ntfy.json}, or alerts are switched off in it; {@code reason} says which. */
	@JsonProperty("off") OFF,

	/** Alerts are sent to ntfy. */
	@JsonProperty("on") ON,

	/** {@code ntfy.json} exists but cannot be used; {@code reason} says why. */
	@JsonProperty("error") ERROR

}
