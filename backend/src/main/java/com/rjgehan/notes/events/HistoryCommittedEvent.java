package com.rjgehan.notes.events;

import java.time.Instant;
import java.util.List;

/** A commit was made; {@code paths} holds at most 100 entries and {@code truncated} says whether there were more. */
public record HistoryCommittedEvent(String commitId, String message, String authorName, Instant time,
		List<String> paths, boolean truncated) implements VaultEvent {

	public static final int MAX_PATHS = 100;

	@Override
	public String eventName() {
		return "history.committed";
	}

}
