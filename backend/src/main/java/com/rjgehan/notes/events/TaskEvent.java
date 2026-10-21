package com.rjgehan.notes.events;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.rjgehan.notes.api.dto.Task;
import org.jspecify.annotations.Nullable;

/** {@code task.created} or {@code task.changed}, with the complete task. */
public record TaskEvent(@JsonIgnore Change change, Task task, @Nullable String origin) implements VaultEvent {

	public enum Change {

		CREATED, CHANGED

	}

	public static TaskEvent created(Task task, @Nullable String origin) {
		return new TaskEvent(Change.CREATED, task, origin);
	}

	public static TaskEvent changed(Task task, @Nullable String origin) {
		return new TaskEvent(Change.CHANGED, task, origin);
	}

	@Override
	public String eventName() {
		return (this.change == Change.CREATED) ? "task.created" : "task.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
