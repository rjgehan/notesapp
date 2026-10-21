package com.rjgehan.notes.events;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Something shown by {@code GET /api/status} changed state; clients refetch it. */
public record StatusChangedEvent(Reason reason) implements VaultEvent {

	public enum Reason {

		@JsonProperty("git") GIT,
		@JsonProperty("watcher") WATCHER,
		@JsonProperty("settings") SETTINGS,
		@JsonProperty("disk") DISK,
		@JsonProperty("mirror") MIRROR

	}

	@Override
	public String eventName() {
		return "status.changed";
	}

}
