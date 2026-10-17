package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** A folder and everything under it disappeared. */
public record FolderDeletedEvent(String path, boolean trashed, @Nullable String trashId, @Nullable String origin)
		implements VaultEvent {

	@Override
	public String eventName() {
		return "folder.deleted";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
