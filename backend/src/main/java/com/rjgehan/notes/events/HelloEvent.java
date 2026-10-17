package com.rjgehan.notes.events;

import java.time.Instant;

/** Always the first event of a connection; written by {@link EventHub} directly and never stored for replay. */
public record HelloEvent(String bootId, String eventId, boolean resync, int replayed, String buildSha,
		Instant serverTime) implements VaultEvent {

	@Override
	public String eventName() {
		return "hello";
	}

}
