package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * {@code PATCH /api/tasks/{id}} and {@code PATCH /api/tasks/lists/{id}}: {@code changes} are the fields to set and
 * {@code base} the values the client last saw for them. Both stay JSON trees, because an omitted field (unchanged)
 * and {@code null} (cleared) differ.
 */
public record UpdateTaskRequest(@Nullable JsonNode changes, @Nullable JsonNode base) {
}
