package com.rjgehan.notes.events;

import com.fasterxml.jackson.annotation.JsonProperty;

/** The server could not describe a change precisely; clients refetch everything. */
public record ResyncEvent(Reason reason) implements VaultEvent {

	public enum Reason {

		@JsonProperty("watcher-overflow") WATCHER_OVERFLOW,
		@JsonProperty("bulk-change") BULK_CHANGE,
		@JsonProperty("rescan-error") RESCAN_ERROR

	}

	@Override
	public String eventName() {
		return "resync";
	}

}
