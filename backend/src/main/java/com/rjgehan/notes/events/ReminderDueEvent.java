package com.rjgehan.notes.events;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

/**
 * {@code reminder.due}: the in-app reminder route (ROADMAP item 9, API.md §25.5). Every open tab shows it as a toast
 * and, with permission, a browser notification; {@code key} identifies the reminder, so tabs and replays show it once.
 * {@code kind} is {@code task}, {@code daily} or {@code test}.
 */
public record ReminderDueEvent(String key, String kind, @Nullable String taskId, @Nullable String at, String title,
		String body, String url, Instant sentAt) implements VaultEvent {

	@Override
	public String eventName() {
		return "reminder.due";
	}

}
