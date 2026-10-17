package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code StatusResponse.watcher.mode}. */
public enum WatcherMode {

	/** File-system events are watched; rescans run as a safety net. */
	@JsonProperty("inotify") INOTIFY,

	/** The watcher failed; external changes are found by the periodic rescan only. */
	@JsonProperty("polling") POLLING,

	/** Turned off by configuration (the dev profile). */
	@JsonProperty("disabled") DISABLED

}
