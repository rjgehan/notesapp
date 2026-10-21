package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * One task (API.md §20). {@code due} and {@code start} are local dates ({@code YYYY-MM-DD}) or local date-times
 * ({@code YYYY-MM-DDTHH:mm}); {@code archived} is true for a closed task that was rolled into an archive file.
 */
public record Task(String id, String listId, @Nullable String sectionId, @Nullable String parentId, String title,
		@Nullable String notes, TaskStatus status, int priority, @Nullable String due, @Nullable String start,
		@Nullable TaskRecurrence recurrence, List<TaskReminder> reminders, List<String> tags, List<String> links,
		String order, @Nullable Instant createdAt, @Nullable Instant updatedAt, @Nullable Instant completedAt,
		boolean archived) {
}
