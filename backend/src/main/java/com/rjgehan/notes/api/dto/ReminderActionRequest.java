package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/reminders/snooze} and {@code POST /api/reminders/done} (API.md §25.4): the task and the reminder
 * ({@code at}, its local date-time) the notification was for; {@code minutes} only for a snooze (10 by default).
 */
public record ReminderActionRequest(@Nullable String taskId, @Nullable String at, @Nullable Integer minutes) {
}
