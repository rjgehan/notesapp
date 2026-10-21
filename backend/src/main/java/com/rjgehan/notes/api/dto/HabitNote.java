package com.rjgehan.notes.api.dto;

import java.util.Map;

import org.jspecify.annotations.Nullable;

/** A habit note and its frontmatter properties (API.md §35.1). */
public record HabitNote(String path, String version, Map<String, @Nullable Object> properties) {
}
