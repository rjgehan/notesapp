package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * {@code PUT /api/bookmarks}. {@code items} is kept as a JSON tree, so every invalid field is reported by name in
 * {@code errors[]} and unknown fields are kept.
 */
public record BookmarksUpdateRequest(@Nullable JsonNode items, @Nullable String baseVersion) {
}
