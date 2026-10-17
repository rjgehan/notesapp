package com.rjgehan.notes.events;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.rjgehan.notes.api.dto.FileEntry;
import org.jspecify.annotations.Nullable;

/** {@code file.created} or {@code file.changed}, with the complete entry. */
public record FileEvent(@JsonIgnore Change change, FileEntry file, @Nullable String origin) implements VaultEvent {

	public enum Change {

		CREATED, CHANGED

	}

	public static FileEvent created(FileEntry file, @Nullable String origin) {
		return new FileEvent(Change.CREATED, file, origin);
	}

	public static FileEvent changed(FileEntry file, @Nullable String origin) {
		return new FileEvent(Change.CHANGED, file, origin);
	}

	@Override
	public String eventName() {
		return (this.change == Change.CREATED) ? "file.created" : "file.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
