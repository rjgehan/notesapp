package com.rjgehan.notes.events;

import java.time.Instant;

/** The heartbeat: sent without an {@code id:} line and never replayed. */
public record PingEvent(Instant serverTime) implements VaultEvent {

	@Override
	public String eventName() {
		return "ping";
	}

}
