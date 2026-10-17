package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * {@code POST /api/tasks/{id}/complete}: the client's time zone or date (the completion day, for recurrence), and the
 * {@code due} and {@code start} it saw, so a retried or repeated completion never rolls a recurring task twice.
 */
public record CompleteTaskRequest(@Nullable String tz, @Nullable String date, @Nullable JsonNode base) {
}
