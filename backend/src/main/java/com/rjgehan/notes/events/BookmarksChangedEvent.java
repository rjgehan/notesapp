package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/**
 * The bookmarks were saved ({@code bookmarks.changed}). {@code origin} is the client whose {@code PUT} saved them, or
 * null when the server re-keyed them after a move or a trash restore: those reach every client, including the one
 * whose move caused them, because its move response does not carry the bookmarks.
 */
public record BookmarksChangedEvent(String version, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "bookmarks.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
