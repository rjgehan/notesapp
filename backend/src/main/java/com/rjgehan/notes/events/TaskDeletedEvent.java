package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** {@code task.deleted}: a task was removed through the task API (a deleted parent also removes its subtasks). */
public record TaskDeletedEvent(String id, String listId, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "task.deleted";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
