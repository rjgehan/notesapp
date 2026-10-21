package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** The saved searches were saved (API.md §12.3). */
public record SavedSearchesChangedEvent(String version, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "searches.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
