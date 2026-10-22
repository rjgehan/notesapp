package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** The vault's property types changed (API.md §38.2). */
public record PropertyTypesChangedEvent(String version, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "types.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
