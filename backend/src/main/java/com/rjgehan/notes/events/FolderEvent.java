package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** {@code folder.created}. */
public record FolderEvent(String path, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "folder.created";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
