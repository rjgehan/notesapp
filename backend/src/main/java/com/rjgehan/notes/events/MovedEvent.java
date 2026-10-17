package com.rjgehan.notes.events;

import com.rjgehan.notes.api.dto.EntryType;
import org.jspecify.annotations.Nullable;

/** A file or folder moved through the app; for a folder, every descendant is re-keyed by prefix. */
public record MovedEvent(String from, String to, EntryType type, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "entry.moved";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
