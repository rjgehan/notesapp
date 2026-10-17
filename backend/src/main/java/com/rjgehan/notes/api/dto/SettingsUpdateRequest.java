package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * {@code PUT /api/settings}. {@code settings} is kept as a JSON tree so every missing or invalid field is reported
 * by name in {@code errors[]}, exactly as the file on disk is validated.
 */
public record SettingsUpdateRequest(@Nullable JsonNode settings, @Nullable String baseVersion) {
}
