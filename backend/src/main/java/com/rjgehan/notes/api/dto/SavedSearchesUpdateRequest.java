package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * {@code PUT /api/searches}: the whole list, replacing the stored one. {@code searches} is kept as a JSON tree so
 * every invalid field is reported by name in {@code errors[]}; {@code baseVersion} is null to create the file.
 */
public record SavedSearchesUpdateRequest(@Nullable JsonNode searches, @Nullable String baseVersion) {
}
