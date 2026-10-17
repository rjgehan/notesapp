package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** {@code trashed} is false for external deletes; {@code trashId} is set when the file went to the trash. */
public record FileDeletedEvent(String path, boolean trashed, @Nullable String trashId, @Nullable String origin)
		implements VaultEvent {

	@Override
	public String eventName() {
		return "file.deleted";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
