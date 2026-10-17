package com.rjgehan.notes.events;

import com.rjgehan.notes.api.dto.TaskList;
import org.jspecify.annotations.Nullable;

/**
 * {@code list.changed}: a task list was created, changed or deleted ({@code list} null), or many of its tasks changed
 * at once (the archive rollover); clients refetch the task views that show it.
 */
public record ListChangedEvent(String listId, @Nullable TaskList list, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "list.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
